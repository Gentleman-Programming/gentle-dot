import { expect, it } from "vitest";
import { type Activity, type HistoryMessage, PROTOCOL_VERSION, type ServerPayload } from "../src/index.ts";

it("keeps original v1 activities, messages and history valid without any rich fields", () => {
	const activity: Activity = { id: "a", kind: "read", title: "Read a file", status: "done" };
	const message: HistoryMessage = { id: "h1", role: "assistant", text: "hello", activities: [activity] };
	const payload: ServerPayload = { type: "message_done", messageId: "m1", text: "hello" };
	expect(PROTOCOL_VERSION).toBe(1);
	expect(JSON.parse(JSON.stringify(message))).toEqual(message);
	expect(payload).not.toHaveProperty("reasoning");
	expect(activity).not.toHaveProperty("detail");
});

it("types rich activity and reasoning as additive v1 payloads", () => {
	const activity: Activity = {
		id: "a",
		kind: "other",
		title: "Finished",
		status: "done",
		tool: "mcp__slack__search",
		source: "slack",
		detail: "query",
		output: "result",
	};
	const payloads: ServerPayload[] = [
		{ type: "reasoning_delta", messageId: "m1", delta: "thinking" },
		{ type: "message_done", messageId: "m1", text: "hello", reasoning: "thought" },
		{
			type: "history",
			messages: [
				{ id: "h1", role: "assistant", text: "hello", reasoning: "thought", activities: [activity] },
			],
		},
	];
	expect(payloads.map((p) => p.type)).toEqual(["reasoning_delta", "message_done", "history"]);
});

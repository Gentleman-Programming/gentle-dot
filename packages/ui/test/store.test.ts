import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import { type DotState, initialState, reduce } from "../src/store.ts";

let seq = 0;
function apply(state: DotState, ...payloads: ServerPayload[]): DotState {
	return payloads.reduce(
		(s, p) => reduce(s, { type: "server", message: { ...p, seq: ++seq } as ServerMessage }),
		state,
	);
}

describe("reduce", () => {
	it("records ready, connection, and agent state", () => {
		let s = reduce(initialState, { type: "connection", status: "open" });
		s = apply(s, { type: "ready", agentState: "idle", conversationId: "a.jsonl", model: "Fake" });
		expect(s).toMatchObject({
			connection: "open",
			agentState: "idle",
			conversationId: "a.jsonl",
			model: "Fake",
		});
		s = apply(s, { type: "agent_state", state: "thinking" });
		expect(s.agentState).toBe("thinking");
	});

	it("streams an assistant message and replaces it with the final text", () => {
		const s = apply(
			initialState,
			{ type: "user_message", messageId: "u1", text: "hi" },
			{ type: "message_delta", messageId: "m2", delta: "Hel" },
			{ type: "message_delta", messageId: "m2", delta: "lo" },
		);
		expect(s.messages.map((m) => [m.role, m.text, m.streaming])).toEqual([
			["user", "hi", false],
			["assistant", "Hello", true],
		]);
		const done = apply(s, { type: "message_done", messageId: "m2", text: "Hello!" });
		expect(done.messages[1]).toMatchObject({ text: "Hello!", streaming: false });
	});

	it("attaches activities to their message and updates them in place", () => {
		const running = { id: "t1", kind: "read" as const, title: "Reading a.md", status: "running" as const };
		let s = apply(initialState, { type: "activity", messageId: "m1", activity: running });
		expect(s.messages[0]).toMatchObject({ role: "assistant", text: "", activities: [running] });
		s = apply(s, { type: "activity", messageId: "m1", activity: { ...running, status: "done" } });
		expect(s.messages[0]?.activities).toEqual([{ ...running, status: "done" }]);
	});

	it("adds and resolves asks", () => {
		const ask = { requestId: "q1", method: "confirm" as const, title: "Proceed?" };
		let s = apply(initialState, { type: "ask", ask }, { type: "ask", ask });
		expect(s.asks).toEqual([ask]);
		s = apply(s, { type: "ask_resolved", requestId: "q1" });
		expect(s.asks).toEqual([]);
	});

	it("replaces messages with history and clears the interruption", () => {
		let s = apply(
			initialState,
			{ type: "user_message", messageId: "u1", text: "old" },
			{ type: "interrupted" },
		);
		expect(s.interrupted).toBe(true);
		s = apply(s, {
			type: "history",
			conversationId: "b.jsonl",
			messages: [{ id: "h1", role: "user", text: "new", activities: [] }],
		});
		expect(s.messages.map((m) => m.text)).toEqual(["new"]);
		expect(s).toMatchObject({ conversationId: "b.jsonl", interrupted: false });
	});

	it("keeps a streaming message when a mid-turn history snapshot arrives", () => {
		// A reconnect during a run refetches history, but the session file only
		// gains the assistant message when it ends, and history ids (h*) never
		// match the live bridge ids (m*), so the snapshot cannot cover the
		// streaming turn. The turn must survive and finish in place.
		let s = apply(
			initialState,
			{ type: "ready", agentState: "working", conversationId: "a.jsonl", model: "Fake" },
			{ type: "user_message", messageId: "u1", text: "hi" },
			{ type: "message_delta", messageId: "m2", delta: "Hel" },
		);
		s = apply(s, {
			type: "history",
			conversationId: "a.jsonl",
			messages: [{ id: "h1", role: "user", text: "hi", activities: [] }],
		});
		expect(s.messages.map((m) => [m.id, m.role, m.text, m.streaming])).toEqual([
			["h1", "user", "hi", false],
			["m2", "assistant", "Hel", true],
		]);
		s = apply(
			s,
			{ type: "message_delta", messageId: "m2", delta: "lo!" },
			{ type: "message_done", messageId: "m2", text: "Hello!" },
		);
		expect(s.messages.map((m) => [m.id, m.text, m.streaming])).toEqual([
			["h1", "hi", false],
			["m2", "Hello!", false],
		]);
	});

	it("replaces streaming messages when the history is for another conversation", () => {
		const s = apply(
			initialState,
			{ type: "ready", agentState: "working", conversationId: "a.jsonl", model: "Fake" },
			{ type: "message_delta", messageId: "m2", delta: "Hel" },
		);
		const switched = apply(s, {
			type: "history",
			conversationId: "b.jsonl",
			messages: [{ id: "h1", role: "user", text: "other", activities: [] }],
		});
		expect(switched.messages.map((m) => m.id)).toEqual(["h1"]);
	});

	it("clears the interruption when a new user message arrives", () => {
		const s = apply(
			initialState,
			{ type: "interrupted" },
			{ type: "user_message", messageId: "u1", text: "go" },
		);
		expect(s.interrupted).toBe(false);
	});

	it("keeps conversations and the active id", () => {
		const s = apply(initialState, {
			type: "conversations",
			conversations: [{ id: "a.jsonl", title: "A", updatedAt: "2026-10-08T00:00:00.000Z" }],
			activeId: "a.jsonl",
		});
		expect(s.conversations).toHaveLength(1);
		expect(s.conversationId).toBe("a.jsonl");
	});

	it("queues toasts and errors, and dismisses them by id", () => {
		let s = apply(
			initialState,
			{ type: "toast", level: "warning", message: "Careful" },
			{ type: "error", code: "x", message: "Nope" },
		);
		expect(s.notices.map((n) => [n.level, n.message])).toEqual([
			["warning", "Careful"],
			["error", "Nope"],
		]);
		s = reduce(s, { type: "dismiss", id: s.notices[0]?.id ?? -1 });
		expect(s.notices.map((n) => n.message)).toEqual(["Nope"]);
	});

	it("stops streaming when the connection drops", () => {
		const s = reduce(apply(initialState, { type: "agent_state", state: "thinking" }), {
			type: "connection",
			status: "closed",
		});
		expect(s.connection).toBe("closed");
		expect(s.messages.every((m) => !m.streaming)).toBe(true);
	});
});

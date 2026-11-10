import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { expect, it } from "vitest";
import WebSocket from "ws";
import { startDaemon } from "../src/daemon.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

it.each([false, true])("gates WebSocket reasoning on hello capability: %s", async (reasoning) => {
	const dataDir = mkdtempSync(join(tmpdir(), "gentle-dot-rich-"));
	const daemon = await startDaemon({
		host: "127.0.0.1",
		port: 0,
		dataDir,
		workspace: dataDir,
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		historyPage: 2,
	});
	const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
	try {
		const received: ServerMessage[] = [];
		ws.on("message", (data) => received.push(JSON.parse(String(data)) as ServerMessage));
		await new Promise<void>((resolve, reject) => {
			ws.on("open", resolve);
			ws.on("error", reject);
		});
		ws.send(
			JSON.stringify({
				type: "hello",
				protocol: 1,
				token: daemon.token,
				...(reasoning ? { capabilities: ["reasoning"] } : {}),
			}),
		);
		await waitFor(() => received.some((p) => p.type === "ready"));
		ws.send(JSON.stringify({ type: "send", text: `rich:${daemon.token}` }));
		const done = await waitFor(() => received.find((p) => p.type === "message_done"));
		expect(done).toMatchObject({
			type: "message_done",
			text: "Gentle Dot says:\n```ts\n    const name = 'Engram';\n      // ODD\n```",
		});
		if (reasoning) {
			expect(done.reasoning).toBe("memory follows workflow");
			expect(received.find((p) => p.type === "reasoning_delta")).toMatchObject({
				messageId: done.messageId,
				delta: "memory follows workflow",
			});
		} else {
			expect(done).not.toHaveProperty("reasoning");
			expect(received.some((p) => p.type === "reasoning_delta")).toBe(false);
		}
		const activities = received.flatMap((p) => (p.type === "activity" ? [p.activity] : []));
		expect(activities.map((a) => [a.source, a.status])).toEqual([
			["slack", "running"],
			["slack", "done"],
			["engram", "running"],
			["engram", "failed"],
		]);
		for (const activity of activities) {
			expect(activity.detail).toBe('{"token":"[REDACTED]","content":"[REDACTED]"}');
			if (activity.status === "running") expect(activity.output).toBeUndefined();
			else expect(activity.output).toBe('{"password":"[REDACTED]","data":"[REDACTED]"}');
			expect(JSON.stringify(activity)).not.toMatch(/fixture-token|fixture-password|"args"/);
			expect(JSON.stringify(activity)).not.toContain(daemon.token);
		}
		ws.send(JSON.stringify({ type: "get_history" }));
		const history = await waitFor(() => received.find((p) => p.type === "history"));
		const assistant = history.messages.find((m) => m.role === "assistant");
		expect(assistant?.text).toBe(done.text);
		if (reasoning) expect(assistant?.reasoning).toBe(done.reasoning);
		else expect(assistant).not.toHaveProperty("reasoning");
		expect(assistant?.activities).toEqual(activities.filter((a) => a.status !== "running"));
		for (const activity of assistant?.activities ?? [])
			console.log("wire activity example", JSON.stringify(activity));

		// The same capability policy applies to paged earlier messages.
		ws.send(JSON.stringify({ type: "send", text: `rich:${daemon.token}` }));
		await waitFor(() => received.find((p) => p.type === "message_done" && p.messageId !== done.messageId));
		ws.send(JSON.stringify({ type: "get_history" }));
		const newest = await waitFor(() => received.filter((p) => p.type === "history").at(1));
		ws.send(JSON.stringify({ type: "get_earlier", before: newest.messages[0]?.id }));
		const earlier = await waitFor(() => received.find((p) => p.type === "earlier"));
		const previous = earlier.messages.find((m) => m.role === "assistant");
		if (reasoning) expect(previous?.reasoning).toBe(done.reasoning);
		else expect(previous).not.toHaveProperty("reasoning");
	} finally {
		ws.terminate();
		await daemon.close();
		rmSync(dataDir, { recursive: true, force: true });
	}
});

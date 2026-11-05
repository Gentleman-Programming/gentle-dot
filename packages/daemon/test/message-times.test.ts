import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { historyFromMessages, pageHistory } from "../src/conversations.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function connect() {
	const dataDir = tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir);
	writeFileSync(join(uiDir, "index.html"), "<!doctype html>");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		backoffMs: [50],
	});
	daemons.push(d);
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => messages.some((m) => m.type === "ready"));
	const send = (message: object) => ws.send(JSON.stringify(message));
	const find = <T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
	) =>
		waitFor(() =>
			messages.find(
				(m): m is Extract<ServerMessage, { type: T }> =>
					m.type === type && where(m as Extract<ServerMessage, { type: T }>),
			),
		);
	return { send, find };
}

function sessionFile(lines: object[]): string {
	const file = join(tempDir(), "session.jsonl");
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("message times (S14.7)", () => {
	it("stamps a live user message and a finished reply with the daemon's time, and nothing else changes", async () => {
		const { send, find } = await connect();
		const before = Date.now();
		send({ type: "send", text: "hello", requestId: "r1" });
		const user = await find("user_message");
		const done = await find("message_done");
		const after = Date.now();
		// An old client sees the same message with one more optional field.
		expect(user).toEqual({
			type: "user_message",
			messageId: user.messageId,
			text: "hello",
			at: user.at,
			seq: user.seq,
		});
		expect(done).toEqual({
			type: "message_done",
			messageId: done.messageId,
			text: done.text,
			at: done.at,
			seq: done.seq,
		});
		expect(user.at).toBeGreaterThanOrEqual(before);
		expect(done.at).toBeGreaterThanOrEqual(user.at as number);
		expect(done.at).toBeLessThanOrEqual(after);
	});

	it("gives history messages the time their session entry was written", async () => {
		const { send, find } = await connect();
		send({ type: "send", text: "hello", requestId: "r1" });
		const user = await find("user_message");
		const done = await find("message_done");
		send({ type: "get_history" });
		const history = await find("history", (h) => h.messages.length >= 2);
		const [first, second] = history.messages;
		expect(first).toMatchObject({ role: "user", text: "hello" });
		expect(second).toMatchObject({ role: "assistant" });
		// The entry is written right after the live event; both are the same moment within a second.
		expect(Math.abs((first?.at as number) - (user.at as number))).toBeLessThan(1000);
		expect(Math.abs((second?.at as number) - (done.at as number))).toBeLessThan(1000);
	});

	it("reads entry times from a session file, the last part's time for a merged turn, and omits unknown times", () => {
		const file = sessionFile([
			{ type: "session", version: 3, id: "s", timestamp: iso(T0) },
			{ type: "message", id: "1", timestamp: iso(T0 + 1000), message: { role: "user", content: "hi" } },
			{
				type: "message",
				id: "2",
				timestamp: iso(T0 + 2000),
				message: { role: "assistant", content: [{ type: "text", text: "part one" }] },
			},
			{
				type: "message",
				id: "3",
				timestamp: iso(T0 + 5000),
				message: { role: "assistant", content: [{ type: "text", text: "part two" }] },
			},
			{ type: "message", id: "4", timestamp: "not a date", message: { role: "user", content: "no time" } },
			{ type: "message", id: "5", message: { role: "assistant", content: [{ type: "text", text: "none" }] } },
		]);
		const { messages } = pageHistory([file], 100);
		expect(messages.map((m) => [m.role, m.text, m.at])).toEqual([
			["user", "hi", T0 + 1000],
			["assistant", "part one\n\npart two", T0 + 5000],
			["user", "no time", undefined],
			["assistant", "none", undefined],
		]);
		expect(messages[2]).not.toHaveProperty("at");
		expect(messages[3]).not.toHaveProperty("at");
	});

	it("falls back to the message's own time: a user message's, a reply's start plus its duration", () => {
		const history = historyFromMessages([
			{ role: "user", content: "hi", timestamp: T0 },
			{ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: T0 + 100, durationMs: 400 },
			{ role: "user", content: "again", timestamp: T0 + 1000 },
			// A start time alone is not when the reply finished.
			{ role: "assistant", content: [{ type: "text", text: "b" }], timestamp: T0 + 1100 },
		]);
		expect(history.map((m) => m.at)).toEqual([T0, T0 + 500, T0 + 1000, undefined]);
		expect(history[3]).not.toHaveProperty("at");
	});

	it("leaves history without times unchanged (regression)", () => {
		const history = historyFromMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		]);
		expect(history).toEqual([
			{ id: "h1", role: "user", text: "hi", activities: [] },
			{ id: "h2", role: "assistant", text: "hello", activities: [] },
		]);
	});

	it("omits a merged turn's time when its last part has none, and falls back per message (verifier)", () => {
		const r = historyFromMessages(
			[
				{ role: "user", content: "a", timestamp: T0 },
				{ role: "assistant", content: [{ type: "text", text: "x" }], timestamp: T0, durationMs: 5 },
				{ role: "toolResult", toolCallId: "c", content: [], timestamp: T0 + 7 },
				{ role: "assistant", content: [{ type: "text", text: "y" }], timestamp: T0 + 8 },
				{ role: "user", content: "b", timestamp: "bad" },
			],
			[],
		);
		expect(r.map((m) => m.at)).toEqual([T0, undefined, undefined]);
	});
});

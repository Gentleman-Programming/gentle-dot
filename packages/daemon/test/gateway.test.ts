import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { HIDDEN_NAMES } from "../src/white-label.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function daemon(env: NodeJS.ProcessEnv = process.env) {
	const dataDir = tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir);
	writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>Gentle Dot</title>");
	writeFileSync(join(uiDir, "app.js"), "console.log('app')");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentEnv: env,
		backoffMs: [50],
	});
	daemons.push(d);
	return d;
}

type Client = { ws: WebSocket; messages: ServerMessage[]; closed: Promise<number> };

function connect(d: DotDaemon, origin?: string): Promise<Client> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`, origin ? { origin } : {});
		const messages: ServerMessage[] = [];
		const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
		ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		ws.on("open", () => resolve({ ws, messages, closed }));
		ws.on("error", reject);
	});
}

async function authed(d: DotDaemon): Promise<Client> {
	const client = await connect(d);
	client.ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	await waitFor(() => client.messages.some((m) => m.type === "ready"));
	return client;
}

function send(client: Client, message: object): void {
	client.ws.send(JSON.stringify(message));
}

function find<T extends ServerMessage["type"]>(
	client: Client,
	type: T,
	where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
) {
	return waitFor(() =>
		client.messages.find(
			(m): m is Extract<ServerMessage, { type: T }> =>
				m.type === type && where(m as Extract<ServerMessage, { type: T }>),
		),
	);
}

describe("gateway", () => {
	it("closes with 4401 when the token is wrong", async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "hello", token: "wrong", protocol: 1 });
		expect(await client.closed).toBe(4401);
		expect(client.messages).toEqual([]);
	});

	it("closes with 4401 when the first message is not hello", async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "send", text: "hi" });
		expect(await client.closed).toBe(4401);
	});

	it("closes with 4400 for an unsupported protocol version", async () => {
		const d = await daemon();
		const client = await connect(d);
		send(client, { type: "hello", token: d.token, protocol: 2 });
		expect(await client.closed).toBe(4400);
	});

	it("rejects a WebSocket upgrade from a foreign origin", async () => {
		const d = await daemon();
		await expect(connect(d, "https://evil.example")).rejects.toThrow(/403/);
	});

	it("accepts the desktop app origin", async () => {
		const d = await daemon();
		const client = await connect(d, "tauri://localhost");
		send(client, { type: "hello", token: d.token, protocol: 1 });
		await waitFor(() => client.messages.some((m) => m.type === "ready"));
	});

	it("sends ready with the agent state and numbers every message", async () => {
		const d = await daemon();
		const client = await authed(d);
		const ready = await find(client, "ready");
		expect(ready.agentState).toBe("idle");
		expect(ready.conversationId).toBeTruthy();
		expect(client.messages.map((m) => m.seq)).toEqual(client.messages.map((_, i) => i + 1));
	});

	it("streams an answer: user message, deltas, final text, and state changes", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "hello there" });
		const done = await find(client, "message_done");
		expect(done.text).toBe("Echo: hello there");
		const user = await find(client, "user_message");
		expect(user.text).toBe("hello there");
		const deltas = client.messages.filter(
			(m) => m.type === "message_delta" && m.messageId === done.messageId,
		);
		expect(deltas.map((m) => (m.type === "message_delta" ? m.delta : "")).join("")).toBe("Echo: hello there");
		await find(client, "agent_state", (m) => m.state === "idle");
		const states = client.messages.flatMap((m) => (m.type === "agent_state" ? [m.state] : []));
		expect(states).toContain("thinking");
	});

	it("broadcasts to every connected client", async () => {
		const d = await daemon();
		const a = await authed(d);
		const b = await authed(d);
		send(a, { type: "send", text: "shared" });
		const done = await find(b, "message_done");
		expect(done.text).toBe("Echo: shared");
	});

	it("ignores a repeated requestId", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "once", requestId: "r1" });
		await find(client, "agent_state", (m) => m.state === "idle");
		await find(client, "message_done");
		send(client, { type: "send", text: "once", requestId: "r1" });
		send(client, { type: "list_conversations" });
		await find(client, "conversations");
		expect(client.messages.filter((m) => m.type === "user_message")).toHaveLength(1);
	});

	it("reports tool activity under the running answer", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "tool:read" });
		const done = await find(client, "activity", (m) => m.activity.status === "done");
		expect(done.activity.kind).toBe("read");
		const started = await find(client, "activity", (m) => m.activity.status === "running");
		expect(started.messageId).toBe(done.messageId);
		await find(client, "agent_state", (m) => m.state === "working");
	});

	it("relays a select ask and the user's answer", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "ask:select" });
		const ask = await find(client, "ask");
		expect(ask.ask).toMatchObject({ method: "select", title: "Pick a color", options: ["Red", "Blue"] });
		await find(client, "agent_state", (m) => m.state === "needs_you");
		send(client, { type: "ui_response", requestId: ask.ask.requestId, value: "Blue" });
		await find(client, "ask_resolved", (m) => m.requestId === ask.ask.requestId);
		const done = await find(client, "message_done");
		expect(done.text).toBe("You chose Blue");
	});

	it("re-sends pending asks to a client that connects later", async () => {
		const d = await daemon();
		const a = await authed(d);
		send(a, { type: "send", text: "ask:confirm" });
		const ask = await find(a, "ask");
		const b = await authed(d);
		const again = await find(b, "ask");
		expect(again.ask.requestId).toBe(ask.ask.requestId);
		send(b, { type: "ui_response", requestId: ask.ask.requestId, confirmed: true });
		expect((await find(a, "message_done")).text).toBe("Confirmed");
	});

	it("creates, lists, and reopens conversations with their history", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "first conversation" });
		await find(client, "message_done");
		await find(client, "agent_state", (m) => m.state === "idle");
		const firstId = (await find(client, "ready")).conversationId;

		send(client, { type: "new_conversation" });
		const listed = await find(client, "conversations", (m) => m.activeId !== firstId);
		expect(listed.conversations.map((c) => c.id)).toContain(firstId);
		expect(listed.conversations.find((c) => c.id === firstId)?.title).toBe("first conversation");

		send(client, { type: "open_conversation", conversationId: firstId });
		const history = await find(client, "history", (m) => m.conversationId === firstId);
		expect(history.messages.map((m) => [m.role, m.text])).toEqual([
			["user", "first conversation"],
			["assistant", "Echo: first conversation"],
		]);
	});

	it("refreshes the conversation list when a run settles so the title follows the first message", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "name this conversation" });
		const listed = await find(client, "conversations", (m) =>
			m.conversations.some((c) => c.title === "name this conversation"),
		);
		expect(listed.activeId).toBe((await find(client, "ready")).conversationId);
	});

	it("refuses a conversation id outside the session directory", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "open_conversation", conversationId: "../../etc/passwd" });
		const error = await find(client, "error");
		expect(error.code).toBe("conversation_not_found");
	});

	it("answers malformed frames with an error and keeps the connection", async () => {
		const d = await daemon();
		const client = await authed(d);
		client.ws.send("{nope");
		expect((await find(client, "error")).code).toBe("bad_message");
		send(client, { type: "get_history" });
		await find(client, "history");
	});

	it("tells clients about an interrupted run after the agent restarts", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "crash" });
		await find(client, "agent_state", (m) => m.state === "restarting");
		await find(client, "interrupted");
		await find(client, "agent_state", (m) => m.state === "idle");
	});
});

describe("white label", () => {
	it("passes the product identity to the agent", async () => {
		const argsFile = join(tempDir(), "argv.json");
		const d = await daemon({ ...process.env, FAKE_AGENT_ARGS_FILE: argsFile });
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		const at = argv.indexOf("--append-system-prompt");
		expect(at).toBeGreaterThan(-1);
		const identity = readFileSync(argv[at + 1] ?? "", "utf8");
		expect(identity).toContain("You are Gentle Dot");
		expect(d.supervisor.state).toBe("ready");
	});

	it("hides branded startup chatter", async () => {
		const d = await daemon({ ...process.env, FAKE_AGENT_BRANDING: "1" });
		const client = await authed(d);
		send(client, { type: "get_history" });
		await find(client, "history");
		const text = JSON.stringify(client.messages);
		for (const name of HIDDEN_NAMES) expect(text).not.toMatch(name);
	});

	it("rewrites branded ask text", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "ask:confirm" });
		const ask = await find(client, "ask");
		expect(ask.ask.message).toBe("Gentle Dot wants to continue");
	});

	it("refuses internal slash commands", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "/gentle:yolo" });
		expect((await find(client, "error")).code).toBe("unsupported");
		expect(client.messages.some((m) => m.type === "user_message")).toBe(false);
	});
});

describe("http", () => {
	it("serves the UI, falls back to index.html, and blocks path traversal", async () => {
		const d = await daemon();
		const base = `http://127.0.0.1:${d.port}`;
		expect(await (await fetch(`${base}/app.js`)).text()).toBe("console.log('app')");
		expect(await (await fetch(`${base}/some/route`)).text()).toContain("<title>Gentle Dot</title>");
		const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
		expect(await traversal.text()).not.toContain('"name"');
	});

	it("reports health without the token", async () => {
		const d = await daemon();
		const health = (await (await fetch(`http://127.0.0.1:${d.port}/health`)).json()) as Record<
			string,
			unknown
		>;
		expect(health).toEqual({ ok: true, agentState: "idle" });
	});
});

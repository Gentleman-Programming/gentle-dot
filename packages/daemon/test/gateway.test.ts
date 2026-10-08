import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, ensureToken, startDaemon, startupMessage } from "../src/daemon.ts";
import { HIDDEN_NAMES, presentText } from "../src/white-label.ts";
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

	it("shows a message sent while busy as queued in every window, then delivers it when the run ends", async () => {
		const d = await daemon();
		const a = await authed(d);
		const b = await authed(d);
		send(a, { type: "send", text: "slow" });
		await find(a, "agent_state", (m) => m.state === "thinking");
		send(a, { type: "send", text: "ask Gentle Shell later" });
		const shown = presentText("ask Gentle Shell later");
		expect(shown).not.toContain("Gentle Shell");
		for (const client of [a, b]) {
			const queued = await find(client, "queue", (m) => m.steering.length > 0);
			expect(queued).toMatchObject({ steering: [shown], followUp: [] });
		}
		// The final answer is white-labeled too; the user's own words are shown as typed.
		const echo = presentText("Echo: ask Gentle Shell later");
		const done = await find(b, "message_done", (m) => m.text === echo);
		const types = b.messages.map((m) => m.type);
		const emptied = b.messages.findIndex(
			(m) => m.type === "queue" && m.steering.length === 0 && m.followUp.length === 0,
		);
		const delivered = b.messages.findIndex(
			(m) => m.type === "user_message" && m.text === "ask Gentle Shell later",
		);
		expect(emptied).toBeGreaterThan(types.indexOf("queue"));
		expect(delivered).toBeGreaterThan(emptied);
		expect(b.messages.indexOf(done)).toBeGreaterThan(delivered);
		expect(b.messages.filter((m) => m.type === "message_done").map((m) => m.text)).toEqual([
			"Echo: slow",
			echo,
		]);
		await find(b, "agent_state", (m) => m.state === "idle");
	});

	it("gives a window that connects later the current queue, and nothing once it is empty", async () => {
		const d = await daemon();
		const a = await authed(d);
		send(a, { type: "send", text: "slow" });
		await find(a, "agent_state", (m) => m.state === "thinking");
		send(a, { type: "send", text: "queued one" });
		await find(a, "queue", (m) => m.steering.length > 0);
		const late = await authed(d);
		const queued = await find(late, "queue");
		expect(queued).toMatchObject({ steering: ["queued one"], followUp: [] });
		expect(late.messages.map((m) => m.type).slice(0, 2)).toEqual(["ready", "queue"]);
		await find(a, "agent_state", (m) => m.state === "idle");
		const after = await authed(d);
		send(after, { type: "list_conversations" });
		await find(after, "conversations");
		expect(after.messages.some((m) => m.type === "queue")).toBe(false);
	});

	it("clears the queue when the run settles without the engine emptying it", async () => {
		const d = await daemon({ ...process.env, FAKE_AGENT_DROP_QUEUE: "1" });
		const a = await authed(d);
		send(a, { type: "send", text: "slow" });
		await find(a, "agent_state", (m) => m.state === "thinking");
		send(a, { type: "send", text: "never delivered" });
		await find(a, "queue", (m) => m.steering.length > 0);
		await find(a, "agent_state", (m) => m.state === "idle");
		const cleared = await find(a, "queue", (m) => m.steering.length === 0 && m.followUp.length === 0);
		expect(cleared).toMatchObject({ steering: [], followUp: [] });
		expect(a.messages.some((m) => m.type === "user_message" && m.text === "never delivered")).toBe(false);
		const late = await authed(d);
		send(late, { type: "list_conversations" });
		await find(late, "conversations");
		expect(late.messages.some((m) => m.type === "queue")).toBe(false);
	});

	it("clears the queue when the agent restarts", async () => {
		const d = await daemon();
		const a = await authed(d);
		send(a, { type: "send", text: "hang" });
		await find(a, "agent_state", (m) => m.state === "thinking");
		send(a, { type: "send", text: "lost in the crash" });
		await find(a, "queue", (m) => m.steering.length > 0);
		const pid = d.supervisor.pid;
		if (!pid) throw new Error("the agent is not running");
		process.kill(pid, "SIGKILL");
		await find(a, "agent_state", (m) => m.state === "restarting");
		const cleared = await find(a, "queue", (m) => m.steering.length === 0);
		expect(cleared).toMatchObject({ steering: [], followUp: [] });
		await find(a, "agent_state", (m) => m.state === "idle");
	});

	it("stops a running answer before opening another conversation, with no error", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "first chat" });
		await find(client, "message_done", (m) => m.text === "Echo: first chat");
		await find(client, "agent_state", (m) => m.state === "idle");
		const firstId = (await find(client, "ready")).conversationId;
		send(client, { type: "new_conversation" });
		await find(client, "history", (m) => m.conversationId !== firstId);
		const hangs = () => client.messages.filter((m) => m.type === "user_message" && m.text === "hang").length;
		send(client, { type: "send", text: "hang" });
		await waitFor(() => hangs() === 1);
		const before = client.messages.length;

		send(client, { type: "open_conversation", conversationId: firstId });
		const history = await find(client, "history", (m) => m.conversationId === firstId);
		expect(history.messages.map((m) => m.text)).toEqual(["first chat", "Echo: first chat"]);
		const after = client.messages.slice(before);
		const stopped = after.findIndex((m) => m.type === "message_done" && m.stopped === true);
		expect(stopped).toBeGreaterThanOrEqual(0);
		expect(stopped).toBeLessThan(after.indexOf(history));
		expect(after.filter((m) => m.type === "toast" || m.type === "error")).toEqual([]);
		expect(after.some((m) => m.type === "message_done" && m.error !== undefined)).toBe(false);
		await find(client, "agent_state", (m) => m.state === "idle");

		send(client, { type: "send", text: "hang" });
		await waitFor(() => hangs() === 2);
		const mark = client.messages.length;
		send(client, { type: "new_conversation" });
		const fresh = await waitFor(() =>
			client.messages
				.slice(mark)
				.find((m): m is Extract<ServerMessage, { type: "history" }> => m.type === "history"),
		);
		expect(fresh.conversationId).not.toBe(firstId);
		expect(fresh.messages).toEqual([]);
		const later = client.messages.slice(mark);
		expect(later.some((m) => m.type === "message_done" && m.stopped === true)).toBe(true);
		expect(later.filter((m) => m.type === "toast" || m.type === "error")).toEqual([]);
	});

	it("sends a message typed during a switch to the new conversation, after its history", async () => {
		const d = await daemon();
		const client = await authed(d);
		const oldId = (await find(client, "ready")).conversationId;
		send(client, { type: "new_conversation" });
		send(client, { type: "send", text: "right away" });
		const done = await find(client, "message_done");
		expect(done.text).toBe("Echo: right away");
		await find(client, "agent_state", (m) => m.state === "idle");
		const types = client.messages.map((m) => m.type);
		const history = client.messages.findIndex((m) => m.type === "history");
		const user = types.indexOf("user_message");
		expect(history).toBeGreaterThanOrEqual(0);
		expect(history).toBeLessThan(user);
		expect(types.lastIndexOf("history")).toBe(history);
		const listed = await find(client, "conversations", (m) =>
			m.conversations.some((c) => c.title === "right away"),
		);
		expect(listed.activeId).not.toBe(oldId);
		expect(listed.conversations.find((c) => c.title === "right away")?.id).toBe(listed.activeId);
	});

	it("marks an answer the user stopped as stopped, not as an error", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "hang" });
		await find(client, "agent_state", (m) => m.state === "thinking");
		send(client, { type: "abort" });
		const done = await find(client, "message_done");
		expect(done).toMatchObject({ stopped: true });
		expect(done.error).toBeUndefined();
		await find(client, "agent_state", (m) => m.state === "idle");
		expect(client.messages.filter((m) => m.type === "toast" || m.type === "error")).toEqual([]);
	});

	it("reports an error while answering inside the conversation, in plain words", async () => {
		const d = await daemon();
		const client = await authed(d);
		send(client, { type: "send", text: "fail" });
		const done = await find(client, "message_done");
		expect(done.error).toBe("Something went wrong while answering. Please try again.");
		expect(done.stopped).toBeUndefined();
		const shown = JSON.stringify(client.messages);
		expect(shown).not.toContain("exploded");
		for (const name of HIDDEN_NAMES) expect(shown).not.toMatch(name);
		await find(client, "agent_state", (m) => m.state === "idle");
		expect(client.messages.filter((m) => m.type === "toast")).toEqual([]);
	});

	it("answers a history request made while the agent restarts once it is back", async () => {
		const d = await daemon({ ...process.env, FAKE_AGENT_START_DELAY_MS: "400" });
		const client = await authed(d);
		send(client, { type: "send", text: "keep me" });
		await find(client, "agent_state", (m) => m.state === "idle");
		const pid = d.supervisor.pid;
		if (!pid) throw new Error("the agent is not running");
		process.kill(pid, "SIGKILL");
		await find(client, "agent_state", (m) => m.state === "restarting");
		send(client, { type: "get_history" });
		const history = await find(client, "history");
		expect(history.messages.map((m) => m.text)).toEqual(["keep me", "Echo: keep me"]);
		expect(client.messages.filter((m) => m.type === "error")).toEqual([]);
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

describe("own instance", () => {
	it("runs the agent with the assistant's own home and profile store", async () => {
		const scratch = tempDir();
		const argsFile = join(scratch, "argv.json");
		const envFile = join(scratch, "env.json");
		const dataDir = tempDir();
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: dataDir,
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			agentHome: join(dataDir, "agent"),
			agentEnv: { ...process.env, FAKE_AGENT_ARGS_FILE: argsFile, FAKE_AGENT_ENV_FILE: envFile },
		});
		daemons.push(d);
		const argv = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
		expect(argv.slice(0, 4)).toEqual(["--home", join(dataDir, "agent"), "--mode", "rpc"]);
		const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>;
		expect(env.GENTLE_PI_CONFIG_HOME).toBe(join(dataDir, "gentle-ai"));
	});

	it("gives the agent its own HOME and XDG folders, keeping PATH, the user's git identity, and the user's Engram", async () => {
		const scratch = tempDir();
		const realHome = join(scratch, "user");
		mkdirSync(realHome);
		writeFileSync(join(realHome, ".gitconfig"), "[user]\n\tname = Someone\n");
		const envFile = join(scratch, "env.json");
		const dataDir = tempDir();
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: join(dataDir, "workspace"),
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [FAKE_AGENT],
			agentHome: join(dataDir, "agent"),
			agentEnv: {
				...process.env,
				HOME: realHome,
				XDG_CONFIG_HOME: join(realHome, ".config"),
				XDG_DATA_HOME: join(realHome, "data"),
				XDG_CACHE_HOME: join(realHome, "cache"),
				XDG_STATE_HOME: join(realHome, "state"),
				PI_CODING_AGENT_DIR: join(realHome, ".pi", "agent"),
				GENTLE_SHELL_CONFIG: join(realHome, ".gentle-shell", "config.json"),
				ENGRAM_URL: "http://127.0.0.1:7437",
				FAKE_AGENT_ENV_FILE: envFile,
			},
		});
		daemons.push(d);
		const env = JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string | undefined>;
		const home = join(dataDir, "home");
		expect(env).toEqual({
			GENTLE_PI_CONFIG_HOME: join(dataDir, "gentle-ai"),
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			XDG_DATA_HOME: join(home, ".local", "share"),
			XDG_CACHE_HOME: join(home, ".cache"),
			XDG_STATE_HOME: join(home, ".local", "state"),
			GIT_CONFIG_GLOBAL: join(realHome, ".gitconfig"),
			PATH: process.env.PATH,
			// The user's global Engram: its data dir, so the memory plugin accepts the user's server.
			ENGRAM_DATA_DIR: join(realHome, ".engram"),
			ENGRAM_URL: "http://127.0.0.1:7437",
		});
		expect(statSync(home).mode & 0o777).toBe(0o700);
		expect(existsSync(join(dataDir, "workspace"))).toBe(true);
	});

	it("keeps the data folder and the access key private, repairing looser modes", () => {
		const dataDir = join(tempDir(), "data");
		mkdirSync(dataDir, { mode: 0o755 });
		chmodSync(dataDir, 0o755);
		writeFileSync(join(dataDir, "token"), `${"k".repeat(43)}\n`, { mode: 0o644 });
		chmodSync(join(dataDir, "token"), 0o644);
		expect(ensureToken(dataDir)).toBe("k".repeat(43));
		expect(statSync(dataDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);
	});

	it("shows the access key only on an interactive terminal", () => {
		const url = "http://127.0.0.1:4317/#token=secret-token";
		expect(startupMessage(url, "/data", true)).toBe(`Gentle Dot is running at ${url}`);
		const piped = startupMessage(url, "/data", false);
		expect(piped).not.toContain("secret-token");
		expect(piped).toBe("Gentle Dot is running at http://127.0.0.1:4317/ (the access key is in /data/token)");
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

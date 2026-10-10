// The daemon in server mode (S25.8), end to end with the fake agent: the engine runs as another
// user, the daemon's own files stay out of its reach, connector secrets are encrypted at rest with a
// key only the daemon's environment holds, and the web page changes connectors and allows sending
// actions only with a PIN the agent never sees. With the desktop app's channel, nothing changes.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { McpClient, type McpError, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { APP_REQUIRED, type ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DaemonOptions, type DotDaemon, startDaemon } from "../src/daemon.ts";
import { FileSecretSource } from "../src/secret-file.ts";
import { PIN_ATTEMPTS } from "../src/web-pin.ts";
import { fakeApp } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { oauthOptions } from "./fake-oauth.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const PIN = "731942";
const SIGNED_IN_TOKEN = "access-token-1";
const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
const ENGINE_DIRS = ["agent", "home", "workspace", "sessions", "gentle-ai"];

const TOOLS: Tool[] = [
	{ name: "notion-search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "notion-create-pages", inputSchema: { type: "object" } },
];

const daemons: DotDaemon[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

interface Setup {
	app?: boolean;
	vps?: false | Partial<NonNullable<DaemonOptions["vps"]>>;
	env?: NodeJS.ProcessEnv;
	/** A `connectors.json` left by an older version, written before the daemon starts. */
	connectors?: object;
}

async function setup(options: Setup = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	if (options.connectors) writeFileSync(join(dataDir, "connectors.json"), JSON.stringify(options.connectors));
	const processFile = join(dataDir, "..", `${randomBytes(6).toString("hex")}-process.json`);
	const stdinFile = join(dataDir, "..", `${randomBytes(6).toString("hex")}-stdin.jsonl`);
	const key = randomBytes(32);
	const handedOver: string[][] = [];
	const engineAccesses = { count: 0 };
	const logs: string[] = [];
	const notionCalls: string[] = [];
	const notionUrl = await fakeNotion(notionCalls);
	const app = fakeApp([], "allow");
	const fake = fakeAuthRuntime();
	const vps =
		options.vps === false
			? undefined
			: {
					engine: own,
					connector: own,
					secretsKey: key,
					handOver: (paths: string[]) => handedOver.push(paths),
					// With the test's own user there is no one to switch to; count what goes through it.
					access: <T>(fn: () => T): T => {
						engineAccesses.count++;
						return fn();
					},
					...options.vps,
				};
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome,
		agentEnv: {
			...process.env,
			FAKE_AGENT_PROCESS_FILE: processFile,
			FAKE_AGENT_STDIN_FILE: stdinFile,
			...options.env,
		},
		backoffMs: [50],
		authRuntime: async () => fake.runtime,
		connectorOAuth: oauthOptions(true),
		connectorTransport: (_connector, credentials) =>
			new StreamableHttpTransport({
				url: notionUrl,
				...(credentials.headers ? { headers: credentials.headers } : {}),
				...(credentials.authProvider ? { authProvider: credentials.authProvider } : {}),
				openGetStream: false,
			}),
		approvalWaitMs: 1500,
		...(options.app ? { appChannel: app.daemonEnd } : {}),
		...(vps ? { vps } : {}),
		log: (line) => logs.push(line),
	});
	daemons.push(d);
	const window = await connect(d);
	const engineProcess = () =>
		JSON.parse(readFileSync(processFile, "utf8")) as {
			env: Record<string, string>;
			uid: number;
			argv: string[];
		};
	const stdin = () => (existsSync(stdinFile) ? readFileSync(stdinFile, "utf8") : "");
	const connectorsText = () => readFileSync(join(dataDir, "connectors.json"), "utf8");
	const mcpText = () => readFileSync(join(agentHome, "mcp.json"), "utf8");
	const engineClient = async (id: string) => {
		const entry = JSON.parse(mcpText()).mcpServers[id] as { url: string; headers: Record<string, string> };
		const client = new McpClient({ name: "engine", version: "1" });
		closers.push(() => client.close());
		await client.connect(new StreamableHttpTransport({ url: entry.url, headers: entry.headers }));
		return client;
	};
	return {
		d,
		dataDir,
		agentHome,
		key,
		app,
		logs,
		handedOver,
		engineAccesses,
		notionCalls,
		engineProcess,
		stdin,
		connectorsText,
		mcpText,
		engineClient,
		...window,
	};
}

/** Notion as far as the proxy can tell: plain JSON over HTTP, recording the tools it ran. */
async function fakeNotion(calls: string[]) {
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
			if (message.id === undefined) {
				res.writeHead(202).end();
				return;
			}
			if (message.method === "tools/call") calls.push(String(message.params?.name));
			const result =
				message.method === "initialize"
					? {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "notion", version: "1" },
						}
					: message.method === "tools/list"
						? { tools: TOOLS }
						: { content: [{ type: "text", text: `notion ran ${String(message.params?.name)}` }] };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	closers.push(() => new Promise((done) => server.close(done)));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

async function connect(d: DotDaemon) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	closers.push(async () => ws.close());
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
	const send = (m: object) => ws.send(JSON.stringify(m));
	function find<T extends ServerMessage["type"]>(
		type: T,
		where: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
		after = 0,
	) {
		return waitFor(() =>
			messages
				.slice(after)
				.find(
					(m): m is Extract<ServerMessage, { type: T }> =>
						m.type === type && where(m as Extract<ServerMessage, { type: T }>),
				),
		);
	}
	return { ws, messages, send, find, ready };
}

const settle = (ms = 200) => new Promise((resolve) => setTimeout(resolve, ms));
const mode = (connectorId: string, value: "read_only" | "read_write") => ({
	type: "connector_mode",
	connectorId,
	mode: value,
});

/** Connects Notion with the PIN (the stand-in OAuth signs in at once) and waits for the new engine. */
async function connectNotion(s: Awaited<ReturnType<typeof setup>>) {
	const pid = s.d.supervisor.pid;
	s.send({ type: "pin_command", pin: PIN, command: { type: "connector_connect", connectorId: "notion" } });
	await s.find("auth_done", (m) => m.ok);
	await waitFor(() => s.d.supervisor.pid !== pid && s.d.supervisor.state === "ready");
}

describe("server mode: the engine as another user (S25.8)", () => {
	it.skipIf(own.uid === 0)("starts the engine under the engine user's uid and gid", async () => {
		const { d, engineProcess } = await setup();
		await waitFor(() => d.supervisor.state === "ready");
		expect(engineProcess()).toMatchObject({ uid: own.uid });
		// A uid this test process cannot take: the spawn itself is refused, so the uid is applied.
		const other = await setup({ vps: { engine: { uid: own.uid + 1, gid: own.gid }, access: (fn) => fn() } });
		await waitFor(() => other.logs.some((line) => /EPERM|agent failed to start/.test(line)));
		expect(other.d.supervisor.state).not.toBe("ready");
	});

	it("keeps the daemon's files private and reaches the engine's folders only as the engine user", async () => {
		const { d, dataDir, handedOver, engineAccesses, send, find } = await setup();
		await waitFor(() => d.supervisor.state === "ready");
		// The engine may pass through the data folder to its own folders, but not list it.
		expect(statSync(dataDir).mode & 0o777).toBe(0o711);
		expect(statSync(join(dataDir, "token")).mode & 0o777).toBe(0o600);
		// The engine reads its identity prompt by name.
		expect(statSync(join(dataDir, "identity.md")).mode & 0o777).toBe(0o644);
		for (const dir of ENGINE_DIRS) expect(statSync(join(dataDir, dir)).isDirectory(), dir).toBe(true);
		// Only at start, for files an older version left as root; from then on the engine's user makes them.
		expect(handedOver).toHaveLength(1);
		expect(handedOver[0]?.slice().sort()).toEqual(ENGINE_DIRS.map((dir) => join(dataDir, dir)).sort());
		await d.supervisor.restart();
		expect(handedOver).toHaveLength(1);
		// An upload and a profile change reach the engine's folders only through the engine's user (B1).
		let before = engineAccesses.count;
		const upload = await fetch(`http://127.0.0.1:${d.port}/upload`, {
			method: "POST",
			headers: { authorization: `Bearer ${d.token}`, "x-file-name": "notes.txt" },
			body: "hello",
		});
		expect(upload.status).toBe(200);
		expect(engineAccesses.count).toBeGreaterThan(before);
		before = engineAccesses.count;
		send({ type: "profile_save", name: "work", roles: {} });
		await find("profiles");
		expect(engineAccesses.count).toBeGreaterThan(before);
		// Nothing of the daemon's own is ever handed over.
		const handed = handedOver.flat();
		for (const name of [
			"token",
			"connectors.json",
			"secrets.enc.json",
			"web-pin.json",
			"connector-signin",
			"config.json",
		])
			expect(
				handed.some((path) => path === join(dataDir, name) || path.startsWith(`${join(dataDir, name)}/`)),
				name,
			).toBe(false);
	});

	it("never passes the secrets key to the engine", async () => {
		const { d, engineProcess } = await setup({ env: { GENTLE_DOT_SECRETS_KEY: "do-not-leak-this-key" } });
		await waitFor(() => d.supervisor.state === "ready");
		const seen = JSON.stringify(engineProcess());
		expect(seen).not.toContain("GENTLE_DOT_SECRETS_KEY");
		expect(seen).not.toContain("do-not-leak-this-key");
	});
});

describe("server mode: connector secrets encrypted at rest (S25.8)", () => {
	it("keeps a sign-in only encrypted, in a daemon file the same key opens", async () => {
		const s = await setup();
		await waitFor(() => s.d.supervisor.state === "ready");
		s.send({ type: "pin_set", pin: PIN });
		await s.find("pin_status", (m) => m.pin.set);
		await connectNotion(s);
		const file = join(s.dataDir, "secrets.enc.json");
		await waitFor(() => existsSync(file) && readFileSync(file, "utf8").includes("connector/notion"));
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(SIGNED_IN_TOKEN);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(s.mcpText()).not.toContain(SIGNED_IN_TOKEN);
		const ids = await new FileSecretSource({ file, key: s.key }).list();
		expect(ids).toEqual(expect.arrayContaining(["integrity/connectors"]));
		expect(ids.some((id) => id.startsWith("connector/notion"))).toBe(true);
	});

	it("moves a secret an older version left in connectors.json into the encrypted file, once", async () => {
		const token = "older-discord-bot-token-0123";
		const s = await setup({
			connectors: {
				version: 1,
				connectors: { discord: { enabled: true, mode: "read_only", values: { token } } },
			},
		});
		await waitFor(() => s.d.supervisor.state === "ready");
		await waitFor(() => !s.connectorsText().includes(token));
		const file = join(s.dataDir, "secrets.enc.json");
		expect(readFileSync(file, "utf8")).not.toContain(token);
		expect(await new FileSecretSource({ file, key: s.key }).get("connector/discord/value/token")).toBe(token);
		expect(JSON.parse(s.connectorsText()).connectors.discord.values).toEqual({
			token: { secretRef: "connector/discord/value/token" },
		});
	});

	it("without the key, connectors that need a secret fail closed with the reason", async () => {
		const s = await setup({ vps: { secretsKey: undefined } });
		await waitFor(() => s.d.supervisor.state === "ready");
		s.send({ type: "pin_set", pin: PIN });
		await s.find("pin_status", (m) => m.pin.set);
		s.send({ type: "pin_command", pin: PIN, command: { type: "connector_connect", connectorId: "notion" } });
		const failed = await waitFor(() =>
			s.messages.find(
				(m) =>
					(m.type === "auth_done" && !m.ok) ||
					(m.type === "error" && /GENTLE_DOT_SECRETS_KEY/.test(m.message)),
			),
		);
		expect(JSON.stringify(failed)).toMatch(/GENTLE_DOT_SECRETS_KEY/);
		expect(existsSync(join(s.dataDir, "secrets.enc.json"))).toBe(false);
	});
});

describe("server mode: the web PIN (S25.8)", () => {
	it("asks for a PIN for connector changes, sets it on first use, and stores only its hash", async () => {
		const s = await setup();
		await waitFor(() => s.d.supervisor.state === "ready");
		expect(s.ready).toMatchObject({ type: "ready", pin: { set: false } });
		const before = existsSync(join(s.dataDir, "connectors.json")) ? s.connectorsText() : "";
		s.send(mode("notion", "read_write"));
		expect(await s.find("error", (m) => m.code === "pin_required")).toMatchObject({ code: "pin_required" });
		s.send({ type: "pin_command", pin: PIN, command: mode("notion", "read_write") });
		await s.find("error", (m) => m.code === "pin_required", 2);
		await settle();
		expect(existsSync(join(s.dataDir, "connectors.json")) ? s.connectorsText() : "").toBe(before);

		s.send({ type: "pin_set", pin: PIN });
		expect(await s.find("pin_status", (m) => m.pin.set)).toMatchObject({ pin: { set: true } });
		const stored = readFileSync(join(s.dataDir, "web-pin.json"), "utf8");
		expect(stored).not.toContain(PIN);
		expect(statSync(join(s.dataDir, "web-pin.json")).mode & 0o777).toBe(0o600);
		// A second window learns it is set; nobody can set it again.
		const other = await connect(s.d);
		expect(other.ready).toMatchObject({ pin: { set: true } });
		other.send({ type: "pin_set", pin: "111111" });
		await other.find("error", (m) => m.code === "pin_exists");
		expect(readFileSync(join(s.dataDir, "web-pin.json"), "utf8")).toBe(stored);
	});

	it("refuses a wrong PIN without changing anything, makes the change with the right one, and locks after repeated tries", async () => {
		const s = await setup();
		await waitFor(() => s.d.supervisor.state === "ready");
		s.send({ type: "pin_set", pin: PIN });
		await s.find("pin_status", (m) => m.pin.set);
		await connectNotion(s);
		const saved = () => JSON.parse(s.connectorsText()).connectors.notion as { mode: string };
		expect(saved().mode).toBe("read_only");
		const before = s.connectorsText();

		const seen = s.messages.length;
		s.send({ type: "pin_command", pin: "000000", command: mode("notion", "read_write") });
		const wrong = await s.find("error", (m) => m.code === "pin_wrong", seen);
		expect(wrong.message).toMatch(new RegExp(`${PIN_ATTEMPTS - 1}`));
		await settle();
		expect(s.connectorsText()).toBe(before);

		const pid = s.d.supervisor.pid;
		s.send({ type: "pin_command", pin: PIN, command: mode("notion", "read_write") });
		await waitFor(() => saved().mode === "read_write");
		await waitFor(() => s.d.supervisor.pid !== pid && s.d.supervisor.state === "ready");
		// The PIN confirmed it; nothing was asked again.
		expect(s.messages.filter((m) => m.type === "ask")).toEqual([]);

		const changed = s.connectorsText();
		for (let i = 0; i < PIN_ATTEMPTS; i++)
			s.send({ type: "pin_command", pin: "000000", command: mode("notion", "read_only") });
		await s.find("error", (m) => m.code === "pin_locked");
		expect(await s.find("pin_status", (m) => m.pin.locked === true)).toMatchObject({
			pin: { set: true, locked: true },
		});
		const locked = s.messages.length;
		s.send({ type: "pin_command", pin: PIN, command: mode("notion", "read_only") });
		await s.find("error", (m) => m.code === "pin_locked", locked);
		await settle();
		expect(s.connectorsText()).toBe(changed);
	});

	it("allows a sending action only with the PIN; a wrong PIN keeps it waiting, and declining needs none", async () => {
		const s = await setup();
		await waitFor(() => s.d.supervisor.state === "ready");
		s.send({ type: "pin_set", pin: PIN });
		await s.find("pin_status", (m) => m.pin.set);
		await connectNotion(s);
		const pid = s.d.supervisor.pid;
		s.send({ type: "pin_command", pin: PIN, command: mode("notion", "read_write") });
		await waitFor(() => s.d.supervisor.pid !== pid && s.d.supervisor.state === "ready");
		const client = await s.engineClient("notion");
		const refusal = (call: Promise<unknown>) =>
			call.then(
				() => undefined,
				(e: unknown) => e as McpError,
			);

		const args = { title: "Plan", parent: "Team space" };
		const allowed = client.callTool("notion-create-pages", args);
		const ask = await s.find("ask", (m) => m.ask.method === "pin");
		expect(ask.ask).toMatchObject({ method: "pin", title: "Allow Notion to create pages?" });
		expect(ask.ask.message).toContain("Plan");
		expect(ask.ask.message).toContain("Team space");
		// Yes without the PIN is not an answer.
		s.send({ type: "ui_response", requestId: ask.ask.requestId, confirmed: true });
		await s.find("error", (m) => m.code === "pin_required");
		s.send({ type: "pin_approve", requestId: ask.ask.requestId, pin: "000000" });
		await s.find("error", (m) => m.code === "pin_wrong");
		await settle();
		expect(s.notionCalls).toEqual([]);
		s.send({ type: "pin_approve", requestId: ask.ask.requestId, pin: PIN });
		expect(await allowed).toMatchObject({ content: [{ text: "notion ran notion-create-pages" }] });
		expect(s.notionCalls).toEqual(["notion-create-pages"]);
		await s.find("ask_resolved", (m) => m.requestId === ask.ask.requestId);

		const seen = s.messages.length;
		const declined = refusal(client.callTool("notion-create-pages", args));
		const second = await s.find("ask", (m) => m.ask.method === "pin", seen);
		s.send({ type: "ui_response", requestId: second.ask.requestId, confirmed: false });
		expect((await declined)?.message).toMatch(/did not allow/);
		expect(s.notionCalls).toEqual(["notion-create-pages"]);

		// The PIN went to the daemon only: never to the engine's input, its environment, or a log.
		s.send({ type: "send", text: "hello", requestId: "r1" });
		await s.find("message_done");
		expect(s.stdin()).toContain("hello");
		expect(s.stdin()).not.toContain(PIN);
		expect(JSON.stringify(s.engineProcess())).not.toContain(PIN);
		expect(s.logs.join("\n")).not.toContain(PIN);
	});
});

describe("with the desktop app's channel, server mode changes nothing (S25.2)", () => {
	it("keeps app_required on the WebSocket, offers no PIN, and keeps secrets in the app", async () => {
		const s = await setup({ app: true });
		await waitFor(() => s.d.supervisor.state === "ready");
		expect(s.ready).toMatchObject({ type: "ready" });
		expect(s.ready).not.toHaveProperty("pin");
		for (const message of [
			{ type: "pin_set", pin: PIN },
			{ type: "pin_command", pin: PIN, command: mode("notion", "read_write") },
			mode("notion", "read_write"),
		])
			s.send(message);
		await waitFor(
			() => s.messages.filter((m) => m.type === "error" && m.code === "app_required").length === 3,
		);
		expect(
			s.messages
				.filter((m) => m.type === "error")
				.every((m) => m.type === "error" && m.message === APP_REQUIRED),
		).toBe(true);
		expect(existsSync(join(s.dataDir, "web-pin.json"))).toBe(false);
		// Secrets stay in the app's store.
		await waitFor(() => s.app.secretCalls.some((call) => call.includes("integrity/connectors")));
		expect(existsSync(join(s.dataDir, "secrets.enc.json"))).toBe(false);
	});

	it("without server mode and without the app, a PIN opens nothing", async () => {
		const s = await setup({ vps: false });
		await waitFor(() => s.d.supervisor.state === "ready");
		expect(s.ready).not.toHaveProperty("pin");
		s.send({ type: "pin_set", pin: PIN });
		s.send({ type: "pin_command", pin: PIN, command: mode("notion", "read_write") });
		await waitFor(
			() => s.messages.filter((m) => m.type === "error" && m.code === "app_required").length === 2,
		);
		expect(existsSync(join(s.dataDir, "web-pin.json"))).toBe(false);
		// The data folder stays 0700 and nothing is handed over outside server mode.
		expect(statSync(s.dataDir).mode & 0o777).toBe(0o700);
		expect(s.handedOver).toEqual([]);
	});
});

// The daemon in server mode (S25.8), end to end with the fake agent: the engine runs as another
// user, the daemon's own files stay out of its reach, connector secrets are encrypted at rest with a
// key only the daemon's environment holds, and the web page changes connectors and allows sending
// actions only with a PIN the agent never sees. With the desktop app's channel, nothing changes.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
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
import { hasServerMode } from "./support/platform-absence.ts";
import { expectPosixMode } from "./support/posix-modes.ts";

const PIN = "731942";
const SIGNED_IN_TOKEN = "access-token-1";
const own = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
// Server mode takes the engine's user with setuid, which Windows does not have (S25.8): every suite
// below whose subject is it skips there with a named reason on raw stderr, not a silent skip.
const serverMode = hasServerMode("vps-gateway: server mode");
const ENGINE_DIRS = ["agent", "home", "workspace", "sessions", "gentle-ai"];

const TOOLS: Tool[] = [
	{ name: "notion-search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "notion-create-pages", inputSchema: { type: "object" } },
];

const daemons: DotDaemon[] = [];
const closers: (() => Promise<unknown>)[] = [];
const notionProtocolFailures: string[] = [];
interface NotionRequestFact {
	method: string;
	path: string;
	completed: boolean;
	aborted: boolean;
	bodyBytes: number;
	status?: number;
}
function expectNoNotionProtocolFailures(failures = notionProtocolFailures) {
	expect(failures.splice(0)).toEqual([]);
}

afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
	await Promise.all(daemons.splice(0).map((d) => d.close()));
	expectNoNotionProtocolFailures();
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
	const notionRequests: NotionRequestFact[] = [];
	const notionUrl = await fakeNotion(notionCalls, notionRequests);
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
		notionRequests,
		engineProcess,
		stdin,
		connectorsText,
		mcpText,
		engineClient,
		...window,
	};
}

/** Notion as far as the proxy can tell: plain JSON over HTTP, recording the tools it ran. */
async function fakeNotion(
	calls: string[],
	facts: NotionRequestFact[],
	diagnostics: {
		failures?: string[];
		observe?: (fact: Readonly<NotionRequestFact>) => void;
	} = {},
) {
	const failures = diagnostics.failures ?? notionProtocolFailures;
	const observe = (fact: NotionRequestFact) => diagnostics.observe?.({ ...fact });
	const server: Server = createServer((req, res) => {
		const fact: NotionRequestFact = {
			method: (req.method ?? "").slice(0, 12),
			path: ((req.url ?? "").split("?")[0] ?? "").slice(0, 80),
			completed: false,
			aborted: false,
			bodyBytes: 0,
		};
		const violate = (reason: string, status: number) => {
			fact.status = status;
			if (failures.length < 16) failures.push(`${reason}: ${JSON.stringify(fact)}`);
			res.writeHead(status).end();
		};
		if (facts.length >= 64) {
			violate("fixture request fact bound exceeded", 503);
			req.resume();
			return;
		}
		facts.push(fact);
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => {
			fact.bodyBytes += chunk.length;
			if (fact.bodyBytes <= 64 * 1024) chunks.push(chunk);
			observe(fact);
		});
		req.on("aborted", () => {
			fact.aborted = true;
			observe(fact);
		});
		req.on("error", () => {
			fact.aborted = req.aborted;
			if (!fact.aborted) violate("fixture request stream failed", 400);
		});
		req.on("end", () => {
			fact.aborted = req.aborted;
			fact.completed = req.complete && !fact.aborted;
			if (fact.aborted) return;
			// This stateless fixture supports JSON-RPC POST, not GET streams or DELETE sessions.
			if (fact.method !== "POST") {
				fact.status = 405;
				res.writeHead(405, { allow: "POST" }).end();
				return;
			}
			if (!fact.completed || fact.bodyBytes > 64 * 1024) {
				violate("invalid completed fixture POST", 400);
				return;
			}
			let message: { id?: number | string; method: string; params?: Record<string, unknown> };
			try {
				message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				if (!message || Array.isArray(message) || typeof message.method !== "string")
					throw new Error("Invalid JSON-RPC fixture request");
			} catch {
				violate("empty or invalid completed fixture POST", 400);
				return;
			}
			if (message.id === undefined) {
				fact.status = 202;
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
			fact.status = 200;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	closers.push(() => new Promise((done) => server.close(done)));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe("stateless upstream HTTP fixture protocol", () => {
	function exchange(url: string, method: string, body = "") {
		return new Promise<{ status: number | undefined; allow: string | undefined; body: string }>(
			(resolve, reject) => {
				const req = httpRequest(
					url,
					{
						method,
						headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
					},
					(res) => {
						const chunks: Buffer[] = [];
						res.on("data", (chunk: Buffer) => chunks.push(chunk));
						res.on("error", reject);
						res.on("end", () =>
							resolve({
								status: res.statusCode,
								allow: res.headers.allow,
								body: Buffer.concat(chunks).toString("utf8"),
							}),
						);
					},
				);
				req.on("error", reject);
				closers.push(async () => {
					req.destroy();
				});
				req.end(body);
			},
		);
	}

	it.each(["GET", "DELETE"])("rejects stateless %s with 405 and no tool calls", async (method) => {
		const calls: string[] = [];
		const facts: NotionRequestFact[] = [];
		const url = await fakeNotion(calls, facts);
		expect(await exchange(url, method)).toEqual({ status: 405, allow: "POST", body: "" });
		expect(facts).toEqual([
			{ method, path: "/mcp", completed: true, aborted: false, bodyBytes: 0, status: 405 },
		]);
		expect(calls).toEqual([]);
	});

	it("returns exact JSON-RPC results and acknowledges notifications without tool calls", async () => {
		const calls: string[] = [];
		const facts: NotionRequestFact[] = [];
		const url = await fakeNotion(calls, facts);
		const cases = [
			{
				message: {
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: { protocolVersion: "2025-03-26" },
				},
				result: {
					protocolVersion: "2025-03-26",
					capabilities: { tools: {} },
					serverInfo: { name: "notion", version: "1" },
				},
			},
			{ message: { jsonrpc: "2.0", id: "list", method: "tools/list" }, result: { tools: TOOLS } },
			{
				message: { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "notion-search" } },
				result: { content: [{ type: "text", text: "notion ran notion-search" }] },
			},
		];
		for (const { message, result } of cases) {
			const body = JSON.stringify(message);
			expect(await exchange(url, "POST", body)).toEqual({
				status: 200,
				allow: undefined,
				body: JSON.stringify({ jsonrpc: "2.0", id: message.id, result }),
			});
			expect(facts.at(-1)).toEqual({
				method: "POST",
				path: "/mcp",
				completed: true,
				aborted: false,
				bodyBytes: Buffer.byteLength(body),
				status: 200,
			});
			expect(calls).toEqual(message.method === "tools/call" ? ["notion-search"] : []);
		}
		const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(await exchange(url, "POST", notification)).toEqual({ status: 202, allow: undefined, body: "" });
		expect(facts.at(-1)).toEqual({
			method: "POST",
			path: "/mcp",
			completed: true,
			aborted: false,
			bodyBytes: Buffer.byteLength(notification),
			status: 202,
		});
		expect(facts).toHaveLength(4);
		expect(calls).toEqual(["notion-search"]);
	});

	it.each([
		{ name: "empty", body: "" },
		{ name: "malformed", body: "{" },
	])("rejects a $name completed POST and trips the protocol failure guard", async ({ body }) => {
		const calls: string[] = [];
		const facts: NotionRequestFact[] = [];
		// Intentional invalid inputs use a local sink; normal gateway fixtures keep the strict default.
		const failures: string[] = [];
		const url = await fakeNotion(calls, facts, { failures });
		expect(await exchange(url, "POST", body)).toEqual({ status: 400, allow: undefined, body: "" });
		const fact = {
			method: "POST",
			path: "/mcp",
			completed: true,
			aborted: false,
			bodyBytes: Buffer.byteLength(body),
			status: 400,
		};
		expect(facts).toEqual([fact]);
		expect(calls).toEqual([]);
		expect(failures).toEqual([`empty or invalid completed fixture POST: ${JSON.stringify(fact)}`]);
		// Exercise the same assertion used by afterEach, not merely the HTTP status.
		expect(() => expectNoNotionProtocolFailures(failures)).toThrowError();
		expect(failures).toEqual([]);
		expect(facts).toEqual([fact]);
		expect(calls).toEqual([]);
	});

	it("distinguishes a causally aborted incomplete POST from a malformed completed POST", async () => {
		const calls: string[] = [];
		const facts: NotionRequestFact[] = [];
		const observations: NotionRequestFact[] = [];
		let receivedBody!: () => void;
		let receivedAbort!: () => void;
		const bodyReceived = new Promise<void>((resolve) => {
			receivedBody = resolve;
		});
		const abortReceived = new Promise<void>((resolve) => {
			receivedAbort = resolve;
		});
		const url = await fakeNotion(calls, facts, {
			observe: (fact) => {
				observations.push({ ...fact });
				if (fact.aborted) receivedAbort();
				else if (fact.bodyBytes === 1) receivedBody();
			},
		});
		const responses: number[] = [];
		const req = httpRequest(url, { method: "POST", headers: { "content-length": 2 } }, (res) => {
			responses.push(res.statusCode ?? 0);
			res.resume();
		});
		const requestError = new Promise<Error>((resolve) => req.once("error", resolve));
		const closed = new Promise<void>((resolve) => req.once("close", resolve));
		closers.push(async () => {
			req.destroy();
			await closed;
		});
		req.write("{");
		// Abort only after the server has consumed the first byte, without ending the declared body.
		await bodyReceived;
		const abortError = new Error("intentional incomplete fixture request");
		req.destroy(abortError);
		const [error] = await Promise.all([requestError, abortReceived, closed]);
		expect(error).toBe(abortError);
		expect(observations).toEqual([
			{ method: "POST", path: "/mcp", completed: false, aborted: false, bodyBytes: 1 },
			{ method: "POST", path: "/mcp", completed: false, aborted: true, bodyBytes: 1 },
		]);
		expect(facts).toEqual([observations[1]]);
		expect(responses).toEqual([]);
		expect(calls).toEqual([]);
		// The default afterEach guard still applies: an abort is not a bad completed POST.
	});
});

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

describe.skipIf(!serverMode)("server mode: the engine as another user (S25.8)", () => {
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
		expectPosixMode(dataDir, 0o711);
		expectPosixMode(join(dataDir, "token"), 0o600);
		// The engine reads its identity prompt by name.
		expectPosixMode(join(dataDir, "identity.md"), 0o644);
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

describe.skipIf(!serverMode)("server mode: connector secrets encrypted at rest (S25.8)", () => {
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
		expectPosixMode(file, 0o600);
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

describe.skipIf(!serverMode)("server mode: the web PIN (S25.8)", () => {
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
		expectPosixMode(join(s.dataDir, "web-pin.json"), 0o600);
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
		// Configuration and restarts do not connect the lazy upstream or invoke a tool.
		expect(s.notionRequests).toEqual([]);
		expect(s.notionCalls).toEqual([]);
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
	it.skipIf(!serverMode)(
		"keeps app_required on the WebSocket, offers no PIN, and keeps secrets in the app",
		async () => {
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
		},
	);

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
		expectPosixMode(s.dataDir, 0o700);
		expect(s.handedOver).toEqual([]);
	});
});

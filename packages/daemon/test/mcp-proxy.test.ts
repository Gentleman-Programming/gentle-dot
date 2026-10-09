// The daemon's MCP proxy (S25.4): the engine talks to `/mcp/<connector>` with a per-launch key, and
// the daemon talks to the real server. Exercised through HTTP with pi-mcp's own client (as the engine
// connects), against in-memory, stdio, and HTTP upstreams.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type JsonRpcMessage,
	McpClient,
	McpError,
	type McpTransport,
	StreamableHttpTransport,
	type Tool,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ApprovalPreview,
	McpProxy,
	type ProxiedConnector,
	type UpstreamCredentials,
} from "../src/mcp-proxy.ts";
import { tempDir, waitFor } from "./helpers.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url));

const TOOLS: Tool[] = [
	{ name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	// Curated, but the server does not say it only reads: it is not read-only.
	{ name: "fetch", inputSchema: { type: "object" } },
	// Says it only reads, but nobody curated it.
	{ name: "peek", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "send", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
	{ name: "explode", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

type Rec = Record<string, unknown>;

/** An MCP server behind an in-memory transport: every request it got, and how often it was closed. */
function memoryUpstream() {
	const requests: { method: string; params: Rec }[] = [];
	const state = { closed: 0, connects: 0, dropNext: false };
	const answer = (method: string, params: Rec): { result?: unknown; error?: Rec } => {
		switch (method) {
			case "initialize":
				return {
					result: {
						protocolVersion: params.protocolVersion,
						capabilities: { tools: {}, resources: {}, prompts: {} },
						serverInfo: { name: "upstream", version: "1" },
					},
				};
			case "tools/list":
				return { result: { tools: TOOLS } };
			case "tools/call":
				if (params.name === "explode") return { error: { code: -32042, message: "the upstream exploded" } };
				return { result: { content: [{ type: "text", text: `ran ${String(params.name)}` }] } };
			case "resources/list":
				return { result: { resources: [{ uri: "file:///a", name: "a" }] } };
			case "resources/templates/list":
				return { result: { resourceTemplates: [{ uriTemplate: "file:///{x}", name: "x" }] } };
			case "resources/read":
				return { result: { contents: [{ uri: params.uri, text: "contents" }] } };
			case "prompts/list":
				return { result: { prompts: [{ name: "summary" }] } };
			case "prompts/get":
				return { result: { messages: [{ role: "user", content: { type: "text", text: "hi" } }] } };
			default:
				return { result: {} };
		}
	};
	const transport = (): McpTransport => {
		state.connects++;
		const { client, server } = createInMemoryTransportPair();
		server.onClose(() => {
			state.closed++;
		});
		server.onMessage((message: JsonRpcMessage) => {
			if (!("method" in message) || !("id" in message)) return;
			const params = (message.params ?? {}) as Rec;
			requests.push({ method: message.method, params });
			if (state.dropNext && message.method === "tools/call") {
				state.dropNext = false;
				void server.close();
				return;
			}
			void server.send({
				jsonrpc: "2.0",
				id: message.id,
				...answer(message.method, params),
			} as JsonRpcMessage);
		});
		void server.start();
		return client;
	};
	const called = () => requests.filter((r) => r.method === "tools/call").map((r) => r.params.name);
	return { transport, requests, called, state };
}

function connector(overrides: Partial<ProxiedConnector> = {}): ProxiedConnector {
	return {
		id: "notes",
		name: "Notes",
		enabled: true,
		mode: "read_only",
		readOnlyTools: ["search", "fetch", "explode"],
		server: { url: "https://notes.example.com/mcp" },
		revision: "r1",
		...overrides,
	};
}

const servers: Server[] = [];
const proxies: McpProxy[] = [];
const clients: McpClient[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((c) => c.close().catch(() => undefined)));
	await Promise.all(proxies.splice(0).map((p) => p.close()));
	await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

async function listen(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void) {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(
	options: {
		connectors?: ProxiedConnector[];
		approve?: (preview: ApprovalPreview) => Promise<boolean>;
		credentials?: (id: string) => Promise<UpstreamCredentials>;
		upstream?: ReturnType<typeof memoryUpstream>;
		inMemory?: boolean;
	} = {},
) {
	const views = new Map((options.connectors ?? [connector()]).map((c) => [c.id, c]));
	const upstream = options.upstream ?? memoryUpstream();
	const previews: ApprovalPreview[] = [];
	const logs: string[] = [];
	const proxy = new McpProxy({
		connector: (id) => views.get(id),
		credentials: options.credentials ?? (async () => ({})),
		approve: async (preview) => {
			previews.push(preview);
			return options.approve ? options.approve(preview) : true;
		},
		...(options.inMemory === false ? {} : { transport: upstream.transport }),
		env: process.env,
		cwd: tempDir(),
		log: (line) => logs.push(line),
	});
	proxies.push(proxy);
	const base = await listen((req, res) => proxy.handle(req, res));
	const key = proxy.rotateKey();
	/** A client like the engine's: plain streamable HTTP with the key in a header. */
	const open = async (id = "notes", withKey = key) => {
		const client = new McpClient({ name: "engine", version: "1" });
		clients.push(client);
		await client.connect(
			new StreamableHttpTransport({
				url: `${base}/mcp/${id}`,
				headers: { Authorization: `Bearer ${withKey}` },
			}),
		);
		return client;
	};
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json", ...headers },
			body: JSON.stringify(body),
		});
	return { proxy, views, upstream, previews, logs, base, key, open, post };
}

const rpc = (method: string, params: Rec = {}) => ({ jsonrpc: "2.0", id: 1, method, params });

async function rpcError(promise: Promise<unknown>): Promise<McpError> {
	const error = await promise.then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(McpError);
	return error as McpError;
}

describe("MCP proxy: the engine's side (S25.4)", () => {
	it("answers only requests carrying this launch's key in the Authorization header", async () => {
		const { post, key, proxy, upstream } = await setup();
		const noKey = await post("/mcp/notes", rpc("ping"));
		expect(noKey.status).toBe(401);
		expect(noKey.headers.get("content-type")).toMatch(/^application\/json/);
		expect((await noKey.json()) as Rec).toMatchObject({ error: { code: -32001 } });
		expect((await post("/mcp/notes", rpc("ping"), { authorization: "Bearer nope" })).status).toBe(401);
		// The key is never taken from the address.
		expect((await post(`/mcp/notes?token=${key}&key=${key}`, rpc("ping"))).status).toBe(401);
		const ok = await post("/mcp/notes", rpc("ping"), { authorization: `Bearer ${key}` });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toMatch(/^application\/json/);
		expect(await ok.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
		// A new engine launch gets a new key; the old one stops working.
		const next = proxy.rotateKey();
		expect(next).not.toBe(key);
		expect(next.length).toBeGreaterThanOrEqual(40);
		expect((await post("/mcp/notes", rpc("ping"), { authorization: `Bearer ${key}` })).status).toBe(401);
		expect((await post("/mcp/notes", rpc("ping"), { authorization: `Bearer ${next}` })).status).toBe(200);
		expect(upstream.state.connects).toBe(0);
	});

	it("speaks plain JSON: GET is 405, notifications are 202, unknown connectors and methods are errors", async () => {
		const { post, key, base } = await setup();
		const auth = { authorization: `Bearer ${key}` };
		expect((await fetch(`${base}/mcp/notes`, { headers: auth })).status).toBe(405);
		const note = await post("/mcp/notes", { jsonrpc: "2.0", method: "notifications/initialized" }, auth);
		expect(note.status).toBe(202);
		expect(await note.text()).toBe("");
		expect(((await (await post("/mcp/notes", rpc("nope/nothing"), auth)).json()) as Rec).error).toMatchObject(
			{
				code: -32601,
			},
		);
		const unknown = await post("/mcp/other", rpc("ping"), auth);
		expect(unknown.status).toBe(404);
		expect(((await unknown.json()) as Rec).error).toMatchObject({ code: -32000 });
		const broken = await fetch(`${base}/mcp/notes`, { method: "POST", headers: auth, body: "{oops" });
		expect(((await broken.json()) as Rec).error).toMatchObject({ code: -32700 });
		// A page in a browser cannot use it, even with the key.
		expect((await post("/mcp/notes", rpc("ping"), { ...auth, origin: "https://evil.example" })).status).toBe(
			403,
		);
	});

	it("is accepted by pi-mcp's client, as the engine connects, and connects upstream only when needed", async () => {
		const { open, upstream } = await setup();
		const client = await open();
		expect(client.serverCapabilities?.tools).toBeDefined();
		expect(upstream.state.connects).toBe(0);
		await client.listTools();
		expect(upstream.state.connects).toBe(1);
		await client.listTools();
		expect(upstream.state.connects).toBe(1);
	});
});

describe("MCP proxy: policy from the live connector state", () => {
	it("lists only curated tools the server marks read-only in read only, and every tool in read and send", async () => {
		const { open, views } = await setup();
		const client = await open();
		expect((await client.listTools()).map((t) => t.name)).toEqual(["search", "explode"]);
		views.set("notes", connector({ mode: "read_write" }));
		// The same connection sees the change: no engine restart.
		expect((await client.listTools()).map((t) => t.name)).toEqual([
			"search",
			"fetch",
			"peek",
			"send",
			"explode",
		]);
		views.set("notes", connector({ mode: "read_only" }));
		expect((await client.listTools()).map((t) => t.name)).toEqual(["search", "explode"]);
	});

	it("refuses hidden and unknown tools even when called directly, and forwards nothing", async () => {
		const { open, upstream, previews } = await setup();
		const client = await open();
		for (const name of ["send", "peek", "fetch"]) {
			const error = await rpcError(client.callTool(name, { to: "x" }));
			expect(error.code).toBe(-32602);
			expect(error.message).toContain("read only");
		}
		const unknown = await rpcError(client.callTool("format_disk", {}));
		expect(unknown.code).toBe(-32602);
		expect(unknown.message).toContain("format_disk");
		expect(upstream.called()).toEqual([]);
		expect(previews).toEqual([]);
		// A read-only call runs without asking.
		expect(await client.callTool("search", { q: "x" })).toEqual({
			content: [{ type: "text", text: "ran search" }],
		});
		expect(upstream.called()).toEqual(["search"]);
		expect(previews).toEqual([]);
	});

	it("asks once with the full preview before a sending action, and forwards nothing when declined", async () => {
		let allow = false;
		const { open, upstream, previews } = await setup({
			connectors: [connector({ mode: "read_write" })],
			approve: async () => allow,
		});
		const client = await open();
		const long = "x".repeat(10_000);
		const args = { to: "team@example.com", body: long, nested: { list: [1, 2, 3] } };
		const declined = await rpcError(client.callTool("send", args));
		expect(declined.message).toMatch(/did not allow/);
		expect(previews).toEqual([{ connectorId: "notes", connector: "Notes", tool: "send", arguments: args }]);
		expect(upstream.called()).toEqual([]);
		allow = true;
		expect(await client.callTool("send", args)).toEqual({ content: [{ type: "text", text: "ran send" }] });
		expect(previews).toHaveLength(2);
		expect(upstream.requests.find((r) => r.method === "tools/call")?.params).toEqual({
			name: "send",
			arguments: args,
		});
		// Read-only tools never ask, in either mode.
		await client.callTool("search", {});
		expect(previews).toHaveLength(2);
	});

	it("refuses when asking fails, and when the connector changed while the user was asked", async () => {
		const state: { fail: boolean; views?: Map<string, ProxiedConnector> } = { fail: true };
		const { open, upstream, views } = await setup({
			connectors: [connector({ mode: "read_write" })],
			approve: async () => {
				if (state.fail) throw new Error("no window");
				state.views?.set("notes", connector({ mode: "read_only" }));
				return true;
			},
		});
		state.views = views;
		const client = await open();
		expect((await rpcError(client.callTool("send", {}))).message).toMatch(/could not be asked|approval/i);
		state.fail = false;
		// Approved, but the user switched the connector to read only meanwhile.
		expect((await rpcError(client.callTool("send", {}))).message).toContain("read only");
		expect(upstream.called()).toEqual([]);
	});

	it("shows resources and prompts in read and send, and in read only only for a connector with a curated list", async () => {
		const { open, views, upstream } = await setup();
		const client = await open();
		expect(client.serverCapabilities?.resources).toBeDefined();
		expect(await client.listResources()).toEqual([{ uri: "file:///a", name: "a" }]);
		expect(await client.listResourceTemplates()).toHaveLength(1);
		expect((await client.readResource("file:///a")).contents).toHaveLength(1);
		expect(await client.request("prompts/list")).toEqual({ prompts: [{ name: "summary" }] });
		expect(await client.request("prompts/get", { name: "summary" })).toMatchObject({
			messages: [{ role: "user" }],
		});
		// A server of the user's own (no curated list) in read only exposes nothing.
		views.set("notes", connector({ readOnlyTools: [] }));
		const before = upstream.requests.length;
		expect(await client.listResources()).toEqual([]);
		expect(await client.listResourceTemplates()).toEqual([]);
		expect(await client.request("prompts/list")).toEqual({ prompts: [] });
		expect((await rpcError(client.readResource("file:///a"))).code).toBe(-32602);
		expect((await rpcError(client.request("prompts/get", { name: "summary" }))).code).toBe(-32602);
		expect(await client.listTools()).toEqual([]);
		expect(upstream.requests.slice(before).filter((r) => r.method !== "tools/list")).toEqual([]);
		views.set("notes", connector({ readOnlyTools: [], mode: "read_write" }));
		expect(await client.listResources()).toHaveLength(1);
	});

	it("refuses everything for a connector that is turned off", async () => {
		const { open, views, upstream } = await setup();
		const client = await open();
		views.set("notes", connector({ enabled: false }));
		const error = await rpcError(client.listTools());
		expect(error.message).toContain("turned off");
		expect(upstream.state.connects).toBe(0);
	});
});

describe("MCP proxy: upstream connections", () => {
	it("passes the upstream's errors on, and reconnects after the upstream dropped", async () => {
		const { open, upstream, logs } = await setup();
		const client = await open();
		const failed = await rpcError(client.callTool("explode", {}));
		expect([failed.code, failed.message]).toEqual([-32042, "the upstream exploded"]);
		upstream.state.dropNext = true;
		const dropped = await rpcError(client.callTool("search", {}));
		expect(dropped.message).toMatch(/could not reach notes|Notes/i);
		expect(upstream.state.connects).toBe(1);
		expect(await client.callTool("search", {})).toMatchObject({ content: [{ text: "ran search" }] });
		expect(upstream.state.connects).toBe(2);
		expect(logs.join("\n")).not.toContain("Bearer");
	});

	it("closes a connector's upstream when it is removed, turned off, or its server changed, and all of them on close", async () => {
		const { open, views, upstream, proxy } = await setup();
		const client = await open();
		await client.listTools();
		proxy.sync();
		expect(upstream.state.closed).toBe(0);
		views.set("notes", connector({ mode: "read_write" }));
		proxy.sync();
		// A mode change keeps the connection.
		expect(upstream.state.closed).toBe(0);
		views.set("notes", connector({ revision: "r2" }));
		proxy.sync();
		await waitFor(() => upstream.state.closed === 1);
		await client.listTools();
		views.set("notes", connector({ enabled: false }));
		proxy.sync();
		await waitFor(() => upstream.state.closed === 2);
		views.set("notes", connector());
		await client.listTools();
		views.delete("notes");
		proxy.sync();
		await waitFor(() => upstream.state.closed === 3);
		views.set("notes", connector());
		await client.listTools();
		await proxy.close();
		await waitFor(() => upstream.state.closed === 4);
	});

	it("runs a stdio server itself, with the environment from the credentials, and stops it when removed", async () => {
		const dir = tempDir();
		const calls = join(dir, "calls.jsonl");
		const pidFile = join(dir, "pid");
		const stdio = connector({
			id: "chat",
			name: "Chat",
			mode: "read_write",
			readOnlyTools: ["list_messages"],
			server: { command: process.execPath, args: [FAKE_SERVER] },
		});
		const { open, views, proxy, previews } = await setup({
			connectors: [stdio],
			inMemory: false,
			credentials: async (id) => {
				expect(id).toBe("chat");
				return { env: { FAKE_MCP_SERVER_CALLS: calls, FAKE_MCP_SERVER_PID_FILE: pidFile } };
			},
		});
		const client = await open("chat");
		expect((await client.listTools()).map((t) => t.name)).toEqual([
			"list_messages",
			"notion-search",
			"send_message",
		]);
		expect(await client.callTool("list_messages", {})).toMatchObject({
			content: [{ text: "ran list_messages" }],
		});
		await client.callTool("send_message", { to: "a", body: "b" });
		expect(previews.map((p) => p.tool)).toEqual(["send_message"]);
		expect(
			readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.map((l) => JSON.parse(l).name),
		).toEqual(["list_messages", "send_message"]);
		const pid = Number(readFileSync(pidFile, "utf8"));
		const alive = () => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		expect(alive()).toBe(true);
		views.delete("chat");
		proxy.sync();
		await waitFor(() => !alive());
	});

	it("talks to a remote server over HTTP with the headers and token from the credentials", async () => {
		const seen: { authorization?: string; team?: string; method: string }[] = [];
		const upstreamUrl = await listen((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				if (req.method !== "POST") {
					res.writeHead(405).end();
					return;
				}
				const message = JSON.parse(body) as { id?: number; method: string; params?: Rec };
				seen.push({
					authorization: req.headers.authorization,
					team: req.headers["x-team"] as string | undefined,
					method: message.method,
				});
				if (message.id === undefined) {
					res.writeHead(202).end();
					return;
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: message.params?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "remote", version: "1" },
							}
						: message.method === "tools/list"
							? { tools: TOOLS }
							: { content: [{ type: "text", text: "remote ran" }] };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		});
		const { open } = await setup({
			connectors: [connector({ server: { url: `${upstreamUrl}/mcp` } })],
			inMemory: false,
			credentials: async () => ({
				headers: { "X-Team": "blue" },
				authProvider: { token: async () => "upstream-access-token" },
			}),
		});
		const client = await open();
		expect(await client.callTool("search", {})).toMatchObject({ content: [{ text: "remote ran" }] });
		expect(seen.length).toBeGreaterThan(0);
		for (const request of seen) {
			expect(request.authorization).toBe("Bearer upstream-access-token");
			expect(request.team).toBe("blue");
		}
		expect(seen.map((r) => r.method)).toContain("tools/call");
	});

	it("says the user must sign in again when the upstream refuses the credentials", async () => {
		const upstreamUrl = await listen((req, res) => {
			req.resume();
			res.writeHead(401, { "content-type": "application/json" }).end("{}");
		});
		const { open } = await setup({
			connectors: [connector({ server: { url: `${upstreamUrl}/mcp` } })],
			inMemory: false,
		});
		const client = await open();
		const error = await rpcError(client.listTools());
		expect(error.message).toMatch(/sign in/i);
	});
});

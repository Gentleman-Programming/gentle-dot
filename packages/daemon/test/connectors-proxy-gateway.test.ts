// The MCP proxy inside the daemon, end to end with the fake agent (S25.4): the engine's mcp.json
// leads to the daemon, a read-only call runs without asking, and a sending action is asked once in
// the desktop app's native dialog (S25.3); windows only see that it waits there. Declined, not
// answered, or the app gone: it never reaches the server.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, type McpError, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import { APP_REQUIRED, type ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
/** What the fake sign-in command stores (see fixtures/fake-mcp-cli.ts). */
const SIGNED_IN_TOKEN = "fake-access-token-value";

const TOOLS: Tool[] = [
	{ name: "notion-search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "notion-create-pages", inputSchema: { type: "object" } },
];

type Rec = Record<string, unknown>;

const daemons: DotDaemon[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** Notion's server, as far as the proxy can tell: plain JSON over HTTP, recording every request. */
async function fakeNotion() {
	const seen: { authorization?: string; method: string; params?: Rec }[] = [];
	const server: Server = createServer((req, res) => {
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
			seen.push({ authorization: req.headers.authorization, method: message.method, params: message.params });
			if (message.id === undefined) {
				res.writeHead(202).end();
				return;
			}
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
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
	const calls = () => seen.filter((r) => r.method === "tools/call").map((r) => r.params?.name);
	return { url, seen, calls };
}

async function setup() {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const notion = await fakeNotion();
	const fake = fakeAuthRuntime();
	const app = fakeApp([], "allow");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome,
		backoffMs: [50],
		agentEnv: { ...process.env, FAKE_MCP_CLI_MODE: "auto" },
		authRuntime: async () => fake.runtime,
		connectorCli: { command: process.execPath, args: [FAKE_CLI] },
		// The real credentials, sent to a stand-in for Notion's address.
		connectorTransport: (_connector, credentials) =>
			new StreamableHttpTransport({
				url: notion.url,
				...(credentials.headers ? { headers: credentials.headers } : {}),
				...(credentials.authProvider ? { authProvider: credentials.authProvider } : {}),
				openGetStream: false,
			}),
		appChannel: app.daemonEnd,
		// The app declines on its own after 120 s; a short wait here stands in for that.
		approvalWaitMs: 1000,
	});
	daemons.push(d);
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	closers.push(async () => ws.close());
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
	const clientId = ready.type === "ready" ? (ready.clientId ?? "") : "";
	const send = sendLikeThePanel(
		app,
		() => clientId,
		(m) => ws.send(JSON.stringify(m)),
	);
	const raw = (m: object) => ws.send(JSON.stringify(m));
	const mcpText = () => readFileSync(join(agentHome, "mcp.json"), "utf8");
	/** Connects to a server of the engine's mcp.json exactly as the engine would: its URL and headers. */
	const engineClient = async (id: string) => {
		const entry = JSON.parse(mcpText()).mcpServers[id] as { url: string; headers: Record<string, string> };
		const client = new McpClient({ name: "engine", version: "1" });
		closers.push(() => client.close());
		await client.connect(new StreamableHttpTransport({ url: entry.url, headers: entry.headers }));
		return client;
	};
	const closeWindow = () =>
		new Promise<void>((done) => {
			ws.once("close", () => done());
			ws.close();
		});
	return { d, dataDir, agentHome, notion, app, messages, send, raw, mcpText, engineClient, closeWindow };
}

describe("connectors through the daemon's proxy (regression, S25.4)", () => {
	it("connects, then a read-only call reaches the server with the stored sign-in without asking", async () => {
		const { d, notion, app, send, messages, mcpText, engineClient } = await setup();
		const pid = d.supervisor.pid;
		send({ type: "connector_connect", connectorId: "notion" });
		await waitFor(() => messages.find((m) => m.type === "auth_done" && m.ok));
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
		await waitFor(() => JSON.parse(mcpText()).mcpServers.notion);
		const text = mcpText();
		expect(JSON.parse(text).mcpServers.notion.url).toBe(`http://127.0.0.1:${d.port}/mcp/notion`);
		expect(text).not.toContain(SIGNED_IN_TOKEN);
		expect(text).not.toContain("mcp.notion.com");
		const client = await engineClient("notion");
		// Read only: only the curated read-only tool.
		expect((await client.listTools()).map((t) => t.name)).toEqual(["notion-search"]);
		expect(await client.callTool("notion-search", { query: "plans" })).toEqual({
			content: [{ type: "text", text: "notion ran notion-search" }],
		});
		expect(notion.calls()).toEqual(["notion-search"]);
		for (const request of notion.seen) expect(request.authorization).toBe(`Bearer ${SIGNED_IN_TOKEN}`);
		// Only connecting it was confirmed.
		expect(app.asked.map((a) => a.title)).toEqual(["Connect Notion?"]);
		expect(messages.filter((m) => m.type === "ask")).toHaveLength(1);
	});

	it("asks the app once before a sending action: declined or unanswered sends nothing, allowed runs it, and windows cannot answer", async () => {
		const { d, notion, app, send, raw, messages, mcpText, engineClient } = await setup();
		send({ type: "connector_connect", connectorId: "notion" });
		await waitFor(() => messages.find((m) => m.type === "auth_done" && m.ok));
		const pid = d.supervisor.pid;
		send({ type: "connector_mode", connectorId: "notion", mode: "read_write" });
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
		const oldKey = JSON.parse(mcpText()).mcpServers.notion.headers.Authorization;
		const client = await engineClient("notion");
		expect((await client.listTools()).map((t) => t.name)).toEqual(["notion-search", "notion-create-pages"]);
		const args = { content: "x".repeat(9000), title: "Plan", parent: "Team space" };
		const refusal = (call: Promise<unknown>) =>
			call.then(
				() => undefined,
				(e: unknown) => e as McpError,
			);
		const asked = app.asked.length;

		// No answer: windows see that it waits in the app, and answering there does nothing.
		app.answer("hang");
		const unanswered = refusal(client.callTool("notion-create-pages", args));
		const ask = await waitFor(() =>
			messages.find((m) => m.type === "ask" && m.ask.title === "Allow Notion to create pages?"),
		);
		if (ask.type !== "ask") throw new Error("not an ask");
		expect(ask.ask).toEqual({
			requestId: expect.any(String),
			method: "app",
			title: "Allow Notion to create pages?",
			message: "Waiting for your answer in the Gentle Dot app.",
		});
		await waitFor(() => d.bridge.agentState === "needs_you");
		raw({ type: "ui_response", requestId: ask.ask.requestId, confirmed: true });
		await waitFor(() => messages.find((m) => m.type === "error" && m.code === "app_required"));
		expect((await unanswered)?.message).toMatch(/did not allow/);
		expect(notion.calls()).toEqual([]);
		await waitFor(() => messages.find((m) => m.type === "ask_resolved" && m.requestId === ask.ask.requestId));
		// The app showed the full preview, key fields first (in the order the agent gave them).
		expect(app.asked[asked]).toEqual({
			connector: "Notion",
			action: "create pages",
			preview: [
				{ name: "title", value: "Plan" },
				{ name: "parent", value: "Team space" },
				{ name: "content", value: args.content },
			],
		});

		app.answer("decline");
		expect((await refusal(client.callTool("notion-create-pages", args)))?.message).toMatch(/did not allow/);
		expect(notion.calls()).toEqual([]);

		app.answer("allow");
		expect(await client.callTool("notion-create-pages", args)).toMatchObject({
			content: [{ text: "notion ran notion-create-pages" }],
		});
		expect(notion.calls()).toEqual(["notion-create-pages"]);
		expect(app.asked).toHaveLength(asked + 3);

		// The next engine launch gets a new key; the old one no longer works.
		const restarted = d.supervisor.pid;
		send({ type: "connector_mode", connectorId: "notion", mode: "read_only" });
		await waitFor(() => d.supervisor.pid !== restarted && d.supervisor.state === "ready");
		const newKey = JSON.parse(mcpText()).mcpServers.notion.headers.Authorization;
		expect(newKey).not.toBe(oldKey);
		const stale = await fetch(`http://127.0.0.1:${d.port}/mcp/notion`, {
			method: "POST",
			headers: { authorization: oldKey, "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(stale.status).toBe(401);
	});

	it("refuses a sending action when the app quits while asking, and when there is no app", async () => {
		const { d, notion, app, send, raw, messages, engineClient } = await setup();
		send({ type: "connector_connect", connectorId: "notion" });
		await waitFor(() => messages.find((m) => m.type === "auth_done" && m.ok));
		const pid = d.supervisor.pid;
		send({ type: "connector_mode", connectorId: "notion", mode: "read_write" });
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
		const client = await engineClient("notion");
		const failure = (call: Promise<unknown>) =>
			call.then(
				() => undefined,
				(e: unknown) => e as McpError,
			);

		app.answer("hang");
		const pending = failure(client.callTool("notion-create-pages", { title: "x" }));
		await waitFor(() =>
			messages.find((m) => m.type === "ask" && m.ask.title === "Allow Notion to create pages?"),
		);
		app.close();
		expect((await pending)?.message).toMatch(/did not allow/);

		expect((await failure(client.callTool("notion-create-pages", { title: "y" })))?.message).toMatch(
			/approval/,
		);
		expect(notion.calls()).toEqual([]);
		// And a window cannot turn it back on or change it without the app.
		raw({ type: "connector_mode", connectorId: "notion", mode: "read_only" });
		await waitFor(() => messages.find((m) => m.type === "error" && m.message === APP_REQUIRED));
	});
});

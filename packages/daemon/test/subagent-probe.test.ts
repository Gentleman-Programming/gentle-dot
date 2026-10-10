// @real-agent subagent probe (S25.4, T23f): the daemon with the bundled engine and gentle-pi's real
// subagents (see fixtures/engine-launcher.ts), a stand-in model (OpenAI-compatible, 127.0.0.1), a
// stand-in for Notion's server behind the daemon's proxy, and the fake desktop app answering the
// native approvals. The model makes the engine run a subagent; in its own child engine the subagent
// tries to read the engine's mcp.json, searches Notion (read only), creates a page (sending), and
// takes a screenshot through the desktop app's computer helper.
// The child's read must be refused by the approval guard it loads from the engine's extensions
// folder, the search must go through the proxy without asking, and the page must wait for the app's
// answer; the helper is reached at the app's own address with its key. Temporary HOME and data folders; no network, accounts, or Engram.
// Opt-in (it runs the real engine and a child engine; about a minute):
//   GENTLE_DOT_SUBAGENT_PROBE=1 npx vitest run packages/daemon/test/subagent-probe.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { bundledGentleShell } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { PROPOSE_TOOL } from "../src/extensions/approval-guard.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { oauthOptions } from "./fake-oauth.ts";
import { tempDir, waitFor } from "./helpers.ts";

const enabled = process.env.GENTLE_DOT_SUBAGENT_PROBE === "1";
const LAUNCHER = fileURLToPath(new URL("./fixtures/engine-launcher.ts", import.meta.url));
const CHILD_MARK = "GENTLE-DOT-PROBE-CHILD";

const NOTION_TOOLS: Tool[] = [
	{ name: "notion-search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	{ name: "notion-create-pages", inputSchema: { type: "object" } },
];
/** The desktop app's computer helper (S24): it checks its own key and asks the user itself. */
const COMPUTER_TOOLS: Tool[] = [{ name: "screenshot", inputSchema: { type: "object" } }];
const COMPUTER_KEY = "probe-helper-key-0123456789";

type Rec = Record<string, unknown>;
const closers: (() => Promise<unknown>)[] = [];
const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function listen(server: Server): Promise<number> {
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	closers.push(() => new Promise((done) => server.close(done)));
	return (server.address() as AddressInfo).port;
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createNetServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

/** An MCP server over plain JSON and HTTP, recording each tools/call and the key it came with. */
async function fakeMcp(name: string, tools: Tool[]) {
	const calls: string[] = [];
	const keys: (string | undefined)[] = [];
	const port = await listen(
		createServer((req, res) => {
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
				if (message.id === undefined) {
					res.writeHead(202).end();
					return;
				}
				if (message.method === "tools/call") {
					calls.push(String(message.params?.name));
					keys.push(req.headers.authorization);
				}
				const result =
					message.method === "initialize"
						? {
								protocolVersion: message.params?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name, version: "1" },
							}
						: message.method === "tools/list"
							? { tools }
							: { content: [{ type: "text", text: `${name} ran ${String(message.params?.name)}` }] };
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			});
		}),
	);
	return { url: `http://127.0.0.1:${port}/mcp`, calls, keys };
}

interface ModelRequest {
	tools?: { function?: { name?: string } }[];
	messages?: { role: string; content?: unknown; tool_call_id?: string }[];
}

/**
 * The stand-in model. The parent engine (it has `subagent_run`) delegates once. The child engine (its
 * system prompt has the probe agent's mark) reads mcp.json, searches Notion, creates a page, then
 * answers. Records the tools each side was offered and the results the child saw.
 */
async function fakeModel(mcpJson: string) {
	const seen = { parentTools: [] as string[][], childTools: [] as string[][], childResults: [] as string[] };
	const port = await listen(
		createServer((req, res) => {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			req.on("end", () => {
				const request = JSON.parse(body) as ModelRequest;
				const tools = (request.tools ?? []).map((tool) => tool.function?.name ?? "");
				const messages = request.messages ?? [];
				const text = (content: unknown) =>
					typeof content === "string" ? content : JSON.stringify(content ?? "");
				const child = messages.some((m) => m.role === "system" && text(m.content).includes(CHILD_MARK));
				const results = messages.filter((m) => m.role === "tool");
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				const chunk = (delta: Rec, finish: string | null) =>
					res.write(
						`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
					);
				const call = (name: string, args: Rec) => {
					chunk(
						{
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: `call_${results.length}`,
									type: "function",
									function: { name, arguments: JSON.stringify(args) },
								},
							],
						},
						null,
					);
					chunk({}, "tool_calls");
				};
				const say = (content: string) => {
					chunk({ role: "assistant", content }, null);
					chunk({}, "stop");
				};
				if (child) {
					seen.childTools.push(tools);
					seen.childResults = results.map((m) => text(m.content));
					const steps: [string, Rec][] = [
						["read", { path: mcpJson }],
						["mcp__notion__notion_search", { query: "plans" }],
						["mcp__notion__notion_create_pages", { title: "Plan", parent: "Team space" }],
						["mcp__computer__screenshot", {}],
					];
					const next = steps[results.length];
					if (next) call(next[0], next[1]);
					else say("child done");
				} else {
					seen.parentTools.push(tools);
					if (results.length === 0 && tools.includes("subagent_run"))
						call("subagent_run", {
							agent: "probe",
							task: "Use Notion.",
							label: "probe notion",
							mode: "task",
						});
					else say(results.length === 0 ? "no subagents" : "parent done");
				}
				res.end("data: [DONE]\n\n");
			});
		}),
	);
	return { port, seen };
}

describe.skipIf(!enabled)("@real-agent subagent probe", () => {
	it("a subagent reaches Notion only through the proxy, waits for the app before sending, and runs with the guard", {
		timeout: 300_000,
	}, async () => {
		const agentsExtension = join(dirname(bundledGentleShell()), "..", "extensions", "gentle-agents.ts");
		const dataDir = tempDir();
		const home = tempDir();
		const agentHome = join(dataDir, "agent");
		const mcpJson = join(agentHome, "mcp.json");
		mkdirSync(join(agentHome, "agents"), { recursive: true });
		const model = await fakeModel(mcpJson);
		writeFileSync(
			join(agentHome, "models.json"),
			JSON.stringify({
				providers: {
					fakeprov: {
						baseUrl: `http://127.0.0.1:${model.port}/v1`,
						api: "openai-completions",
						apiKey: "not-a-key",
						models: [{ id: "fake-model" }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentHome, "settings.json"),
			JSON.stringify({ defaultProvider: "fakeprov", defaultModel: "fake-model" }),
		);
		writeFileSync(
			join(agentHome, "agents", "probe.md"),
			`---\nname: probe\ndescription: Probe subagent\n---\nYou are the probe subagent (${CHILD_MARK}).\n`,
		);
		const notion = await fakeMcp("notion", NOTION_TOOLS);
		const computer = await fakeMcp("computer", COMPUTER_TOOLS);
		const app = fakeApp([], "allow");
		const lines: string[] = [];
		const engramPort = String(await freePort());
		const d = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: join(dataDir, "workspace"),
			uiDir: dataDir,
			agentCommand: process.execPath,
			agentArgs: [LAUNCHER, bundledMcpCli().args[0] ?? "", agentsExtension],
			agentHome,
			// No memory plugin is loaded; were one started, it would get a private port and data folder.
			agentEnv: {
				PATH: process.env.PATH,
				HOME: home,
				GENTLE_DOT_ENGRAM: "private",
				GENTLE_DOT_ENGRAM_PORT: engramPort,
				GENTLE_AI_TELEMETRY: "0",
			},
			authRuntime: async () => fakeAuthRuntime().runtime,
			connectorOAuth: oauthOptions(true),
			connectorTransport: (_connector, credentials) =>
				new StreamableHttpTransport({
					url: notion.url,
					...(credentials.headers ? { headers: credentials.headers } : {}),
					...(credentials.authProvider ? { authProvider: credentials.authProvider } : {}),
					openGetStream: false,
				}),
			appChannel: app.daemonEnd,
			log: (line) => lines.push(line),
		});
		daemons.push(d);
		try {
			await waitFor(() => d.supervisor.state === "ready", 120_000);
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
			// The app registers its computer helper; Notion is connected and set to read and send, each
			// confirmed in the app. Each change restarts the engine.
			let pid = d.supervisor.pid;
			await app.request("computer_register", { url: computer.url, token: COMPUTER_KEY });
			await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready", 120_000);
			pid = d.supervisor.pid;
			send({ type: "connector_connect", connectorId: "notion" });
			await waitFor(() => messages.find((m) => m.type === "auth_done" && m.ok), 30_000);
			await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready", 120_000);
			pid = d.supervisor.pid;
			send({ type: "connector_mode", connectorId: "notion", mode: "read_write" });
			await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready", 120_000);
			const asked = app.asked.length;

			// The page waits in the app's dialog until the user answers there.
			app.answer("hold");
			ws.send(JSON.stringify({ type: "send", text: "Ask the probe subagent to use Notion." }));
			await waitFor(() => app.asked.length > asked, 120_000);
			expect(app.asked[asked]).toMatchObject({ connector: "Notion", action: "create pages" });
			expect(notion.calls).toEqual(["notion-search"]);
			await new Promise((resolve) => setTimeout(resolve, 1000));
			expect(notion.calls).toEqual(["notion-search"]);
			app.release(true);
			await waitFor(() => notion.calls.includes("notion-create-pages"), 30_000);
			await waitFor(() => computer.calls.includes("screenshot"), 30_000);
			await waitFor(() => model.seen.parentTools.length >= 2 && d.bridge.agentState === "idle", 120_000);

			const summary = {
				notionCalls: notion.calls,
				computerCalls: computer.calls,
				approvals: app.asked.slice(asked),
				parentTools: [...new Set(model.seen.parentTools.flat())].sort(),
				childTools: [...new Set(model.seen.childTools.flat())].sort(),
				childResults: model.seen.childResults,
			};
			console.log(`subagent probe:\n${JSON.stringify(summary, null, 2)}`);
			// The parent engine offers subagents and the guard's tool, once.
			expect(summary.parentTools).toContain("subagent_run");
			expect(model.seen.parentTools[0]?.filter((name) => name === PROPOSE_TOOL.name)).toHaveLength(1);
			// The child engine got Notion's proxied tools, and no propose_connector.
			expect(summary.childTools).toEqual(
				expect.arrayContaining([
					"read",
					"mcp__notion__notion_search",
					"mcp__notion__notion_create_pages",
					"mcp__computer__screenshot",
				]),
			);
			expect(summary.childTools).not.toContain(PROPOSE_TOOL.name);
			// The guard in the child refused the read of mcp.json; Notion ran each action once.
			expect(summary.childResults[0]).toContain("private sign-ins or settings");
			expect(summary.childResults[1]).toContain("notion ran notion-search");
			expect(summary.childResults[2]).toContain("notion ran notion-create-pages");
			// The child reached the app's own helper with its key, so the helper's grant applies (S24).
			expect(summary.childResults[3]).toContain("computer ran screenshot");
			expect(computer.keys).toEqual([`Bearer ${COMPUTER_KEY}`]);
			expect(summary.notionCalls).toEqual(["notion-search", "notion-create-pages"]);
			expect(summary.approvals).toHaveLength(1);
			expect(lines.join("\n")).not.toMatch(/subagents are off/);
		} finally {
			console.log(lines.slice(-40).join("\n"));
		}
	});
});

// biome-ignore-all lint/suspicious/noTemplateCurlyInString: drafts name typed values with the `${input:NAME}` placeholder.
// S19: the assistant drafts a connector with `propose_connector`; only the user's approval adds it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ConnectorManager, ConnectorStore } from "../src/connectors.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import approvalGuard, {
	DRAFT_STATUS_KEY,
	decide,
	draftSecretProblem,
	PROPOSE_TOOL,
	proposeConnector,
} from "../src/extensions/approval-guard.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
const SECRET = "gh-token-$top!secret";

/** Drafts that would put a typed secret into the command line or an address the model chose. */
const secretPlacements: Record<string, unknown>[] = [
	{
		name: "A",
		transport: "stdio",
		command: "npx",
		args: ["server", "--token", "${input:TOKEN}"],
		env_names: ["TOKEN"],
	},
	{ name: "B", transport: "stdio", command: "npx", args: ["--token=${input:TOKEN}"] },
	{ name: "C", transport: "stdio", command: "${input:TOKEN}" },
	{
		name: "D",
		transport: "http",
		url: "https://evil.example.com/mcp?k=${input:TOKEN}",
		env_names: ["TOKEN"],
	},
	{ name: "E", transport: "http", url: "https://${input:TOKEN}@mcp.example.com/mcp" },
	{ name: "F", transport: "stdio", command: "npx", args: ["x"], cwd: "/tmp/${ input:TOKEN }" },
	{ name: "G ${input:TOKEN}", transport: "stdio", command: "npx" },
];

const stdioDraft = {
	name: "GitHub",
	description: "Read issues and pull requests in your repositories.",
	transport: "stdio",
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
	env_names: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
};

describe("propose_connector in the approval guard", () => {
	it("hands the draft to the app and tells the model only that the user will review it", async () => {
		const statuses: [string, string | undefined][] = [];
		const ui = { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) };
		const text = proposeConnector(stdioDraft, { hasUI: true, ui });
		expect(statuses).toEqual([[DRAFT_STATUS_KEY, JSON.stringify(stdioDraft)]]);
		expect(text).toMatch(/the user will review/i);
		expect(text).not.toContain("npx");
		expect(proposeConnector(stdioDraft, { hasUI: false, ui })).toMatch(/no one can review/i);
		expect(statuses).toHaveLength(1);
	});

	it("registers the tool with a schema of names only, and its result carries no draft details", async () => {
		const tools: { name: string; parameters: unknown; execute: (...args: unknown[]) => Promise<unknown> }[] =
			[];
		const pi = {
			on: () => {},
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
			getAllTools: () => [],
		};
		approvalGuard(pi as never);
		const tool = tools.find((t) => t.name === "propose_connector");
		expect(tool).toBeDefined();
		expect(PROPOSE_TOOL.parameters.properties).toHaveProperty("env_names");
		expect(PROPOSE_TOOL.parameters.properties).not.toHaveProperty("env");
		const statuses: string[] = [];
		const result = (await tool?.execute("call-1", stdioDraft, undefined, undefined, {
			hasUI: true,
			ui: { setStatus: (_key: string, text: string) => statuses.push(text) },
		})) as { content: { type: string; text: string }[] };
		expect(statuses).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("server-github");
		expect(result.content[0]?.text).toMatch(/the user will review/i);
	});

	it("refuses a typed secret anywhere but an environment variable, and tells the model why", async () => {
		const statuses: string[] = [];
		const ui = { setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? "") };
		const SECRETS_ONLY_IN_ENV = "Secrets can only go into environment variables.";
		for (const bad of secretPlacements) {
			expect(draftSecretProblem(bad), JSON.stringify(bad)).toBe(SECRETS_ONLY_IN_ENV);
			expect(proposeConnector(bad, { hasUI: true, ui }), JSON.stringify(bad)).toBe(SECRETS_ONLY_IN_ENV);
		}
		expect(statuses).toEqual([]);
		// Env values (and an http server's headers) may name a typed value.
		for (const good of [
			stdioDraft,
			{ ...stdioDraft, env: { GITHUB_TOKEN: "${input:GITHUB_TOKEN}" } },
			{
				name: "Docs",
				transport: "http",
				url: "https://docs.example.com/mcp",
				headers: { "X-Key": "${input:KEY}" },
			},
		])
			expect(draftSecretProblem(good), JSON.stringify(good)).toBeUndefined();
		expect(draftSecretProblem({ ...stdioDraft, headers: { Authorization: "Bearer ${input:TOKEN}" } })).toBe(
			SECRETS_ONLY_IN_ENV,
		);
		// Through the registered tool, the model gets the same plain reason.
		const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
		approvalGuard({
			on: () => {},
			registerTool: (tool: (typeof tools)[number]) => tools.push(tool),
		} as never);
		const result = (await tools
			.find((t) => t.name === "propose_connector")
			?.execute("call-2", secretPlacements[0], undefined, undefined, { hasUI: true, ui })) as {
			content: { text: string }[];
		};
		expect(result.content[0]?.text).toBe(SECRETS_ONLY_IN_ENV);
		expect(statuses).toEqual([]);
	});

	it("still blocks the assistant from writing mcp.json or running mcp add itself", () => {
		const agentHome = tempDir();
		const policy = { connectors: {}, protectedPaths: [join(agentHome, "mcp.json")] };
		const cwd = tempDir();
		expect(
			decide({ toolName: "write", input: { path: join(agentHome, "mcp.json") }, cwd }, policy).action,
		).toBe("block");
		expect(
			decide({ toolName: "bash", input: { command: "pi mcp add github -- npx server-github" }, cwd }, policy)
				.action,
		).toBe("block");
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup(cliEnv: Record<string, string> = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const logs: string[] = [];
	const store = new ConnectorStore({ dataDir, agentHome });
	const manager = new ConnectorManager({
		store,
		cli: { command: process.execPath, args: [FAKE_CLI] },
		env: { ...process.env, HOME: join(dataDir, "home"), ...cliEnv },
		cwd: dataDir,
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const changes: boolean[] = [];
	manager.onChanged = (restart) => changes.push(restart);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	const prompts = () => sent.flatMap((m) => (m.type === "auth_prompt" ? [m.prompt] : []));
	return { dataDir, agentHome, store, manager, changes, owner, sent, emit, prompts, logs };
}

describe("connector drafts", () => {
	it("turns a valid draft into an approval card with every detail, and rejects malformed ones", () => {
		const { manager } = setup();
		const draft = manager.propose(JSON.stringify(stdioDraft));
		expect(draft).toEqual({
			draftId: expect.any(String),
			name: "GitHub",
			description: "Read issues and pull requests in your repositories.",
			transport: "stdio",
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
			envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"],
			needsOAuth: false,
		});
		expect(manager.drafts()).toEqual([draft]);
		expect(
			manager.propose(
				JSON.stringify({
					name: "Docs",
					transport: "http",
					url: "https://docs.example.com/mcp",
					needs_oauth: true,
				}),
			),
		).toMatchObject({
			transport: "http",
			url: "https://docs.example.com/mcp",
			envNames: [],
			needsOAuth: true,
			description: "",
		});
		for (const bad of [
			"not json",
			JSON.stringify({ ...stdioDraft, command: undefined }),
			JSON.stringify({ ...stdioDraft, transport: "sse" }),
			JSON.stringify({ name: "X", transport: "http", url: "file:///etc/passwd" }),
			JSON.stringify({ name: "X", transport: "http" }),
			JSON.stringify({ ...stdioDraft, env_names: ["BAD NAME"] }),
			JSON.stringify({ ...stdioDraft, args: [3] }),
			JSON.stringify({ ...stdioDraft, name: "" }),
			JSON.stringify({ ...stdioDraft, name: "x".repeat(100) }),
			JSON.stringify({ ...stdioDraft, env_names: Array.from({ length: 30 }, (_, i) => `K${i}`) }),
		]) {
			expect(manager.propose(bad), bad.slice(0, 60)).toBeUndefined();
		}
		expect(manager.drafts()).toHaveLength(2);
		// The daemon refuses a typed secret outside the environment too, even if the guard was skipped.
		for (const bad of secretPlacements)
			expect(manager.propose(JSON.stringify(bad)), JSON.stringify(bad)).toBeUndefined();
		expect(manager.drafts()).toHaveLength(2);
	});

	it("changes nothing when the user declines", () => {
		const { manager, store, owner, emit, agentHome, dataDir, changes } = setup();
		const draft = manager.propose(JSON.stringify(stdioDraft));
		expect(manager.decideDraft(owner, draft?.draftId ?? "", false, emit)).toBeUndefined();
		expect(manager.drafts()).toEqual([]);
		expect(store.state()).toEqual({ connectors: {} });
		expect(existsSync(join(agentHome, "mcp.json"))).toBe(false);
		expect(existsSync(join(dataDir, "connectors.json"))).toBe(false);
		expect(changes).toEqual([]);
		expect(manager.decideDraft(owner, draft?.draftId ?? "", true, emit)).toMatchObject({
			code: "draft_not_found",
		});
	});

	it("on approval asks for each secret in the app, then adds the server read only with every tool hidden", async () => {
		const { manager, store, owner, emit, sent, prompts, logs, changes } = setup();
		const draft = manager.propose(JSON.stringify(stdioDraft));
		expect(manager.decideDraft(owner, draft?.draftId ?? "", true, emit)).toBeUndefined();
		const prompt = await waitFor(() => prompts()[0]);
		expect(prompt).toMatchObject({ kind: "secret", flowId: expect.stringMatching(/^connector-setup-/) });
		expect(prompt.message).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
		manager.reply(owner, prompt.flowId, { value: SECRET });
		const done = await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(done).toMatchObject({ providerId: "github", ok: true });
		expect(changes).toContain(true);
		const saved = store.state().connectors.github;
		expect(saved).toMatchObject({
			enabled: true,
			mode: "read_only",
			values: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET },
		});
		const server = JSON.parse(readFileSync(store.signinMcpFile, "utf8")).mcpServers.github;
		expect(server).toMatchObject({
			command: "npx",
			args: ["-y", "@modelcontextprotocol/server-github@2025.4.8"],
			exposure: "direct",
			toolExposure: { "*": "hidden" },
		});
		expect(server.env.GITHUB_PERSONAL_ACCESS_TOKEN).not.toBe(SECRET);
		expect(store.policy().connectors?.github).toEqual({
			name: "GitHub",
			mode: "read_only",
			readOnlyTools: [],
		});
		const info = manager.list().find((c) => c.id === "github");
		expect(info).toMatchObject({
			name: "GitHub",
			added: true,
			enabled: true,
			mode: "read_only",
			status: "connected",
			custom: {
				origin: "Drafted by the assistant",
				summary: "npx -y @modelcontextprotocol/server-github@2025.4.8",
			},
		});
		expect(JSON.stringify(sent)).not.toContain(SECRET);
		expect(JSON.stringify(manager.list())).not.toContain(SECRET);
		expect(logs.join("\n")).not.toContain(SECRET);
		// Read and send shows every tool, and each call asks (no curated list).
		manager.setMode("github", "read_write");
		expect(
			JSON.parse(readFileSync(store.signinMcpFile, "utf8")).mcpServers.github.toolExposure,
		).toBeUndefined();
		expect(store.proxyView("github")).toMatchObject({ mode: "read_write", readOnlyTools: [] });
	});

	it("gives a draft with a taken name its own id, and signs in when it needs OAuth", async () => {
		const { manager, store, owner, emit, sent } = setup({
			FAKE_MCP_CLI_MODE: "auto",
			FAKE_MCP_CLI_URL: "https://mcp.notion.com/mcp",
		});
		store.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
		});
		const draft = manager.propose(
			JSON.stringify({
				name: "Notion",
				transport: "http",
				url: "https://mcp.notion.com/mcp",
				needs_oauth: true,
			}),
		);
		manager.decideDraft(owner, draft?.draftId ?? "", true, emit);
		const done = await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(done).toMatchObject({ providerId: "notion-2", ok: true });
		expect(Object.keys(store.state().connectors)).toEqual(["notion", "notion-2"]);
	});

	it("keeps at most five drafts waiting", () => {
		const { manager } = setup();
		for (let i = 0; i < 7; i++) manager.propose(JSON.stringify({ ...stdioDraft, name: `Server ${i}` }));
		expect(manager.drafts().map((d) => d.name)).toEqual([
			"Server 2",
			"Server 3",
			"Server 4",
			"Server 5",
			"Server 6",
		]);
	});
});

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

async function connect(d: DotDaemon, app: ReturnType<typeof fakeApp>) {
	const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws`);
	const messages: ServerMessage[] = [];
	ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
	await new Promise((resolve) => ws.on("open", resolve));
	ws.send(JSON.stringify({ type: "hello", token: d.token, protocol: 1 }));
	const ready = await waitFor(() => messages.find((m) => m.type === "ready"));
	const clientId = ready.type === "ready" ? (ready.clientId ?? "") : "";
	return {
		ws,
		messages,
		send: sendLikeThePanel(
			app,
			() => clientId,
			(m) => ws.send(JSON.stringify(m)),
		),
	};
}

describe("connector drafts through the daemon", () => {
	it("shows the engine's draft as a card in every window; only the user's answer adds it", async () => {
		const dataDir = tempDir();
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
			backoffMs: [50],
			agentHome: join(dataDir, "agent"),
			authRuntime: async () => fake.runtime,
			connectorCli: { command: process.execPath, args: [FAKE_CLI] },
			importHome: tempDir(),
			appChannel: app.daemonEnd,
		});
		daemons.push(d);
		const first = await connect(d, app);
		first.send({ type: "send", text: `propose:${JSON.stringify({ ...stdioDraft, env_names: [] })}` });
		const card = await waitFor(() =>
			first.messages.find(
				(m): m is Extract<ServerMessage, { type: "connector_draft" }> => m.type === "connector_draft",
			),
		);
		expect(card.draft).toMatchObject({ name: "GitHub", command: "npx", envNames: [] });
		// A window that opens later sees the waiting card too.
		const second = await connect(d, app);
		await waitFor(() => second.messages.some((m) => m.type === "connector_draft"));
		const mcpFile = join(dataDir, "agent", "mcp.json");
		const before = existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : undefined;
		second.send({ type: "connector_draft_reply", draftId: "nope", approve: true });
		await waitFor(() => second.messages.some((m) => m.type === "error" && m.code === "draft_not_found"));
		expect(existsSync(mcpFile) ? readFileSync(mcpFile, "utf8") : undefined).toBe(before);
		second.send({ type: "connector_draft_reply", draftId: card.draft.draftId, approve: true });
		await waitFor(() =>
			first.messages.some((m) => m.type === "connector_draft_resolved" && m.draftId === card.draft.draftId),
		);
		await waitFor(() =>
			first.messages.some(
				(m) =>
					m.type === "connectors" && m.connectors.some((c) => c.id === "github" && c.custom !== undefined),
			),
		);
		expect(
			JSON.parse(readFileSync(join(dataDir, "connector-signin", "mcp.json"), "utf8")).mcpServers.github
				.toolExposure,
		).toEqual({
			"*": "hidden",
		});
		// The engine reaches it only through the proxy.
		expect(
			JSON.parse(readFileSync(join(dataDir, "agent", "mcp.json"), "utf8")).mcpServers.github.url,
		).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/github$/);
		first.ws.close();
		second.ws.close();
	});
});

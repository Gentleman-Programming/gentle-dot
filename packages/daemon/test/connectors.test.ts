import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
	bundledMcpCli,
	CATALOG,
	ConnectorManager,
	ConnectorStore,
	renderMcpJson,
} from "../src/connectors.ts";
import { isReadOnlyCall } from "../src/extensions/approval-guard.ts";
import { tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
const NOTION_KEY = "mcp__notion|https://mcp.notion.com/mcp";

/** The engine's own MCP config validator, loaded by file path (the package exports only its entry). */
async function engineMcp() {
	const require = createRequire(import.meta.url);
	const file = (require.resolve.paths("@earendil-works/pi-coding-agent") ?? [])
		.map((dir) => join(dir, "@earendil-works", "pi-coding-agent", "dist", "core", "mcp-servers.js"))
		.find((path) => existsSync(path));
	if (!file) throw new Error("the engine package is missing");
	return (await import(pathToFileURL(file).href)) as {
		validateMcpServerConfig(name: string, raw: unknown): unknown;
		getMcpToolExposure(config: unknown, tool: string): string;
	};
}

describe("connectors catalog", () => {
	it("lists Notion, Linear, and Atlassian with their official remote servers", () => {
		expect(CATALOG.map(({ id, name, url }) => ({ id, name, url }))).toEqual([
			{ id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp" },
			{ id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp" },
			{ id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v2/mcp" },
		]);
		for (const entry of CATALOG) {
			expect(entry.readOnlyTools.length).toBeGreaterThan(3);
			expect(entry.reads).not.toBe("");
			expect(entry.sends).not.toBe("");
			for (const tool of entry.readOnlyTools)
				expect(tool).not.toMatch(/create|update|edit|delete|send|add|move/i);
		}
	});

	it("classifies a tool as read-only only when the server says so and it is curated", () => {
		const notion = CATALOG.find((entry) => entry.id === "notion")?.readOnlyTools ?? [];
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", true, notion)).toBe(true);
		expect(isReadOnlyCall("notion", "mcp__notion__notion_search", undefined, notion)).toBe(false);
		expect(isReadOnlyCall("notion", "mcp__notion__notion_create_pages", true, notion)).toBe(false);
		const linear = CATALOG.find((entry) => entry.id === "linear")?.readOnlyTools ?? [];
		expect(isReadOnlyCall("linear", "mcp__linear__list_issues", true, linear)).toBe(true);
		expect(isReadOnlyCall("linear", "mcp__linear__create_issue", true, linear)).toBe(false);
	});
});

describe("mcp.json rendering", () => {
	it("renders direct servers the engine accepts; read only hides every tool but the curated ones", async () => {
		const { validateMcpServerConfig, getMcpToolExposure } = await engineMcp();
		const rendered = JSON.parse(
			renderMcpJson({
				connectors: {
					notion: { enabled: true, mode: "read_only" },
					linear: { enabled: true, mode: "read_write" },
					atlassian: { enabled: false, mode: "read_write" },
					unknown: { enabled: true, mode: "read_write" },
				},
			}),
		) as { mcpServers: Record<string, Record<string, unknown>> };
		expect(Object.keys(rendered.mcpServers)).toEqual(["notion", "linear", "atlassian"]);
		expect(rendered.mcpServers.linear).toEqual({ url: "https://mcp.linear.app/mcp", exposure: "direct" });
		expect(rendered.mcpServers.atlassian).toEqual({
			url: "https://mcp.atlassian.com/v2/mcp",
			exposure: "direct",
			enabled: false,
		});
		const notion = rendered.mcpServers.notion;
		expect(notion).toMatchObject({ url: "https://mcp.notion.com/mcp", exposure: "direct" });
		for (const [name, config] of Object.entries(rendered.mcpServers)) {
			expect(typeof validateMcpServerConfig(name, config)).toBe("object");
		}
		expect(getMcpToolExposure(notion, "notion-search")).toBe("direct");
		expect(getMcpToolExposure(notion, "notion-create-pages")).toBe("hidden");
		expect(getMcpToolExposure(notion, "some-new-tool")).toBe("hidden");
		expect(getMcpToolExposure(rendered.mcpServers.linear, "create_issue")).toBe("direct");
	});

	it("renders an empty server list when nothing is added", () => {
		expect(JSON.parse(renderMcpJson({ connectors: {} }))).toEqual({ mcpServers: {} });
	});
});

describe("connector store", () => {
	function store() {
		const dataDir = tempDir();
		const agentHome = join(dataDir, "agent");
		mkdirSync(agentHome);
		const logs: string[] = [];
		return {
			dataDir,
			agentHome,
			logs,
			store: new ConnectorStore({ dataDir, agentHome, guardPath: "/app/guard.ts", log: (l) => logs.push(l) }),
		};
	}

	it("is the only writer: connectors.json keeps the approved mcp.json hash, both private", () => {
		const { store: s, dataDir, agentHome } = store();
		expect(s.ensureMcpJson()).toBe(false);
		expect(existsSync(join(agentHome, "mcp.json"))).toBe(false);
		s.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
		});
		const mcp = readFileSync(join(agentHome, "mcp.json"), "utf8");
		expect(JSON.parse(mcp).mcpServers.notion.url).toBe("https://mcp.notion.com/mcp");
		const saved = JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"));
		expect(saved).toEqual({
			version: 1,
			connectors: { notion: { enabled: true, mode: "read_only" } },
			hash: createHash("sha256").update(mcp).digest("hex"),
		});
		expect(statSync(join(dataDir, "connectors.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentHome, "mcp.json")).mode & 0o777).toBe(0o600);
		expect(readdirSync(agentHome).filter((f) => f.includes(".tmp"))).toEqual([]);
		expect(new ConnectorStore({ dataDir, agentHome }).state()).toEqual({
			connectors: { notion: { enabled: true, mode: "read_only" } },
		});
	});

	it("restores mcp.json when something else changed or deleted it", () => {
		const { store: s, agentHome, logs } = store();
		s.update((state) => {
			state.connectors.linear = { enabled: true, mode: "read_write" };
		});
		const file = join(agentHome, "mcp.json");
		const approved = readFileSync(file, "utf8");
		expect(s.ensureMcpJson()).toBe(false);
		writeFileSync(file, JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
		expect(s.ensureMcpJson()).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(approved);
		rmSync(file);
		expect(s.ensureMcpJson()).toBe(true);
		expect(readFileSync(file, "utf8")).toBe(approved);
		expect(logs.filter((l) => l.includes("restored"))).toHaveLength(2);
	});

	it("restores the server list when mcp.json appears without any approved connector", () => {
		const { store: s, agentHome } = store();
		writeFileSync(join(agentHome, "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
		expect(s.ensureMcpJson()).toBe(true);
		expect(JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
	});

	it("gives the guard the curated lists, modes, and the files it must protect", () => {
		const { store: s, dataDir, agentHome } = store();
		s.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_write" };
			state.connectors.linear = { enabled: false, mode: "read_only" };
		});
		const policy = s.policy();
		expect(Object.keys(policy.connectors ?? {})).toEqual(["notion"]);
		expect(policy.connectors?.notion).toEqual({
			name: "Notion",
			mode: "read_write",
			readOnlyTools: CATALOG[0]?.readOnlyTools,
		});
		expect(policy.protectedPaths).toEqual([
			join(agentHome, "mcp.json"),
			join(agentHome, "mcp-auth.json"),
			join(dataDir, "connectors.json"),
			"/app/guard.ts",
		]);
	});

	it("tells a stored sign-in from a pending one without exposing token values", () => {
		const { store: s, agentHome } = store();
		expect(s.isSignedIn("notion")).toBe(false);
		writeFileSync(join(agentHome, "mcp-auth.json"), "{oops");
		expect(s.isSignedIn("notion")).toBe(false);
		writeFileSync(
			join(agentHome, "mcp-auth.json"),
			JSON.stringify({ [NOTION_KEY]: { clientInformation: { client_id: "c" }, codeVerifier: "v" } }),
		);
		expect(s.isSignedIn("notion")).toBe(false);
		writeFileSync(
			join(agentHome, "mcp-auth.json"),
			JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: "secret-token-value" } } }),
		);
		expect(s.isSignedIn("notion")).toBe(true);
		expect(s.isSignedIn("linear")).toBe(false);
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup(mode?: "fail" | "auto") {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const cliLog = join(dataDir, "cli.jsonl");
	const logs: string[] = [];
	const store = new ConnectorStore({ dataDir, agentHome });
	const manager = new ConnectorManager({
		store,
		cli: { command: process.execPath, args: [FAKE_CLI] },
		env: {
			...process.env,
			HOME: join(dataDir, "home"),
			FAKE_MCP_CLI_LOG: cliLog,
			...(mode ? { FAKE_MCP_CLI_MODE: mode } : {}),
		},
		cwd: dataDir,
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const changes: boolean[] = [];
	manager.onChanged = (restart) => changes.push(restart);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	const cliRuns = () =>
		existsSync(cliLog)
			? readFileSync(cliLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { argv: string[]; pid: number; env: Record<string, string> })
			: [];
	function find<T extends ServerPayload["type"]>(
		type: T,
		where: (m: Extract<ServerPayload, { type: T }>) => boolean = () => true,
	) {
		return waitFor(() =>
			sent.find(
				(m): m is Extract<ServerPayload, { type: T }> =>
					m.type === type && where(m as Extract<ServerPayload, { type: T }>),
			),
		);
	}
	return { dataDir, agentHome, store, manager, changes, owner, sent, emit, find, logs, cliRuns };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("connector sign-in", () => {
	it("finds the engine's own command line", () => {
		const cli = bundledMcpCli();
		expect(cli.command).toBe(process.execPath);
		expect(cli.args).toHaveLength(1);
		expect(cli.args[0]).toMatch(/pi-coding-agent[/\\]dist[/\\]bundle[/\\]cli\.js$/);
		expect(existsSync(cli.args[0] ?? "")).toBe(true);
	});

	it("lists every catalog connector with its status", () => {
		const { manager, store } = setup();
		expect(
			manager.list().map(({ id, added, enabled, mode, status }) => ({ id, added, enabled, mode, status })),
		).toEqual([
			{ id: "notion", added: false, enabled: false, mode: "read_only", status: "off" },
			{ id: "linear", added: false, enabled: false, mode: "read_only", status: "off" },
			{ id: "atlassian", added: false, enabled: false, mode: "read_only", status: "off" },
		]);
		expect(manager.list()[0]).toMatchObject({
			name: "Notion",
			reads: expect.any(String),
			sends: expect.any(String),
		});
		store.update((state) => {
			state.connectors.linear = { enabled: true, mode: "read_write" };
		});
		expect(manager.list()[1]).toMatchObject({
			added: true,
			enabled: true,
			mode: "read_write",
			status: "needs_signin",
		});
	});

	it("connects: adds the server, relays the sign-in link, finishes through a pasted address", async () => {
		const { manager, store, agentHome, dataDir, changes, owner, emit, find, sent, logs, cliRuns } = setup();
		expect(manager.connect(owner, "notion", emit)).toBeUndefined();
		expect(store.state().connectors.notion).toEqual({ enabled: true, mode: "read_only" });
		expect(changes).toEqual([true]);
		const link = await find("auth_event", (m) => m.event.kind === "auth_url");
		expect(link.flowId).toMatch(/^connector-/);
		expect(link.event).toMatchObject({
			kind: "auth_url",
			url: expect.stringMatching(/^https:\/\/auth\.example\.com\/authorize\?/),
			instructions: expect.stringContaining("Notion"),
		});
		const prompt = await find("auth_prompt");
		expect(prompt.prompt).toMatchObject({ flowId: link.flowId, kind: "manual_code" });
		const [run] = cliRuns();
		expect(run?.argv).toEqual(["mcp", "login", "notion"]);
		expect(run?.env).toEqual({ PI_CODING_AGENT_DIR: agentHome, HOME: join(dataDir, "home") });
		const redirect = new URL(
			new URL(link.event.kind === "auth_url" ? link.event.url : "").searchParams.get("redirect_uri") ?? "",
		);
		redirect.searchParams.set("code", "very-secret-code");
		redirect.searchParams.set("state", "fake-state");
		expect(manager.reply(owner, link.flowId, { value: redirect.href })).toBe(true);
		const done = await find("auth_done");
		expect(done).toEqual({ type: "auth_done", flowId: link.flowId, providerId: "notion", ok: true });
		expect(manager.list()[0]?.status).toBe("connected");
		expect(changes).toEqual([true, false]);
		expect(logs.join("\n")).not.toContain("very-secret-code");
		expect(JSON.stringify(sent)).not.toContain("very-secret-code");
		expect(JSON.stringify(sent)).not.toContain("fake-access-token-value");
		await waitFor(() => !alive(run?.pid ?? 0));
	});

	it("refuses a pasted address for another place or sign-in, keeps waiting, and cancels by stopping the process", async () => {
		const { manager, owner, emit, find, sent, cliRuns } = setup();
		manager.connect(owner, "notion", emit);
		const link = await find("auth_event", (m) => m.event.kind === "auth_url");
		await find("auth_prompt");
		const url = new URL(link.event.kind === "auth_url" ? link.event.url : "");
		const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
		for (const pasted of [
			`${redirect.href}?code=c&state=other-state`,
			`https://evil.example.com${redirect.pathname}?code=c&state=fake-state`,
			"not a url",
		]) {
			const before = sent.filter((m) => m.type === "auth_prompt").length;
			expect(manager.reply(owner, link.flowId, { value: pasted })).toBe(true);
			await waitFor(() => sent.filter((m) => m.type === "auth_prompt").length > before);
		}
		expect(sent.some((m) => m.type === "auth_done")).toBe(false);
		expect(manager.reply({}, link.flowId, { cancelled: true })).toBe(false);
		const pid = cliRuns()[0]?.pid ?? 0;
		expect(alive(pid)).toBe(true);
		expect(manager.reply(owner, link.flowId, { cancelled: true })).toBe(true);
		const done = await find("auth_done");
		expect(done).toMatchObject({ ok: false, message: "Sign-in cancelled." });
		await waitFor(() => !alive(pid));
		expect(manager.list()[0]?.status).toBe("needs_signin");
	});

	it("runs one sign-in at a time", async () => {
		const { manager, owner, emit, find } = setup();
		manager.connect(owner, "notion", emit);
		await find("auth_prompt");
		expect(manager.connect(owner, "linear", emit)).toMatchObject({ code: "connector_busy" });
		expect(manager.signIn(owner, "notion", emit)).toMatchObject({ code: "connector_busy" });
		expect(manager.signIn(owner, "linear", emit)).toMatchObject({ code: "connector_busy" });
		manager.cancelOwnedBy(owner);
		await find("auth_done");
		await waitFor(() => manager.signIn(owner, "notion", emit) === undefined);
	});

	it("reports a failed sign-in in plain words and marks the connector", async () => {
		const { manager, owner, emit, find, logs } = setup("fail");
		manager.connect(owner, "notion", emit);
		const done = await find("auth_done");
		expect(done).toMatchObject({ ok: false, message: "Sign-in did not finish. Please try again." });
		expect(manager.list()[0]?.status).toBe("error");
		expect(logs.some((l) => l.includes("notion") && l.includes("exit 1"))).toBe(true);
		expect(logs.join("\n")).not.toContain("https://auth.example.com");
	});

	it("signs in again without changing the configuration, when the browser callback arrives", async () => {
		const { manager, store, owner, emit, find, changes } = setup("auto");
		store.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_write" };
		});
		expect(manager.signIn(owner, "notion", emit)).toBeUndefined();
		expect((await find("auth_done")).ok).toBe(true);
		expect(changes).toEqual([false]);
		expect(manager.signIn(owner, "atlassian", emit)).toMatchObject({ code: "connector_not_added" });
		expect(manager.signIn(owner, "nope", emit)).toMatchObject({ code: "unknown_connector" });
	});

	it("turns a connector off, changes its mode, and removes it with a sign-out", async () => {
		const { manager, store, owner, emit, find, sent, changes, agentHome, cliRuns } = setup("auto");
		manager.connect(owner, "notion", emit);
		await find("auth_done");
		expect(manager.setMode("notion", "read_write")).toBeUndefined();
		expect(JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers.notion).toEqual({
			url: "https://mcp.notion.com/mcp",
			exposure: "direct",
		});
		expect(manager.disconnect("notion")).toBeUndefined();
		expect(manager.list()[0]).toMatchObject({ added: true, enabled: false, status: "off" });
		expect(changes).toEqual([true, false, true, true]);
		// Turning it on again needs no new sign-in; the window still hears that it is done.
		const before = sent.length;
		expect(manager.connect(owner, "notion", emit)).toBeUndefined();
		expect(sent.slice(before)).toEqual([
			{ type: "auth_done", flowId: expect.stringMatching(/^connector-/), providerId: "notion", ok: true },
		]);
		expect(manager.list()[0]).toMatchObject({ enabled: true, status: "connected" });
		expect(cliRuns()).toHaveLength(1);
		expect(manager.disconnect("notion")).toBeUndefined();
		changes.splice(4);
		expect(await manager.remove("notion")).toBeUndefined();
		expect(cliRuns().map((r) => r.argv)).toEqual([
			["mcp", "login", "notion"],
			["mcp", "logout", "notion"],
		]);
		expect(store.state().connectors).toEqual({});
		expect(JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
		expect(JSON.parse(readFileSync(join(agentHome, "mcp-auth.json"), "utf8"))).toEqual({});
		expect(manager.list()[0]).toMatchObject({ added: false, status: "off" });
		expect(changes).toEqual([true, false, true, true, true]);
		expect(manager.setMode("notion", "read_only")).toMatchObject({ code: "connector_not_added" });
		expect(await manager.remove("nope")).toMatchObject({ code: "unknown_connector" });
	});
});

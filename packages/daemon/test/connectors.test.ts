import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
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
import { MemorySecretSource } from "../src/secret-source.ts";
import { fakeOAuth } from "./fake-oauth.ts";
import { tempDir, waitFor } from "./helpers.ts";

describe("connectors catalog", () => {
	it("lists Notion, Linear, and Atlassian with their official remote servers", () => {
		expect(CATALOG.slice(0, 3).map(({ id, name, server, oauth }) => ({ id, name, server, oauth }))).toEqual([
			{ id: "notion", name: "Notion", server: { url: "https://mcp.notion.com/mcp" }, oauth: true },
			{ id: "linear", name: "Linear", server: { url: "https://mcp.linear.app/mcp" }, oauth: true },
			{
				id: "atlassian",
				name: "Atlassian",
				server: { url: "https://mcp.atlassian.com/v2/mcp" },
				oauth: true,
			},
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
	it("renders an empty server list when nothing is added", () => {
		expect(JSON.parse(renderMcpJson({ connectors: {} }))).toEqual({ mcpServers: {} });
	});
});

describe("connector store", () => {
	const stores: ConnectorStore[] = [];
	afterEach(() => {
		for (const s of stores.splice(0)) s.close();
	});

	function store() {
		const dataDir = tempDir();
		const agentHome = join(dataDir, "agent");
		const workspace = join(dataDir, "workspace");
		mkdirSync(agentHome);
		mkdirSync(workspace);
		const logs: string[] = [];
		const s = new ConnectorStore({
			dataDir,
			agentHome,
			workspace,
			guardPath: "/app/guard.ts",
			log: (l) => logs.push(l),
		});
		stores.push(s);
		return { dataDir, agentHome, workspace, logs, store: s };
	}

	/** What an agent with a shell in the workspace did in L47: turn on a connector the user turned off. */
	function tamper(dataDir: string, agentHome: string) {
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({ version: 1, connectors: { notion: { enabled: true, mode: "read_write" } } }),
		);
		writeFileSync(
			join(agentHome, "mcp.json"),
			JSON.stringify({ mcpServers: { notion: { url: "https://mcp.notion.com/mcp", exposure: "direct" } } }),
		);
	}

	it("is the only writer: both files private, with no hash, and the state is read once at start", () => {
		const { store: s, dataDir, agentHome, workspace } = store();
		expect(s.enforce()).toBe(false);
		expect(existsSync(join(agentHome, "mcp.json"))).toBe(false);
		s.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
		});
		// A new install has no secrets in files to move, so the record says they are in the app's store.
		expect(JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"))).toEqual({
			version: 2,
			connectors: { notion: { enabled: true, mode: "read_only" } },
		});
		expect(statSync(join(dataDir, "connectors.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(agentHome, "mcp.json")).mode & 0o777).toBe(0o600);
		// The old sign-in home is never made again.
		expect(existsSync(s.signinHome)).toBe(false);
		expect(readdirSync(agentHome).filter((f) => f.includes(".tmp"))).toEqual([]);
		const next = new ConnectorStore({ dataDir, agentHome, workspace });
		stores.push(next);
		expect(next.state()).toEqual({ connectors: { notion: { enabled: true, mode: "read_only" } } });
	});

	it("renames a saved connector called `computer` (the helper's name) instead of dropping it, and keeps the rename", () => {
		const { dataDir, agentHome, workspace } = store();
		const custom = (name: string) => ({
			name,
			origin: "x",
			server: { url: "http://127.0.0.1:9/mcp" },
			fields: [],
		});
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 1,
				connectors: {
					computer: { enabled: true, mode: "read_write", custom: custom("Computer") },
					"computer-2": { enabled: false, mode: "read_only", custom: custom("Computer 2") },
				},
			}),
		);
		const s = new ConnectorStore({ dataDir, agentHome, workspace });
		stores.push(s);
		const { connectors } = s.state();
		expect(Object.keys(connectors).sort()).toEqual(["computer-2", "computer-3"]);
		expect(connectors["computer-3"]).toMatchObject({
			enabled: true,
			mode: "read_write",
			custom: { name: "Computer" },
		});
		const saved = JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"));
		expect(Object.keys(saved.connectors).sort()).toEqual(["computer-2", "computer-3"]);
		const next = new ConnectorStore({ dataDir, agentHome, workspace });
		stores.push(next);
		expect(next.state()).toEqual(s.state());
	});

	it("rewrites an older record (with a hash) quietly at start", () => {
		const { dataDir, agentHome, workspace } = store();
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 1,
				connectors: { linear: { enabled: true, mode: "read_write" } },
				hash: "abc",
			}),
		);
		const s = new ConnectorStore({ dataDir, agentHome, workspace });
		stores.push(s);
		let reverted = 0;
		s.onReverted = () => reverted++;
		expect(s.enforce(false)).toBe(true);
		expect(reverted).toBe(0);
		expect(JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"))).toEqual({
			version: 1,
			connectors: { linear: { enabled: true, mode: "read_write" } },
		});
		expect(s.enforce()).toBe(false);
	});

	it("keeps the approved state in memory: edited files change nothing and are put back (B1)", () => {
		const { store: s, dataDir, agentHome, logs } = store();
		let reverted = 0;
		s.onReverted = () => reverted++;
		s.update((state) => {
			state.connectors.notion = { enabled: false, mode: "read_only" };
		});
		const approved = {
			connectors: readFileSync(join(dataDir, "connectors.json"), "utf8"),
			mcp: readFileSync(join(agentHome, "mcp.json"), "utf8"),
		};
		tamper(dataDir, agentHome);
		expect(s.state()).toEqual({ connectors: { notion: { enabled: false, mode: "read_only" } } });
		expect(s.policy().connectors).toEqual({});
		expect(s.enforce()).toBe(true);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(approved.connectors);
		expect(readFileSync(join(agentHome, "mcp.json"), "utf8")).toBe(approved.mcp);
		expect(reverted).toBe(1);
		expect(s.enforce()).toBe(false);
		rmSync(join(agentHome, "mcp.json"));
		expect(s.enforce()).toBe(true);
		expect(readFileSync(join(agentHome, "mcp.json"), "utf8")).toBe(approved.mcp);
		expect(logs.filter((l) => l.includes("put back"))).toHaveLength(2);
	});

	it("restores the server list when mcp.json appears without any approved connector", () => {
		const { store: s, agentHome } = store();
		writeFileSync(join(agentHome, "mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "sh" } } }));
		expect(s.enforce()).toBe(true);
		expect(JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
	});

	it("removes a project mcp.json from the workspace, and a .pi link without touching where it points", () => {
		const { store: s, workspace } = store();
		mkdirSync(join(workspace, ".pi"));
		writeFileSync(
			join(workspace, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { evil: { command: "sh" } } }),
		);
		writeFileSync(join(workspace, ".pi", "notes.md"), "kept");
		expect(s.enforce()).toBe(true);
		expect(existsSync(join(workspace, ".pi", "mcp.json"))).toBe(false);
		expect(readFileSync(join(workspace, ".pi", "notes.md"), "utf8")).toBe("kept");
		rmSync(join(workspace, ".pi"), { recursive: true });
		const elsewhere = tempDir();
		writeFileSync(join(elsewhere, "mcp.json"), "{}");
		symlinkSync(elsewhere, join(workspace, ".pi"));
		expect(s.enforce()).toBe(true);
		expect(existsSync(join(workspace, ".pi"))).toBe(false);
		expect(readFileSync(join(elsewhere, "mcp.json"), "utf8")).toBe("{}");
	});

	it("watches the files and puts a change back while the engine runs", async () => {
		const { store: s, dataDir, agentHome, workspace } = store();
		s.update((state) => {
			state.connectors.linear = { enabled: false, mode: "read_only" };
		});
		const approved = readFileSync(join(dataDir, "connectors.json"), "utf8");
		let reverted = 0;
		s.onReverted = () => reverted++;
		s.watch();
		tamper(dataDir, agentHome);
		await waitFor(() => readFileSync(join(dataDir, "connectors.json"), "utf8") === approved && reverted > 0);
		await waitFor(() => !readFileSync(join(agentHome, "mcp.json"), "utf8").includes('"notion"'));
		mkdirSync(join(workspace, ".pi"));
		writeFileSync(join(workspace, ".pi", "mcp.json"), "{}");
		await waitFor(() => !existsSync(join(workspace, ".pi", "mcp.json")));
		// Its own writes are not reported.
		const before = reverted;
		s.update((state) => {
			state.connectors.linear = { enabled: true, mode: "read_only" };
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(reverted).toBe(before);
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
		expect(policy.proxied).toEqual(["notion"]);
		expect(policy.protectedPaths).toEqual([
			join(agentHome, "mcp.json"),
			join(agentHome, "mcp-auth.json"),
			join(dataDir, "connector-signin"),
			join(dataDir, "connector-signin", "mcp.json"),
			join(dataDir, "connector-signin", "mcp-auth.json"),
			join(agentHome, "auth.json"),
			join(agentHome, "models.json"),
			join(dataDir, "connectors.json"),
			join(dataDir, "token"),
			"/app/guard.ts",
		]);
	});

	it("tells a stored sign-in from a pending one without exposing token values", async () => {
		const { dataDir, agentHome } = store();
		const s = new ConnectorStore({ dataDir, agentHome, secrets: new MemorySecretSource() });
		stores.push(s);
		s.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
			state.connectors.linear = { enabled: true, mode: "read_only" };
		});
		expect(s.isSignedIn("notion")).toBe(false);
		// A planted sign-in file is never read.
		mkdirSync(s.signinHome, { recursive: true });
		writeFileSync(s.authFile, JSON.stringify({ "mcp__notion|https://mcp.notion.com/mcp": { tokens: {} } }));
		expect(s.isSignedIn("notion")).toBe(false);
		await s.saveSignIn("notion", { serverUrl: "https://mcp.notion.com/mcp", codeVerifier: "v" });
		expect(s.isSignedIn("notion")).toBe(false);
		await s.saveSignIn("notion", {
			serverUrl: "https://mcp.notion.com/mcp",
			tokens: { access_token: "secret-token-value", token_type: "Bearer" },
		});
		expect(s.isSignedIn("notion")).toBe(true);
		expect(s.isSignedIn("linear")).toBe(false);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).not.toContain("secret-token-value");
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

/** `auto`: the browser approves at once; `fail`: it does, and the provider refuses the code. */
function setup(mode?: "fail" | "auto") {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const logs: string[] = [];
	const secrets = new MemorySecretSource();
	const oauth = fakeOAuth(mode === "fail" ? { mode: "fail" } : {});
	const store = new ConnectorStore({ dataDir, agentHome, secrets });
	const manager = new ConnectorManager({
		store,
		oauth: {
			fetch: oauth.fetch,
			...(mode ? { openBrowser: (url: string) => void oauth.browse(url).catch(() => {}) } : {}),
		},
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const changes: boolean[] = [];
	manager.onChanged = (restart) => changes.push(restart);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
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
	return { dataDir, agentHome, store, manager, changes, owner, sent, emit, find, logs, secrets, oauth };
}

const linkOf = (m: ServerPayload) =>
	m.type === "auth_event" && m.event.kind === "auth_url" ? m.event.url : "";

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
			{ id: "discord", added: false, enabled: false, mode: "read_only", status: "off" },
			{ id: "slack", added: false, enabled: false, mode: "read_only", status: "off" },
			{ id: "gmail", added: false, enabled: false, mode: "read_only", status: "off" },
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
		const { manager, store, changes, owner, emit, find, sent, logs, oauth, dataDir } = setup();
		expect(manager.connect(owner, "notion", emit)).toBeUndefined();
		expect(store.state().connectors.notion).toEqual({ enabled: true, mode: "read_only" });
		expect(changes).toEqual([true]);
		const link = await find("auth_event", (m) => linkOf(m) !== "");
		expect(link.flowId).toMatch(/^connector-/);
		expect(link.event).toMatchObject({
			kind: "auth_url",
			url: expect.stringMatching(/^https:\/\/auth\.example\.com\/authorize\?/),
			instructions: expect.stringContaining("Notion"),
		});
		const prompt = await find("auth_prompt");
		expect(prompt.prompt).toMatchObject({ flowId: link.flowId, kind: "manual_code" });
		const pasted = oauth.callbackFor(linkOf(link));
		expect(manager.reply(owner, link.flowId, { value: pasted.href })).toBe(true);
		const done = await find("auth_done");
		expect(done).toEqual({ type: "auth_done", flowId: link.flowId, providerId: "notion", ok: true });
		expect(manager.list()[0]?.status).toBe("connected");
		expect(changes).toEqual([true, false]);
		const code = pasted.searchParams.get("code") ?? "";
		expect(logs.join("\n")).not.toContain(code);
		expect(JSON.stringify(sent)).not.toContain(code);
		expect(JSON.stringify(sent)).not.toContain("access-token-1");
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).not.toContain("access-token-1");
	});

	it("never opens a pasted address: one on another port of this computer is refused (A5)", async () => {
		let followed = 0;
		const elsewhere = createServer((_req, res) => {
			followed++;
			res.end("followed");
		});
		await new Promise<void>((resolve) => elsewhere.listen(0, "127.0.0.1", resolve));
		try {
			const { manager, owner, emit, find, sent, oauth } = setup();
			manager.connect(owner, "notion", emit);
			const link = await find("auth_event", (m) => linkOf(m) !== "");
			await find("auth_prompt");
			const pasted = oauth.callbackFor(linkOf(link));
			pasted.port = String((elsewhere.address() as AddressInfo).port);
			const before = sent.filter((m) => m.type === "auth_prompt").length;
			manager.reply(owner, link.flowId, { value: pasted.href });
			await waitFor(() => sent.filter((m) => m.type === "auth_prompt").length > before);
			expect(sent.some((m) => m.type === "auth_done")).toBe(false);
			expect(followed).toBe(0);
		} finally {
			elsewhere.close();
		}
	});

	it("refuses a pasted address for another place or sign-in, keeps waiting, and cancels by closing the sign-in page", async () => {
		const { manager, owner, emit, find, sent, oauth } = setup();
		manager.connect(owner, "notion", emit);
		const link = await find("auth_event", (m) => linkOf(m) !== "");
		await find("auth_prompt");
		const redirect = oauth.callbackFor(linkOf(link));
		for (const pasted of [
			`${redirect.origin}${redirect.pathname}?code=c&state=other-state`,
			`https://evil.example.com${redirect.pathname}${redirect.search}`,
			"not a url",
		]) {
			const before = sent.filter((m) => m.type === "auth_prompt").length;
			expect(manager.reply(owner, link.flowId, { value: pasted })).toBe(true);
			await waitFor(() => sent.filter((m) => m.type === "auth_prompt").length > before);
		}
		expect(sent.some((m) => m.type === "auth_done")).toBe(false);
		expect(manager.reply({}, link.flowId, { cancelled: true })).toBe(false);
		expect(manager.reply(owner, link.flowId, { cancelled: true })).toBe(true);
		const done = await find("auth_done");
		expect(done).toMatchObject({ ok: false, message: "Sign-in cancelled." });
		// The loopback sign-in page is gone.
		await expect(oauth.browse(linkOf(link))).rejects.toThrow();
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
		expect(logs.some((l) => l.includes("sign-in to connector notion failed"))).toBe(true);
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

	it("turns a connector off, changes its mode, and removes it with its sign-in", async () => {
		const { manager, store, owner, emit, find, sent, changes, agentHome, secrets, oauth } = setup("auto");
		manager.connect(owner, "notion", emit);
		await find("auth_done");
		expect(manager.setMode("notion", "read_write")).toBeUndefined();
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
		expect(oauth.issued()).toBe(1);
		expect([...secrets.values.keys()]).toEqual(["connector/notion/signin"]);
		expect(manager.disconnect("notion")).toBeUndefined();
		changes.splice(4);
		expect(await manager.remove("notion")).toBeUndefined();
		expect(secrets.values.size).toBe(0);
		expect(store.state().connectors).toEqual({});
		expect(JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8"))).toEqual({ mcpServers: {} });
		expect(manager.list()[0]).toMatchObject({ added: false, status: "off" });
		expect(changes).toEqual([true, false, true, true, true]);
		expect(manager.setMode("notion", "read_only")).toMatchObject({ code: "connector_not_added" });
		expect(await manager.remove("nope")).toMatchObject({ code: "unknown_connector" });
	});
});

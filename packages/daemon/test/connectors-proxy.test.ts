// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${input:<key>}` and `${NAME}` are the placeholders connectors use.
// The connector files with the MCP proxy (S25.4): the engine's mcp.json lists only the daemon's
// proxy addresses, the real servers and their secrets stay in the daemon's own sign-in home, and the
// approval guard lets proxied tools through (the proxy asks) while it keeps protecting the files.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectorStore, type CustomConnector, renderMcpJson } from "../src/connectors.ts";
import { decide, parsePolicy } from "../src/extensions/approval-guard.ts";
import { tempDir, waitFor } from "./helpers.ts";

const NOTION_KEY = "mcp__notion|https://mcp.notion.com/mcp";
const KEY = "proxy-key-for-this-launch-0123456789abcdef";
const PROXY = { url: "http://127.0.0.1:4999/mcp", key: KEY };
/** Every secret the files below hold; none may reach the engine's mcp.json. */
const SECRETS = {
	discordToken: "discord-bot-token-value-$weird!",
	slackSecret: "slack-client-secret-value",
	headerToken: "custom-header-token-value",
	envToken: "custom-env-token-value",
	oauthAccess: "oauth-access-token-value",
	oauthRefresh: "oauth-refresh-token-value",
};

async function engineMcp() {
	const require = createRequire(import.meta.url);
	const file = (require.resolve.paths("@earendil-works/pi-coding-agent") ?? [])
		.map((dir) => join(dir, "@earendil-works", "pi-coding-agent", "dist", "core", "mcp-servers.js"))
		.find((path) => existsSync(path));
	if (!file) throw new Error("the engine package is missing");
	return (await import(pathToFileURL(file).href)) as {
		validateMcpServerConfig(name: string, raw: unknown): unknown;
	};
}

const stores: ConnectorStore[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
});

function setup(options: { env?: NodeJS.ProcessEnv } = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const workspace = join(dataDir, "workspace");
	mkdirSync(agentHome);
	mkdirSync(workspace);
	const make = () => {
		const s = new ConnectorStore({
			dataDir,
			agentHome,
			workspace,
			guardPath: "/app/guard.ts",
			...(options.env ? { env: options.env } : {}),
		});
		stores.push(s);
		return s;
	};
	return { dataDir, agentHome, workspace, make };
}

const httpCustom: CustomConnector = {
	name: "Tracker",
	description: "",
	origin: "Imported from Cursor",
	server: { url: "https://tracker.example.com/mcp", headers: { Authorization: "Bearer ${input:TRACKER}" } },
	fields: [{ key: "TRACKER", label: "TRACKER", secret: true }],
	oauth: false,
};
const stdioCustom: CustomConnector = {
	name: "Files",
	description: "",
	origin: "Drafted by the assistant",
	server: { command: "npx", args: ["-y", "files-mcp@1.0.0"], env: { FILES_TOKEN: "${input:FILES_TOKEN}" } },
	fields: [{ key: "FILES_TOKEN", label: "FILES_TOKEN", secret: true }],
	oauth: false,
};

function fill(s: ConnectorStore) {
	s.update((state) => {
		state.connectors.notion = { enabled: true, mode: "read_only" };
		state.connectors.linear = { enabled: false, mode: "read_write" };
		state.connectors.discord = { enabled: true, mode: "read_write", values: { token: SECRETS.discordToken } };
		state.connectors.slack = {
			enabled: true,
			mode: "read_only",
			values: { client_id: "slack-client-id", client_secret: SECRETS.slackSecret },
		};
		state.connectors.tracker = {
			enabled: true,
			mode: "read_only",
			values: { TRACKER: SECRETS.headerToken },
			custom: httpCustom,
		};
		state.connectors.files = {
			enabled: true,
			mode: "read_write",
			values: { FILES_TOKEN: SECRETS.envToken },
			custom: stdioCustom,
		};
	});
}

describe("the engine's mcp.json with the proxy", () => {
	it("lists every connector as a proxy address with this launch's key, and nothing else", async () => {
		const { validateMcpServerConfig } = await engineMcp();
		const { make, agentHome, dataDir } = setup();
		const s = make();
		s.setProxy(PROXY);
		fill(s);
		writeFileSync(
			s.authFile,
			JSON.stringify({
				[NOTION_KEY]: { tokens: { access_token: SECRETS.oauthAccess, refresh_token: SECRETS.oauthRefresh } },
			}),
		);
		const text = readFileSync(join(agentHome, "mcp.json"), "utf8");
		const servers = JSON.parse(text).mcpServers as Record<string, Record<string, unknown>>;
		expect(Object.keys(servers)).toEqual(["notion", "linear", "discord", "slack", "tracker", "files"]);
		const entry = (id: string) => ({
			url: `http://127.0.0.1:4999/mcp/${id}`,
			headers: { Authorization: `Bearer ${KEY}` },
			exposure: "direct",
			timeout: 300,
		});
		expect(servers.notion).toEqual(entry("notion"));
		expect(servers.linear).toEqual({ ...entry("linear"), enabled: false });
		expect(servers.files).toEqual(entry("files"));
		for (const [name, config] of Object.entries(servers))
			expect(typeof validateMcpServerConfig(name, config)).toBe("object");
		for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
		for (const upstream of [
			"notion.com",
			"linear.app",
			"slack.com",
			"tracker.example.com",
			"npx",
			"discord-mcp",
		])
			expect(text).not.toContain(upstream);
		for (const name of ["DISCORD_TOKEN", "FILES_TOKEN", "env", "oauth", "toolExposure", "command"])
			expect(text).not.toContain(name);
		// The real servers are only in the daemon's own sign-in home, for the sign-in command.
		expect(s.signinHome).toBe(join(dataDir, "connector-signin"));
		const signin = JSON.parse(readFileSync(s.signinMcpFile, "utf8")).mcpServers;
		expect(signin.notion.url).toBe("https://mcp.notion.com/mcp");
		expect(signin.slack.oauth.clientId).toBe("slack-client-id");
		expect(statSync(s.signinHome).mode & 0o777).toBe(0o700);
		expect(statSync(s.signinMcpFile).mode & 0o777).toBe(0o600);
	});

	it("leaves the connectors out until the proxy listens, keeps the computer helper as it is, and changes the key per launch", () => {
		const { make, agentHome } = setup();
		const s = make();
		s.update((state) => {
			state.connectors.notion = { enabled: true, mode: "read_only" };
		});
		const read = () => JSON.parse(readFileSync(join(agentHome, "mcp.json"), "utf8")).mcpServers;
		expect(read()).toEqual({});
		s.setComputer({ url: "http://127.0.0.1:5555/mcp", token: "helper-key" });
		expect(s.setProxy(PROXY)).toBe(true);
		expect(s.setProxy(PROXY)).toBe(false);
		expect(read().computer).toEqual({
			url: "http://127.0.0.1:5555/mcp",
			headers: { Authorization: "Bearer helper-key" },
			exposure: "direct",
			timeout: 300,
		});
		expect(read().notion.headers.Authorization).toBe(`Bearer ${KEY}`);
		s.setProxy({ ...PROXY, key: "next-launch-key-0123456789abcdef0123" });
		expect(read().notion.headers.Authorization).toBe("Bearer next-launch-key-0123456789abcdef0123");
		expect(JSON.parse(renderMcpJson({ connectors: {} }, undefined, PROXY))).toEqual({ mcpServers: {} });
	});
});

describe("the proxy's view of a connector and its credentials", () => {
	it("gives the proxy each connector's live state without secrets, and a new revision when its values change", () => {
		const { make } = setup();
		const s = make();
		fill(s);
		expect(s.proxyView("notion")).toMatchObject({
			id: "notion",
			name: "Notion",
			enabled: true,
			mode: "read_only",
			server: { url: "https://mcp.notion.com/mcp" },
		});
		expect(s.proxyView("notion")?.readOnlyTools).toContain("notion-search");
		expect(s.proxyView("linear")).toMatchObject({ enabled: false });
		expect(s.proxyView("files")).toMatchObject({
			mode: "read_write",
			readOnlyTools: [],
			server: { command: "npx", args: ["-y", "files-mcp@1.0.0"] },
		});
		for (const id of ["discord", "slack", "tracker", "files"]) {
			const text = JSON.stringify(s.proxyView(id));
			for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
		}
		expect(s.proxyView("atlassian")).toBeUndefined();
		const before = s.proxyView("files")?.revision;
		s.update((state) => {
			const files = state.connectors.files;
			if (files) files.mode = "read_only";
		});
		expect(s.proxyView("files")?.revision).toBe(before);
		s.update((state) => {
			const files = state.connectors.files;
			if (files) files.values = { FILES_TOKEN: "another" };
		});
		expect(s.proxyView("files")?.revision).not.toBe(before);
	});

	it("injects the typed values as they were typed, the environment references, and the stored sign-in", async () => {
		const { make } = setup({ env: { PATH: "/usr/bin", TEAM_ID: "team-7" } });
		const s = make();
		fill(s);
		s.update((state) => {
			state.connectors.team = {
				enabled: true,
				mode: "read_only",
				custom: {
					name: "Team",
					description: "",
					origin: "Imported from Claude Code",
					server: {
						url: "https://team.example.com/mcp",
						headers: { "X-Team": "${TEAM_ID}", "X-Price": "$$5" },
					},
					fields: [],
					oauth: false,
				},
			};
		});
		expect((await s.credentials("discord")).env).toEqual({ DISCORD_TOKEN: SECRETS.discordToken });
		expect((await s.credentials("files")).env).toEqual({ FILES_TOKEN: SECRETS.envToken });
		const tracker = await s.credentials("tracker");
		expect(tracker.headers).toEqual({ Authorization: `Bearer ${SECRETS.headerToken}` });
		// A server with its own Authorization header does not sign in.
		expect(tracker.authProvider).toBeUndefined();
		expect((await s.credentials("team")).headers).toEqual({ "X-Team": "team-7", "X-Price": "$5" });
		const notion = await s.credentials("notion");
		expect(await notion.authProvider?.token()).toBeUndefined();
		writeFileSync(
			s.authFile,
			JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: SECRETS.oauthAccess } } }),
		);
		expect(await notion.authProvider?.token()).toBe(SECRETS.oauthAccess);
	});
});

describe("the daemon's sign-in home", () => {
	it("moves the engine's old mcp-auth.json there once, after checking the copy", () => {
		const { make, agentHome, dataDir } = setup();
		const old = join(agentHome, "mcp-auth.json");
		const stored = JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: SECRETS.oauthAccess } } });
		writeFileSync(old, stored);
		const s = make();
		expect(existsSync(old)).toBe(false);
		expect(readFileSync(s.authFile, "utf8")).toBe(stored);
		expect(s.authFile).toBe(join(dataDir, "connector-signin", "mcp-auth.json"));
		expect(statSync(s.authFile).mode & 0o777).toBe(0o600);
		expect(s.isSignedIn("notion")).toBe(true);
		expect(s.isSignedIn("linear")).toBe(false);
		// A file that shows up in the engine's home later never replaces a sign-in the daemon holds,
		// and it does not stay there.
		writeFileSync(old, JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: "planted" } } }));
		const next = make();
		expect(readFileSync(next.authFile, "utf8")).toBe(stored);
		expect(existsSync(old)).toBe(false);
		expect(readdirSync(join(dataDir, "connector-signin")).filter((f) => f.includes(".tmp"))).toEqual([]);
	});

	it("finishes a move that stopped halfway: an empty sign-in home, the old file still there (A2)", () => {
		const { make, agentHome, dataDir } = setup();
		const old = join(agentHome, "mcp-auth.json");
		const stored = JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: SECRETS.oauthAccess } } });
		writeFileSync(old, stored);
		mkdirSync(join(dataDir, "connector-signin"), { mode: 0o700 });
		const s = make();
		expect(existsSync(old)).toBe(false);
		expect(readFileSync(s.authFile, "utf8")).toBe(stored);
		expect(s.isSignedIn("notion")).toBe(true);
	});

	it("moves the sign-ins the daemon does not hold yet when both files exist, keeping its own (A2)", () => {
		const { make, agentHome, dataDir } = setup();
		const old = join(agentHome, "mcp-auth.json");
		const linearKey = NOTION_KEY.replace("notion", "linear").replace("mcp.notion.com", "mcp.linear.app");
		writeFileSync(
			old,
			JSON.stringify({
				[NOTION_KEY]: { tokens: { access_token: "older-notion" } },
				[linearKey]: { tokens: { access_token: SECRETS.oauthAccess } },
			}),
		);
		mkdirSync(join(dataDir, "connector-signin"), { mode: 0o700 });
		const current = { [NOTION_KEY]: { tokens: { access_token: "current-notion" } } };
		writeFileSync(join(dataDir, "connector-signin", "mcp-auth.json"), JSON.stringify(current));
		const s = make();
		expect(existsSync(old)).toBe(false);
		const moved = JSON.parse(readFileSync(s.authFile, "utf8"));
		expect(moved[NOTION_KEY].tokens.access_token).toBe("current-notion");
		expect(moved[linearKey].tokens.access_token).toBe(SECRETS.oauthAccess);
		expect(statSync(s.authFile).mode & 0o777).toBe(0o600);
	});

	it("leaves the old file where it is when it cannot be read as sign-ins (A2)", () => {
		const { make, agentHome, dataDir } = setup();
		const old = join(agentHome, "mcp-auth.json");
		mkdirSync(join(dataDir, "connector-signin"), { mode: 0o700 });
		writeFileSync(join(dataDir, "connector-signin", "mcp-auth.json"), "{}");
		writeFileSync(old, "not json");
		make();
		expect(readFileSync(old, "utf8")).toBe("not json");
	});

	it("protects the sign-in home and its files from the file tools and shell commands like the other credential files", () => {
		const { make, agentHome, dataDir } = setup();
		const s = make();
		fill(s);
		const policy = s.policy();
		const signin = join(dataDir, "connector-signin");
		expect(policy.protectedPaths).toEqual(
			expect.arrayContaining([
				join(agentHome, "mcp.json"),
				join(agentHome, "mcp-auth.json"),
				signin,
				join(signin, "mcp.json"),
				join(signin, "mcp-auth.json"),
			]),
		);
		writeFileSync(s.authFile, "{}");
		const cwd = join(dataDir, "workspace");
		for (const call of [
			{ toolName: "read", input: { path: join(signin, "mcp-auth.json") } },
			{ toolName: "read", input: { path: "../connector-signin/mcp.json" } },
			{ toolName: "ls", input: { path: signin } },
			{ toolName: "grep", input: { pattern: "token", path: dataDir } },
			{ toolName: "write", input: { path: join(signin, "mcp.json"), content: "{}" } },
			{ toolName: "bash", input: { command: "cat ../connector-signin/mcp-auth.json" } },
			{ toolName: "bash", input: { command: "ls ../connector-signin" } },
		])
			expect(decide({ ...call, cwd }, policy).action).toBe("block");
	});

	it("puts back the sign-in files when they change outside a sign-in, and keeps what a sign-in wrote", async () => {
		const { make } = setup();
		const s = make();
		fill(s);
		const signinMcp = readFileSync(s.signinMcpFile, "utf8");
		writeFileSync(
			s.signinMcpFile,
			JSON.stringify({ mcpServers: { notion: { url: "https://evil.example/mcp" } } }),
		);
		expect(s.enforce()).toBe(true);
		expect(readFileSync(s.signinMcpFile, "utf8")).toBe(signinMcp);
		// Planted sign-in state is removed while no sign-in runs.
		writeFileSync(s.authFile, JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: "planted" } } }));
		expect(s.enforce()).toBe(true);
		expect(existsSync(s.authFile)).toBe(false);
		// A sign-in writes it, and what it wrote is kept.
		const done = s.signingIn();
		const signedIn = JSON.stringify({ [NOTION_KEY]: { tokens: { access_token: SECRETS.oauthAccess } } });
		writeFileSync(s.authFile, signedIn);
		expect(s.enforce()).toBe(false);
		done();
		expect(s.enforce()).toBe(false);
		writeFileSync(s.authFile, "{}");
		expect(s.enforce()).toBe(true);
		expect(readFileSync(s.authFile, "utf8")).toBe(signedIn);
		// And the watcher does the same while the daemon runs.
		s.watch();
		rmSync(s.signinMcpFile);
		await waitFor(() => existsSync(s.signinMcpFile) && readFileSync(s.signinMcpFile, "utf8") === signinMcp);
		writeFileSync(s.authFile, "{}");
		await waitFor(() => readFileSync(s.authFile, "utf8") === signedIn);
	});
});

describe("the approval guard with proxied connectors", () => {
	it("lets the tools of a proxied connector through (the proxy asks), and still blocks one that is turned off", () => {
		const { make, dataDir } = setup();
		const s = make();
		fill(s);
		const policy = parsePolicy(JSON.stringify(s.policy()));
		if (!policy) throw new Error("the policy did not parse");
		expect(policy.proxied).toEqual(["notion", "discord", "slack", "tracker", "files"]);
		const cwd = join(dataDir, "workspace");
		const call = (toolName: string) => decide({ toolName, input: { body: "hi" }, cwd }, policy).action;
		expect(call("mcp__notion__notion_create_pages")).toBe("pass");
		expect(call("mcp__files__delete_everything")).toBe("pass");
		expect(call("mcp__linear__create_issue")).toBe("block");
		expect(call("mcp__unknown__x")).toBe("block");
		expect(parsePolicy(JSON.stringify({ ...s.policy(), proxied: [7] }))).toBeUndefined();
	});
});

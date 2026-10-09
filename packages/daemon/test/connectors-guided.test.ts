// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${input:<key>}` is the placeholder the catalog uses.
// Guided connectors (S18, L36): Discord with a bot token, Slack and Gmail with the user's own OAuth app.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG, ConnectorManager, ConnectorStore, renderMcpJson } from "../src/connectors.ts";
import { MemorySecretSource } from "../src/secret-source.ts";
import { fakeOAuth } from "./fake-oauth.ts";
import { tempDir, waitFor } from "./helpers.ts";

const TOKEN = "discord-bot-token-$ecret!value";
const CLIENT_SECRET = "slack-client-secret-value";

/** A module of the engine package, loaded by file path (the package exports only its entry). */
async function engineModule<T>(path: string): Promise<T> {
	const require = createRequire(import.meta.url);
	const file = (require.resolve.paths("@earendil-works/pi-coding-agent") ?? [])
		.map((dir) => join(dir, "@earendil-works", "pi-coding-agent", "dist", ...path.split("/")))
		.find((candidate) => existsSync(candidate));
	if (!file) throw new Error("the engine package is missing");
	return (await import(pathToFileURL(file).href)) as T;
}

const engine = () =>
	Promise.all([
		engineModule<{
			validateMcpServerConfig(name: string, raw: unknown): unknown;
			getMcpToolExposure(config: unknown, tool: string): string;
		}>("core/mcp-servers.js"),
		engineModule<{ resolveConfigValue(config: string): string | undefined }>("core/resolve-config-value.js"),
	]);

const entry = (id: string) => {
	const found = CATALOG.find((e) => e.id === id);
	if (!found) throw new Error(`${id} is not in the catalog`);
	return found;
};

describe("guided catalog entries", () => {
	it("adds Discord, Slack, and Gmail after the one-click servers, each with a guide", () => {
		expect(CATALOG.map((e) => e.id)).toEqual(["notion", "linear", "atlassian", "discord", "slack", "gmail"]);
		for (const id of ["discord", "slack", "gmail"]) {
			const guided = entry(id);
			expect(guided.guide?.steps.length, id).toBeGreaterThanOrEqual(4);
			expect(guided.guide?.links.length, id).toBeGreaterThan(0);
			for (const link of guided.guide?.links ?? []) expect(link.url).toMatch(/^https:\/\//);
			expect(guided.fields?.length, id).toBeGreaterThan(0);
			expect(guided.readOnlyTools.length, id).toBeGreaterThan(3);
			for (const tool of guided.readOnlyTools)
				expect(tool).not.toMatch(/create|update|edit|delete|send|add|move|_label_|unlabel|ban_|kick/i);
		}
	});

	it("runs Discord's community server at an exact version, with the bot token from a secret field", () => {
		const discord = entry("discord");
		expect(discord.server).toEqual({
			command: "npx",
			args: ["-y", "@pasympa/discord-mcp@2.2.0"],
			env: { DISCORD_TOKEN: "${input:token}" },
		});
		expect(discord.fields).toEqual([expect.objectContaining({ key: "token", secret: true })]);
		expect(discord.oauth).toBe(false);
		expect(discord.guide?.steps.join(" ")).toMatch(/Message Content Intent/);
		expect(discord.readOnlyTools).toContain("discord_read_messages");
	});

	it("signs in to Slack and Gmail with the user's own app on a fixed loopback redirect", () => {
		const slack = entry("slack");
		expect(slack.server).toEqual({
			url: "https://mcp.slack.com/mcp",
			oauth: {
				clientId: "${input:client_id}",
				clientSecret: "${input:client_secret}",
				callbackUrl: "http://localhost:38417/callback",
			},
		});
		expect(slack.fields?.map(({ key, secret, optional }) => ({ key, secret, optional }))).toEqual([
			{ key: "client_id", secret: false, optional: undefined },
			{ key: "client_secret", secret: true, optional: true },
		]);
		expect(slack.guide?.redirectUrl).toBe("http://localhost:38417/callback");
		expect(slack.guide?.steps.join(" ")).toMatch(/PKCE/);
		const gmail = entry("gmail");
		expect(gmail.server).toEqual({
			url: "https://gmailmcp.googleapis.com/mcp/v1",
			oauth: {
				clientId: "${input:client_id}",
				clientSecret: "${input:client_secret}",
				callbackUrl: "http://localhost:38418/callback",
				scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
			},
		});
		expect(gmail.fields?.map((f) => [f.key, f.secret, f.optional ?? false])).toEqual([
			["client_id", false, false],
			["client_secret", true, false],
		]);
		expect(gmail.guide?.redirectUrl).toBe("http://localhost:38418/callback");
		expect(gmail.guide?.note).toMatch(/7 days/);
		expect(gmail.guide?.note).toMatch(/Developer Preview/);
		expect(slack.oauth && gmail.oauth).toBe(true);
	});

	it("describes what each guided connector can send as its permissions allow, and that read only hides it", () => {
		// Gmail's gmail.compose scope can send mail, so the copy never promises otherwise.
		const gmail = entry("gmail");
		expect(gmail.sends).not.toMatch(/never/i);
		expect(gmail.sends).toMatch(/send/i);
		expect(gmail.sends).toMatch(/draft/i);
		expect(gmail.sends).toMatch(/approve each/i);
		expect(gmail.guide?.note).toMatch(/gmail\.compose/);
		expect(gmail.guide?.note).toMatch(/send/i);
		// Slack's guide asks only for chat:write, so it can send and schedule messages, not react or create canvases.
		const slack = entry("slack");
		expect(slack.guide?.steps.join(" ")).not.toMatch(/reactions:write|canvases:write/);
		expect(slack.sends).not.toMatch(/reaction|canvas/i);
		expect(slack.sends).toMatch(/send/i);
		// Discord's guide gives the bot no Manage Channels permission.
		const discord = entry("discord");
		expect(discord.guide?.steps.join(" ")).not.toMatch(/Manage Channels/);
		expect(discord.sends).not.toMatch(/manage/i);
		for (const guided of [gmail, slack, discord]) expect(guided.sends, guided.id).toMatch(/read only hides/i);
	});
});

describe("guided values reach the real server as they were typed", () => {
	it("never runs or expands a typed value, and leaves an empty optional one out", async () => {
		const [, { resolveConfigValue }] = await engine();
		const store = new ConnectorStore({
			dataDir: tempDir(),
			agentHome: join(tempDir(), "agent"),
			secrets: new MemorySecretSource(),
		});
		store.update((state) => {
			state.connectors.discord = { enabled: true, mode: "read_only", values: { token: TOKEN } };
			state.connectors.slack = {
				enabled: true,
				mode: "read_write",
				values: { client_id: "123.456", client_secret: "" },
			};
			state.connectors.gmail = {
				enabled: false,
				mode: "read_only",
				values: { client_id: "g-id.apps.googleusercontent.com", client_secret: "!echo pwned" },
			};
		});
		expect(store.proxyView("discord")?.server).toEqual({
			command: "npx",
			args: ["-y", "@pasympa/discord-mcp@2.2.0"],
		});
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect((await store.signInTarget("slack")).settings).toEqual({
			clientId: "123.456",
			callbackUrl: "http://localhost:38417/callback",
		});
		const gmail = (await store.signInTarget("gmail")).settings;
		expect(gmail.clientId).toBe("g-id.apps.googleusercontent.com");
		expect(gmail.clientSecret).toBe("!echo pwned");
		// The engine would have run it; the engine never sees it now.
		expect(resolveConfigValue("!echo pwned")).toBe("pwned");
		store.close();
	});

	it("leaves out a guided connector whose required values are missing", () => {
		const state = { connectors: { discord: { enabled: true, mode: "read_only" as const } } };
		const proxy = { url: "http://127.0.0.1:4999/mcp", key: "k".repeat(32) };
		expect(JSON.parse(renderMcpJson(state, undefined, proxy)).mcpServers).toEqual({});
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup() {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const logs: string[] = [];
	const secrets = new MemorySecretSource();
	const oauth = fakeOAuth();
	const store = new ConnectorStore({ dataDir, agentHome, secrets });
	const manager = new ConnectorManager({
		store,
		oauth: { fetch: oauth.fetch, openBrowser: (url) => void oauth.browse(url).catch(() => {}) },
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	const prompts = () => sent.flatMap((m) => (m.type === "auth_prompt" ? [m.prompt] : []));
	return { dataDir, agentHome, store, manager, owner, sent, emit, prompts, logs, secrets, oauth };
}

describe("guided connector setup", () => {
	it("asks for the Discord bot token as a secret, then adds it read only; the value is never shown or logged", async () => {
		const { manager, store, owner, emit, sent, prompts, logs, dataDir, agentHome, secrets, oauth } = setup();
		expect(manager.connect(owner, "discord", emit)).toBeUndefined();
		const prompt = await waitFor(() => prompts()[0]);
		expect(prompt).toMatchObject({ kind: "secret", flowId: expect.stringMatching(/^connector-setup-/) });
		expect(prompt.message).toMatch(/token/i);
		// Nothing is added until the setup is complete.
		expect(store.state().connectors.discord).toBeUndefined();
		expect(manager.reply(owner, prompt.flowId, { value: TOKEN })).toBe(true);
		const done = await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(done).toMatchObject({ flowId: prompt.flowId, providerId: "discord", ok: true });
		expect(store.state().connectors.discord).toMatchObject({ enabled: true, mode: "read_only" });
		expect(secrets.values.get("connector/discord/value/token")).toBe(TOKEN);
		expect(manager.list().find((c) => c.id === "discord")).toMatchObject({
			added: true,
			enabled: true,
			status: "connected",
			guide: expect.objectContaining({ steps: expect.any(Array) }),
		});
		// A server with a token signs in with nothing else.
		expect(oauth.tokenRequests).toEqual([]);
		expect(JSON.stringify(manager.list())).not.toContain(TOKEN);
		expect(JSON.stringify(sent)).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);
		// The token is only in the app's store; the proxy hands it to the server it runs.
		expect(readFileSync(join(agentHome, "mcp.json"), "utf8")).not.toContain("DISCORD_TOKEN");
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toContain("discord");
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).not.toContain(TOKEN);
		expect(store.policy().connectors?.discord?.readOnlyTools).toContain("discord_read_messages");
	});

	it("adds nothing when the setup is cancelled", async () => {
		const { manager, store, owner, emit, sent, prompts } = setup();
		manager.connect(owner, "discord", emit);
		const prompt = await waitFor(() => prompts()[0]);
		expect(manager.reply({}, prompt.flowId, { cancelled: true })).toBe(false);
		expect(manager.reply(owner, prompt.flowId, { cancelled: true })).toBe(true);
		expect(await waitFor(() => sent.find((m) => m.type === "auth_done"))).toMatchObject({ ok: false });
		expect(store.state().connectors).toEqual({});
		expect(manager.connect(owner, "slack", emit)).toBeUndefined();
	});

	it("asks for Slack's client id and an optional secret, keeps the secret in the app's store, then signs in with them on the same flow", async () => {
		const { manager, store, owner, emit, sent, prompts, logs, secrets, oauth, dataDir } = setup();
		manager.connect(owner, "slack", emit);
		const first = await waitFor(() => prompts()[0]);
		expect(first).toMatchObject({ kind: "text" });
		expect(first.message).toMatch(/client id/i);
		manager.reply(owner, first.flowId, { value: "123.456" });
		const second = await waitFor(() => prompts()[1]);
		expect(second).toMatchObject({ kind: "secret", optional: true, flowId: first.flowId });
		expect(manager.reply(owner, second.flowId, { value: CLIENT_SECRET })).toBe(true);
		const done = await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(done).toMatchObject({ flowId: first.flowId, providerId: "slack", ok: true });
		// The user's own client, on its fixed redirect; nothing is registered.
		const link = sent.find((m) => m.type === "auth_event");
		const url = new URL(link?.type === "auth_event" && link.event.kind === "auth_url" ? link.event.url : "");
		expect(url.searchParams.get("client_id")).toBe("123.456");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:38417/callback");
		expect(oauth.registered).toEqual([]);
		expect(oauth.tokenRequests).toEqual([
			{ grant: "authorization_code", clientId: "123.456", clientSecret: CLIENT_SECRET },
		]);
		expect(manager.list().find((c) => c.id === "slack")?.status).toBe("connected");
		expect(secrets.values.get("connector/slack/value/client_secret")).toBe(CLIENT_SECRET);
		expect(
			JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8")).connectors.slack.values,
		).toEqual({
			client_id: "123.456",
			client_secret: { secretRef: "connector/slack/value/client_secret" },
		});
		expect(store.state().connectors.slack?.signIn).toBeDefined();
		expect(JSON.stringify(sent)).not.toContain(CLIENT_SECRET);
		expect(logs.join("\n")).not.toContain(CLIENT_SECRET);
	});

	it("refuses an empty required value and asks again", async () => {
		const { manager, owner, emit, prompts } = setup();
		manager.connect(owner, "discord", emit);
		const prompt = await waitFor(() => prompts()[0]);
		manager.reply(owner, prompt.flowId, { value: "   " });
		const again = await waitFor(() => prompts()[1]);
		expect(again.flowId).toBe(prompt.flowId);
		expect(again.message).toMatch(/needed/i);
	});

	it("changes the stored values from Set up, and refuses connectors that need none", async () => {
		const { manager, store, owner, emit, sent, prompts, secrets } = setup();
		store.update((state) => {
			state.connectors.discord = { enabled: true, mode: "read_write", values: { token: "old" } };
		});
		expect(manager.setup(owner, "discord", emit)).toBeUndefined();
		const prompt = await waitFor(() => prompts()[0]);
		manager.reply(owner, prompt.flowId, { value: "new-token" });
		await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(store.state().connectors.discord).toMatchObject({ enabled: true, mode: "read_write" });
		expect(secrets.values.get("connector/discord/value/token")).toBe("new-token");
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: "new-token" });
		expect(manager.setup(owner, "notion", emit)).toMatchObject({ code: "connector_not_added" });
		expect(manager.setup(owner, "nope", emit)).toMatchObject({ code: "unknown_connector" });
	});
});

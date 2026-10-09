// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${input:<key>}` is the placeholder the catalog uses.
// Guided connectors (S18, L36): Discord with a bot token, Slack and Gmail with the user's own OAuth app.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG, ConnectorManager, ConnectorStore, renderSigninMcpJson } from "../src/connectors.ts";
import { tempDir, waitFor } from "./helpers.ts";

const FAKE_CLI = fileURLToPath(new URL("./fixtures/fake-mcp-cli.ts", import.meta.url));
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

describe("guided mcp.json rendering (the sign-in home)", () => {
	it("puts typed values in as literals the engine does not run or expand, and hides unknown tools", async () => {
		const [{ validateMcpServerConfig, getMcpToolExposure }, { resolveConfigValue }] = await engine();
		const rendered = JSON.parse(
			renderSigninMcpJson({
				connectors: {
					discord: { enabled: true, mode: "read_only", values: { token: TOKEN } },
					slack: { enabled: true, mode: "read_write", values: { client_id: "123.456", client_secret: "" } },
					gmail: {
						enabled: false,
						mode: "read_only",
						values: { client_id: "g-id.apps.googleusercontent.com", client_secret: "!echo pwned" },
					},
				},
			}),
		) as { mcpServers: Record<string, Record<string, unknown>> };
		const { discord, slack, gmail } = rendered.mcpServers;
		for (const [name, config] of Object.entries(rendered.mcpServers))
			expect(typeof validateMcpServerConfig(name, config), name).toBe("object");
		expect(discord).toMatchObject({
			command: "npx",
			args: ["-y", "@pasympa/discord-mcp@2.2.0"],
			exposure: "direct",
		});
		const token = (discord?.env as Record<string, string> | undefined)?.DISCORD_TOKEN ?? "";
		expect(token).not.toBe(TOKEN);
		expect(resolveConfigValue(token)).toBe(TOKEN);
		expect(getMcpToolExposure(discord, "discord_read_messages")).toBe("direct");
		expect(getMcpToolExposure(discord, "discord_send_message")).toBe("hidden");
		// An optional value left empty is left out; the client id is used as is.
		expect(slack?.oauth).toEqual({ clientId: "123.456", callbackUrl: "http://localhost:38417/callback" });
		expect(slack?.toolExposure).toBeUndefined();
		const oauth = gmail?.oauth as Record<string, string>;
		expect(oauth.clientId).toBe("g-id.apps.googleusercontent.com");
		expect(oauth.clientSecret?.startsWith("!")).toBe(false);
		expect(resolveConfigValue(oauth.clientSecret ?? "")).toBe("!echo pwned");
		expect(gmail?.enabled).toBe(false);
	});

	it("leaves out a guided connector whose required values are missing", () => {
		const rendered = JSON.parse(
			renderSigninMcpJson({ connectors: { discord: { enabled: true, mode: "read_only" } } }),
		) as { mcpServers: Record<string, unknown> };
		expect(rendered.mcpServers).toEqual({});
	});
});

const managers: ConnectorManager[] = [];
afterEach(() => {
	for (const manager of managers.splice(0)) manager.cancelAll();
});

function setup(cliEnv: Record<string, string> = {}) {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const cliLog = join(dataDir, "cli.jsonl");
	const logs: string[] = [];
	const store = new ConnectorStore({ dataDir, agentHome });
	const manager = new ConnectorManager({
		store,
		cli: { command: process.execPath, args: [FAKE_CLI] },
		env: { ...process.env, HOME: join(dataDir, "home"), FAKE_MCP_CLI_LOG: cliLog, ...cliEnv },
		cwd: dataDir,
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	const prompts = () => sent.flatMap((m) => (m.type === "auth_prompt" ? [m.prompt] : []));
	const cliRuns = () =>
		existsSync(cliLog)
			? readFileSync(cliLog, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as { argv: string[] })
			: [];
	return { dataDir, agentHome, store, manager, owner, sent, emit, prompts, logs, cliRuns };
}

describe("guided connector setup", () => {
	it("asks for the Discord bot token as a secret, then adds it read only; the value is never shown or logged", async () => {
		const { manager, store, owner, emit, sent, prompts, logs, dataDir, agentHome, cliRuns } = setup();
		expect(manager.connect(owner, "discord", emit)).toBeUndefined();
		const prompt = await waitFor(() => prompts()[0]);
		expect(prompt).toMatchObject({ kind: "secret", flowId: expect.stringMatching(/^connector-setup-/) });
		expect(prompt.message).toMatch(/token/i);
		// Nothing is added until the setup is complete.
		expect(store.state().connectors.discord).toBeUndefined();
		expect(manager.reply(owner, prompt.flowId, { value: TOKEN })).toBe(true);
		const done = await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(done).toMatchObject({ flowId: prompt.flowId, providerId: "discord", ok: true });
		expect(store.state().connectors.discord).toEqual({
			enabled: true,
			mode: "read_only",
			values: { token: TOKEN },
		});
		expect(manager.list().find((c) => c.id === "discord")).toMatchObject({
			added: true,
			enabled: true,
			status: "connected",
			guide: expect.objectContaining({ steps: expect.any(Array) }),
		});
		// A server with a token signs in with nothing else; `mcp login` never runs.
		expect(cliRuns()).toEqual([]);
		expect(JSON.stringify(manager.list())).not.toContain(TOKEN);
		expect(JSON.stringify(sent)).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);
		// The real server is only in the daemon's sign-in home; the proxy hands the token to the server it runs.
		expect(readFileSync(store.signinMcpFile, "utf8")).toContain("DISCORD_TOKEN");
		expect(readFileSync(join(agentHome, "mcp.json"), "utf8")).not.toContain("DISCORD_TOKEN");
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toContain("discord");
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

	it("asks for Slack's client id and an optional secret, writes them to mcp.json, then signs in on the same flow", async () => {
		const { manager, store, owner, emit, sent, prompts, cliRuns, logs } = setup({
			FAKE_MCP_CLI_MODE: "auto",
			FAKE_MCP_CLI_URL: "https://mcp.slack.com/mcp",
		});
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
		expect(cliRuns().map((r) => r.argv)).toEqual([["mcp", "login", "slack"]]);
		const slack = JSON.parse(readFileSync(store.signinMcpFile, "utf8")).mcpServers.slack;
		expect(slack.oauth).toMatchObject({
			clientId: "123.456",
			callbackUrl: "http://localhost:38417/callback",
		});
		expect(manager.list().find((c) => c.id === "slack")?.status).toBe("connected");
		expect(store.state().connectors.slack?.values).toEqual({
			client_id: "123.456",
			client_secret: CLIENT_SECRET,
		});
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
		const { manager, store, owner, emit, sent, prompts } = setup();
		store.update((state) => {
			state.connectors.discord = { enabled: true, mode: "read_write", values: { token: "old" } };
		});
		expect(manager.setup(owner, "discord", emit)).toBeUndefined();
		const prompt = await waitFor(() => prompts()[0]);
		manager.reply(owner, prompt.flowId, { value: "new-token" });
		await waitFor(() => sent.find((m) => m.type === "auth_done"));
		expect(store.state().connectors.discord).toEqual({
			enabled: true,
			mode: "read_write",
			values: { token: "new-token" },
		});
		expect(manager.setup(owner, "notion", emit)).toMatchObject({ code: "connector_not_added" });
		expect(manager.setup(owner, "nope", emit)).toMatchObject({ code: "unknown_connector" });
	});
});

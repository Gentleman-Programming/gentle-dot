// biome-ignore-all lint/suspicious/noTemplateCurlyInString: `${input:<key>}` is the placeholder connectors use.
// Connector secrets in the desktop app's secure store (S25.5, T23d): the daemon asks the app for
// them over its private channel and keeps them in memory only; typed values, OAuth sign-ins, and
// refreshed tokens go there and to no file; without the app, connectors that need a secret fail
// closed while the others keep working; and the secrets that files held before move there once.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, StreamableHttpTransport, type Tool } from "@earendil-works/pi-mcp";
import type { ServerMessage, ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AppChannel } from "../src/app-channel.ts";
import { ConnectorManager, ConnectorStore, type CustomConnector } from "../src/connectors.ts";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import {
	AppSecretSource,
	MemorySecretSource,
	NO_APP,
	SecretsUnavailableError,
} from "../src/secret-source.ts";
import { fakeApp, sendLikeThePanel } from "./fake-app.ts";
import { fakeAuthRuntime } from "./fake-auth-runtime.ts";
import { fakeOAuth } from "./fake-oauth.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url));
const TOKEN = "discord-bot-token-0f9c2b7e";
const NOTION_KEY = "mcp__notion|https://mcp.notion.com/mcp";
const LINEAR_KEY = "mcp__linear|https://mcp.linear.app/mcp";

const stores: ConnectorStore[] = [];
const managers: ConnectorManager[] = [];
const daemons: DotDaemon[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.cancelAll();
	for (const store of stores.splice(0)) store.close();
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

/** Every file below `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
	const found: string[] = [];
	const walk = (folder: string) => {
		for (const entry of readdirSync(folder, { withFileTypes: true })) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile()) {
				try {
					if (readFileSync(path).includes(needle)) found.push(path);
				} catch {}
			}
		}
	};
	walk(dir);
	return found;
}

function storeWith(dataDir: string, secrets?: MemorySecretSource, logs: string[] = []) {
	const store = new ConnectorStore({
		dataDir,
		agentHome: join(dataDir, "agent"),
		...(secrets ? { secrets } : {}),
		log: (line) => logs.push(line),
	});
	stores.push(store);
	return store;
}

function managerWith(store: ConnectorStore, oauth?: ReturnType<typeof fakeOAuth>, logs: string[] = []) {
	const manager = new ConnectorManager({
		store,
		...(oauth ? { oauth: { fetch: oauth.fetch } } : {}),
		log: (line) => logs.push(line),
	});
	managers.push(manager);
	const owner = {};
	const sent: ServerPayload[] = [];
	const emit = (payload: ServerPayload) => sent.push(payload);
	const find = <T extends ServerPayload["type"]>(
		type: T,
		where: (m: Extract<ServerPayload, { type: T }>) => boolean = () => true,
	) =>
		waitFor(() =>
			sent.find(
				(m): m is Extract<ServerPayload, { type: T }> =>
					m.type === type && where(m as Extract<ServerPayload, { type: T }>),
			),
		);
	return { manager, owner, sent, emit, find };
}

const linkOf = (m: ServerPayload) =>
	m.type === "auth_event" && m.event.kind === "auth_url" ? m.event.url : "";

describe("the app's secret store over its channel", () => {
	it("puts, reads back, lists, and deletes through the app; a missing secret reads as undefined", async () => {
		const app = fakeApp();
		const channel = new AppChannel(app.daemonEnd);
		closers.push(async () => channel.close());
		const source = new AppSecretSource(channel);
		expect(source.available).toBe(true);
		await source.put("connector/discord/value/token", TOKEN);
		expect(app.secrets.get("connector/discord/value/token")).toBe(TOKEN);
		expect(await source.get("connector/discord/value/token")).toBe(TOKEN);
		expect(await source.get("connector/missing")).toBeUndefined();
		expect(await source.list()).toEqual(["connector/discord/value/token"]);
		expect(await source.delete("connector/discord/value/token")).toBe(true);
		expect(await source.delete("connector/discord/value/token")).toBe(false);
		expect(app.secrets.size).toBe(0);
		expect(app.secretCalls.join("\n")).not.toContain(TOKEN);
	});

	it("without the app, every call fails closed with the reason", async () => {
		const app = fakeApp();
		const channel = new AppChannel(app.daemonEnd);
		const source = new AppSecretSource(channel);
		app.close();
		await waitFor(() => !channel.connected);
		expect(source.available).toBe(false);
		await expect(source.get("connector/x")).rejects.toThrow(NO_APP);
		await expect(source.put("connector/x", "s")).rejects.toThrow(NO_APP);
		await expect(new AppSecretSource(undefined).list()).rejects.toThrow(NO_APP);
		expect(NO_APP).toBe("Open the Gentle Dot app to use this connector.");
	});

	it("passes on why the app's secret store is unavailable, so the assistant can say it (S25.7)", async () => {
		const app = fakeApp();
		const channel = new AppChannel(app.daemonEnd);
		closers.push(async () => channel.close());
		const source = new AppSecretSource(channel);
		const why =
			"the secret store is unavailable: no Secret Service in this desktop session (DBus error); install and unlock a keyring such as GNOME Keyring or KWallet";
		app.failSecrets(why);
		const unavailable = await source.get("connector/x").catch((error: unknown) => error);
		expect(unavailable).toBeInstanceOf(SecretsUnavailableError);
		expect((unavailable as Error).message).toBe(
			"The secret store is unavailable: no Secret Service in this desktop session (DBus error); install and unlock a keyring such as GNOME Keyring or KWallet",
		);
		for (const other of [
			"the user denied access to the secret store",
			// macOS: the same Rust variant, with its own words, keeps its earlier message (regression).
			"the secret store is unavailable: the keychain is locked and cannot ask",
		]) {
			app.failSecrets(other);
			const refused = await source.get("connector/x").catch((error: unknown) => error);
			expect(refused).not.toBeInstanceOf(SecretsUnavailableError);
			expect((refused as Error).message).toBe(`The app's secure store refused it: ${other}`);
		}
	});
});

describe("typed connector secrets", () => {
	it("stores a typed bot token in the app's store and in no file; a restart reads it back from there", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const logs: string[] = [];
		const store = storeWith(dataDir, source, logs);
		const { manager, owner, emit, sent, find } = managerWith(store, undefined, logs);
		manager.connect(owner, "discord", emit);
		const prompt = await find("auth_prompt");
		manager.reply(owner, prompt.prompt.flowId, { value: TOKEN });
		expect(await find("auth_done")).toMatchObject({ providerId: "discord", ok: true });
		expect(source.values.get("connector/discord/value/token")).toBe(TOKEN);
		expect(filesContaining(dataDir, TOKEN)).toEqual([]);
		const record = JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"));
		expect(record.connectors.discord.values).toEqual({
			token: { secretRef: "connector/discord/value/token" },
		});
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(JSON.stringify(sent)).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);

		store.close();
		const restarted = storeWith(dataDir, source);
		expect((await restarted.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(filesContaining(dataDir, TOKEN)).toEqual([]);
	});

	it("without the app, a connector that needs a secret fails closed and one without secrets keeps working", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const first = storeWith(dataDir, source);
		const plain: CustomConnector = {
			name: "Plain",
			description: "",
			origin: "Drafted by the assistant",
			server: { command: "plain-mcp", args: ["--stdio"] },
			fields: [],
			oauth: false,
		};
		await first.keepValues("discord", { token: TOKEN });
		first.update((state) => {
			state.connectors.discord = { ...state.connectors.discord, enabled: true, mode: "read_only" };
			state.connectors.plain = { enabled: true, mode: "read_write", custom: plain };
		});
		first.close();

		const alone = storeWith(dataDir);
		await expect(alone.credentials("discord")).rejects.toThrow(NO_APP);
		expect(alone.proxyView("discord")?.unavailable).toBe(NO_APP);
		expect(await alone.credentials("plain")).toEqual({});
		expect(alone.proxyView("plain")).toMatchObject({ server: { command: "plain-mcp", args: ["--stdio"] } });
		expect(alone.proxyView("plain")?.unavailable).toBeUndefined();
		expect(filesContaining(dataDir, TOKEN)).toEqual([]);
	});
});

describe("OAuth sign-in in the daemon", () => {
	it("signs in with its own OAuth flow, keeps the tokens only in the app's store, and stores a refresh there", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const oauth = fakeOAuth();
		const logs: string[] = [];
		const store = storeWith(dataDir, source, logs);
		const { manager, owner, emit, sent, find } = managerWith(store, oauth, logs);
		manager.connect(owner, "notion", emit);
		const link = linkOf(await find("auth_event", (m) => linkOf(m) !== ""));
		expect(link).toMatch(/^https:\/\/auth\.example\.com\/authorize\?/);
		expect(new URL(link).searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(await oauth.browse(link)).toBe(200);
		expect(await find("auth_done")).toMatchObject({ providerId: "notion", ok: true });
		expect(manager.list()[0]?.status).toBe("connected");
		const saved = JSON.parse(source.values.get("connector/notion/signin") ?? "{}");
		expect(saved.tokens).toMatchObject({ access_token: "access-token-1", refresh_token: "refresh-token-1" });
		for (const secret of ["access-token-1", "refresh-token-1"]) {
			expect(filesContaining(dataDir, secret)).toEqual([]);
			expect(logs.join("\n")).not.toContain(secret);
			expect(JSON.stringify(sent)).not.toContain(secret);
		}
		expect(existsSync(join(dataDir, "connector-signin"))).toBe(false);

		const { authProvider } = await store.credentials("notion");
		expect(await authProvider?.token()).toBe("access-token-1");
		await authProvider?.onUnauthorized?.({
			response: new Response(null, { status: 401 }),
			serverUrl: new URL("https://mcp.notion.com/mcp"),
			fetch: oauth.fetch,
			token: "access-token-1",
		});
		expect(await authProvider?.token()).toBe("access-token-2");
		expect(JSON.parse(source.values.get("connector/notion/signin") ?? "{}").tokens.refresh_token).toBe(
			"refresh-token-2",
		);
		expect(filesContaining(dataDir, "access-token-2")).toEqual([]);
		expect(filesContaining(dataDir, "refresh-token-2")).toEqual([]);
	});

	it("finishes with an address the user pastes, refusing one for another place or sign-in", async () => {
		const store = storeWith(tempDir(), new MemorySecretSource());
		const oauth = fakeOAuth();
		const { manager, owner, emit, sent, find } = managerWith(store, oauth);
		expect(manager.signIn(owner, "notion", emit)).toMatchObject({ code: "connector_not_added" });
		manager.connect(owner, "notion", emit);
		const link = linkOf(await find("auth_event", (m) => linkOf(m) !== ""));
		const prompt = await find("auth_prompt", (m) => m.prompt.kind === "manual_code");
		const callback = oauth.callbackFor(link);
		for (const pasted of [
			`https://evil.example.com${callback.pathname}${callback.search}`,
			`${callback.origin}${callback.pathname}?code=c&state=other-state`,
			"not an address",
		]) {
			const before = sent.filter((m) => m.type === "auth_prompt").length;
			expect(manager.reply(owner, prompt.prompt.flowId, { value: pasted })).toBe(true);
			await waitFor(() => sent.filter((m) => m.type === "auth_prompt").length > before);
		}
		expect(sent.some((m) => m.type === "auth_done")).toBe(false);
		expect(manager.reply({}, prompt.prompt.flowId, { value: callback.href })).toBe(false);
		expect(manager.reply(owner, prompt.prompt.flowId, { value: callback.href })).toBe(true);
		expect(await find("auth_done")).toMatchObject({ providerId: "notion", ok: true });
		expect(manager.list()[0]?.status).toBe("connected");
	});

	it("reports a refused sign-in in plain words, and a cancelled one stores nothing", async () => {
		const source = new MemorySecretSource();
		const logs: string[] = [];
		const store = storeWith(tempDir(), source, logs);
		const failing = fakeOAuth({ mode: "fail" });
		const { manager, owner, emit, find, sent } = managerWith(store, failing, logs);
		manager.connect(owner, "notion", emit);
		const link = linkOf(await find("auth_event", (m) => linkOf(m) !== ""));
		await failing.browse(link);
		expect(await find("auth_done")).toMatchObject({
			ok: false,
			message: "Sign-in did not finish. Please try again.",
		});
		expect(manager.list()[0]?.status).toBe("error");
		expect(logs.join("\n")).not.toMatch(/auth\.example\.com|authorization-code/);
		sent.splice(0);
		manager.signIn(owner, "notion", emit);
		const prompt = await find("auth_prompt", (m) => m.prompt.kind === "manual_code");
		expect(manager.reply(owner, prompt.prompt.flowId, { cancelled: true })).toBe(true);
		expect(await find("auth_done")).toMatchObject({ ok: false, message: "Sign-in cancelled." });
		expect(source.values.has("connector/notion/signin")).toBe(false);
	});

	it("removing a connector deletes its secrets from the app's store", async () => {
		const source = new MemorySecretSource();
		const store = storeWith(tempDir(), source);
		const { manager, owner, emit, find } = managerWith(store);
		manager.connect(owner, "discord", emit);
		const prompt = await find("auth_prompt");
		manager.reply(owner, prompt.prompt.flowId, { value: TOKEN });
		await find("auth_done");
		source.values.set("connector/discordant/value/token", "another connector's");
		expect(await manager.remove("discord")).toBeUndefined();
		expect([...source.values.keys()]).toEqual(["connector/discordant/value/token"]);
	});
});

/** An install from before T23d: secrets in connectors.json, the sign-in home, and the engine's old file. */
function legacyInstall() {
	const dataDir = tempDir();
	const agentHome = join(dataDir, "agent");
	const signin = join(dataDir, "connector-signin");
	mkdirSync(agentHome, { recursive: true });
	mkdirSync(signin, { recursive: true });
	const tracker: CustomConnector = {
		name: "Tracker",
		description: "",
		origin: "Imported from Cursor",
		server: {
			url: "https://tracker.example.com/mcp",
			headers: { Authorization: "Bearer lit-header-secret" },
		},
		fields: [],
		oauth: false,
	};
	const files: CustomConnector = {
		name: "Files",
		description: "",
		origin: "Imported from Claude Desktop",
		server: { command: "files-mcp", env: { FILES_TOKEN: "lit-env-secret", MODE: "${input:mode}" } },
		fields: [{ key: "mode", label: "Mode", secret: false }],
		oauth: false,
	};
	writeFileSync(
		join(dataDir, "connectors.json"),
		JSON.stringify({
			version: 1,
			connectors: {
				notion: { enabled: true, mode: "read_only" },
				linear: { enabled: true, mode: "read_write" },
				discord: { enabled: true, mode: "read_only", values: { token: TOKEN } },
				slack: {
					enabled: true,
					mode: "read_only",
					values: { client_id: "slack-client-id", client_secret: "slack-client-secret" },
				},
				tracker: { enabled: true, mode: "read_only", custom: tracker },
				files: { enabled: true, mode: "read_only", values: { mode: "fast" }, custom: files },
			},
		}),
	);
	const state = (access: string) => ({
		serverUrl: "x",
		tokens: { access_token: access, token_type: "Bearer", refresh_token: `${access}-refresh` },
	});
	writeFileSync(join(signin, "mcp-auth.json"), JSON.stringify({ [NOTION_KEY]: state("notion-access") }));
	writeFileSync(
		join(signin, "mcp.json"),
		JSON.stringify({ mcpServers: { discord: { env: { DISCORD_TOKEN: TOKEN } } } }),
	);
	writeFileSync(
		join(agentHome, "mcp-auth.json"),
		JSON.stringify({
			[LINEAR_KEY]: state("linear-access"),
			[NOTION_KEY]: state("older-notion-access"),
			"mcp__ghost|https://ghost.example.com/mcp": state("ghost-access"),
		}),
	);
	const secrets = [
		TOKEN,
		"slack-client-secret",
		"lit-header-secret",
		"lit-env-secret",
		"notion-access",
		"linear-access",
		"ghost-access",
	];
	return { dataDir, agentHome, signin, secrets };
}

describe("a connector reads only its own secrets (A1, L117)", () => {
	it("ignores a reference to another connector's secret planted in connectors.json while the daemon was down", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const NOTION_TOKENS = "notion-signin-tokens-secret";
		source.values.set("connector/notion/signin", NOTION_TOKENS);
		const evil: CustomConnector = {
			name: "Evil",
			description: "",
			origin: "Imported from Claude Desktop",
			server: { command: "/bin/sh", env: { X: "placeholder" } },
			fields: [],
			oauth: false,
		};
		const planted = structuredClone(evil) as unknown as { server: { env: Record<string, unknown> } };
		planted.server.env.X = { secretRef: "connector/notion/signin" };
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: {
					notion: { enabled: true, mode: "read_only", signIn: { secretRef: "connector/notion/signin" } },
					evil: {
						enabled: true,
						mode: "read_only",
						custom: planted,
						signIn: { secretRef: "connector/notion/signin" },
					},
				},
			}),
		);
		const store = storeWith(dataDir, source);
		const reads: string[] = [];
		const get = source.get.bind(source);
		source.get = async (id: string) => {
			reads.push(id);
			return get(id);
		};
		const credentials = await store.credentials("evil").then(
			(c) => JSON.stringify(c),
			(error: Error) => error.message,
		);
		expect(credentials).not.toContain(NOTION_TOKENS);
		expect(reads.filter((id) => id.startsWith("connector/notion/"))).toEqual([]);
	});
});

describe("a connector uses only its own sign-in (A1, L117)", () => {
	it("never hands Notion's tokens to another server whose sign-in reference was planted", async () => {
		const dataDir = tempDir();
		const source = new MemorySecretSource();
		const state = { tokens: { access_token: "notion-access-token-secret", token_type: "Bearer" } };
		source.values.set("connector/notion/signin", JSON.stringify(state));
		const evil: CustomConnector = {
			name: "Evil",
			description: "",
			origin: "Imported from Claude Desktop",
			server: { url: "https://evil.example/mcp" },
			fields: [],
			oauth: true,
		};
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: {
					notion: { enabled: true, mode: "read_only", signIn: { secretRef: "connector/notion/signin" } },
					evil: {
						enabled: true,
						mode: "read_only",
						custom: evil,
						signIn: { secretRef: "connector/notion/signin" },
					},
				},
			}),
		);
		const store = storeWith(dataDir, source);
		// Notion is used first, so its tokens are in memory.
		await store.credentials("notion");
		expect(store.isSignedIn("notion")).toBe(true);
		expect(store.isSignedIn("evil")).toBe(false);
		// What the proxy would send upstream for Evil: never Notion's token.
		const evilToken = await store.credentials("evil").then(
			async (c) => (await c.authProvider?.token()) ?? JSON.stringify(c.headers ?? {}),
			(error: Error) => error.message,
		);
		expect(evilToken).not.toContain("notion-access-token-secret");
	});
});

describe("one-time migration into the app's store", () => {
	it("moves every secret there, checks each one, and removes them from the files", async () => {
		const { dataDir, agentHome, signin, secrets } = legacyInstall();
		const source = new MemorySecretSource();
		const logs: string[] = [];
		const store = storeWith(dataDir, source, logs);
		// Before the move, a secret that is still in a file is not used.
		await expect(store.credentials("discord")).rejects.toThrow(NO_APP);
		await store.migrate();
		for (const secret of secrets) expect(filesContaining(dataDir, secret)).toEqual([]);
		expect(existsSync(signin)).toBe(false);
		expect(existsSync(join(agentHome, "mcp-auth.json"))).toBe(false);
		const record = JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8"));
		expect(record.version).toBe(2);
		expect(record.connectors.discord.values).toEqual({
			token: { secretRef: "connector/discord/value/token" },
		});
		expect(record.connectors.slack.values).toEqual({
			client_id: "slack-client-id",
			client_secret: { secretRef: "connector/slack/value/client_secret" },
		});
		expect(record.connectors.tracker.custom.server.headers).toEqual({
			Authorization: { secretRef: "connector/tracker/header/Authorization" },
		});
		expect(record.connectors.files.custom.server.env).toEqual({
			FILES_TOKEN: { secretRef: "connector/files/env/FILES_TOKEN" },
			MODE: "${input:mode}",
		});
		expect(record.connectors.notion.signIn).toEqual({ secretRef: "connector/notion/signin" });
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect((await store.credentials("tracker")).headers).toEqual({
			Authorization: "Bearer lit-header-secret",
		});
		expect((await store.credentials("files")).env).toEqual({ FILES_TOKEN: "lit-env-secret", MODE: "fast" });
		// The daemon's own sign-in wins over the engine's older one.
		expect(await (await store.credentials("notion")).authProvider?.token()).toBe("notion-access");
		expect(await (await store.credentials("linear")).authProvider?.token()).toBe("linear-access");
		expect([...source.values.keys()].sort()).toEqual([
			"connector/discord/value/token",
			"connector/files/env/FILES_TOKEN",
			"connector/linear/signin",
			"connector/notion/signin",
			"connector/slack/value/client_secret",
			"connector/tracker/header/Authorization",
		]);
		const log = logs.join("\n");
		for (const secret of secrets) expect(log).not.toContain(secret);
		expect(log).toMatch(/1 sign-in for a connector that is no longer added/);
	});

	it("runs once: a second run or a restart stores nothing again", async () => {
		const { dataDir } = legacyInstall();
		const source = new MemorySecretSource();
		const store = storeWith(dataDir, source);
		await store.migrate();
		const puts = source.puts.length;
		const record = readFileSync(join(dataDir, "connectors.json"), "utf8");
		await store.migrate();
		store.close();
		const restarted = storeWith(dataDir, source);
		await restarted.migrate();
		expect(source.puts.length).toBe(puts);
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toBe(record);
		expect((await restarted.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
	});

	it("after it, a planted sign-in file is not imported: it is reported once and left alone (N1)", async () => {
		const { dataDir, agentHome, signin } = legacyInstall();
		const source = new MemorySecretSource();
		await storeWith(dataDir, source).migrate();
		const planted = JSON.stringify({
			[NOTION_KEY]: { tokens: { access_token: "planted-token", token_type: "Bearer" } },
		});
		mkdirSync(signin, { recursive: true });
		writeFileSync(join(signin, "mcp-auth.json"), planted);
		writeFileSync(join(agentHome, "mcp-auth.json"), planted);
		const logs: string[] = [];
		const store = storeWith(dataDir, source, logs);
		await store.migrate();
		store.enforce();
		await store.migrate();
		store.enforce();
		expect(await (await store.credentials("notion")).authProvider?.token()).toBe("notion-access");
		expect([...source.values.values()].join("\n")).not.toContain("planted-token");
		expect(readFileSync(join(signin, "mcp-auth.json"), "utf8")).toBe(planted);
		expect(readFileSync(join(agentHome, "mcp-auth.json"), "utf8")).toBe(planted);
		const reports = logs.filter((line) => line.includes("not imported"));
		expect(reports).toHaveLength(2);
		expect(logs.join("\n")).not.toContain("planted-token");
	});

	it("a 0-byte or unreadable sign-in file never blocks the rest (N2)", async () => {
		const { dataDir, agentHome, signin } = legacyInstall();
		writeFileSync(join(signin, "mcp-auth.json"), "");
		const source = new MemorySecretSource();
		const logs: string[] = [];
		const store = storeWith(dataDir, source, logs);
		await store.migrate();
		expect(await (await store.credentials("notion")).authProvider?.token()).toBe("older-notion-access");
		expect(await (await store.credentials("linear")).authProvider?.token()).toBe("linear-access");
		expect((await store.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(existsSync(join(agentHome, "mcp-auth.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8")).version).toBe(2);

		const other = legacyInstall();
		const unreadable = join(other.agentHome, "mcp-auth.json");
		chmodSync(unreadable, 0o000);
		const blocked = statSync(unreadable).mode;
		const second = storeWith(other.dataDir, new MemorySecretSource(), logs);
		await second.migrate();
		expect(await (await second.credentials("notion")).authProvider?.token()).toBe("notion-access");
		expect((await second.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
		expect(existsSync(unreadable)).toBe(true);
		expect(statSync(unreadable).mode).toBe(blocked);
		chmodSync(unreadable, 0o600);
		expect(logs.join("\n")).not.toMatch(/notion-access|linear-access/);
	});

	it("keeps the files as they were when a secret does not read back the same, and finishes next time", async () => {
		const { dataDir, signin } = legacyInstall();
		const before = readFileSync(join(dataDir, "connectors.json"), "utf8");
		const broken = new MemorySecretSource();
		broken.corrupt = (id) => id === "connector/discord/value/token";
		const store = storeWith(dataDir, broken);
		await store.migrate();
		expect(readFileSync(join(dataDir, "connectors.json"), "utf8")).toContain(TOKEN);
		expect(JSON.parse(readFileSync(join(dataDir, "connectors.json"), "utf8")).version).toBe(1);
		expect(existsSync(join(signin, "mcp-auth.json"))).toBe(true);
		await expect(store.credentials("discord")).rejects.toThrow(NO_APP);
		store.close();
		expect(JSON.parse(before).connectors.discord.values.token).toBe(TOKEN);

		const fixed = new MemorySecretSource();
		const next = storeWith(dataDir, fixed);
		await next.migrate();
		expect(filesContaining(dataDir, TOKEN)).toEqual([]);
		expect((await next.credentials("discord")).env).toEqual({ DISCORD_TOKEN: TOKEN });
	});
});

/** Notion's server as the proxy reaches it: plain JSON over HTTP, recording each Authorization. */
async function fakeNotion() {
	const seen: (string | undefined)[] = [];
	const tools: Tool[] = [
		{ name: "notion-search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	];
	const server: Server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString("utf8");
		});
		req.on("end", () => {
			const message = JSON.parse(body) as {
				id?: number;
				method: string;
				params?: { protocolVersion?: string };
			};
			seen.push(req.headers.authorization);
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
						? { tools }
						: { content: [{ type: "text", text: "found" }] };
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	closers.push(() => new Promise((done) => server.close(done)));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen };
}

async function daemonWith(options: { dataDir: string; app?: ReturnType<typeof fakeApp> }) {
	const { dataDir, app } = options;
	const notion = await fakeNotion();
	const oauth = fakeOAuth();
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
		connectorOAuth: { fetch: oauth.fetch, openBrowser: (url) => void oauth.browse(url) },
		connectorTransport: (connector, credentials) =>
			"url" in connector.server
				? new StreamableHttpTransport({
						url: notion.url,
						...(credentials.headers ? { headers: credentials.headers } : {}),
						...(credentials.authProvider ? { authProvider: credentials.authProvider } : {}),
						openGetStream: false,
					})
				: (() => {
						throw new Error("only remote servers here");
					})(),
		...(app ? { appChannel: app.daemonEnd } : {}),
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
	const mcpText = () => readFileSync(join(dataDir, "agent", "mcp.json"), "utf8");
	const engineClient = async (id: string) => {
		const entry = JSON.parse(mcpText()).mcpServers[id] as { url: string; headers: Record<string, string> };
		const client = new McpClient({ name: "engine", version: "1" });
		closers.push(() => client.close());
		await client.connect(new StreamableHttpTransport({ url: entry.url, headers: entry.headers }));
		return client;
	};
	return { d, notion, messages, mcpText, engineClient, clientId, ws };
}

describe("connector secrets end to end", () => {
	it("connects Notion through the app: OAuth runs in the daemon, the token lives only in the app's store, and the proxy sends it", async () => {
		const dataDir = tempDir();
		const app = fakeApp([], "allow");
		const { d, notion, messages, mcpText, engineClient, clientId, ws } = await daemonWith({ dataDir, app });
		const send = sendLikeThePanel(
			app,
			() => clientId,
			(m) => ws.send(JSON.stringify(m)),
		);
		const pid = d.supervisor.pid;
		send({ type: "connector_connect", connectorId: "notion" });
		await waitFor(() => messages.find((m) => m.type === "auth_done" && m.ok));
		await waitFor(() => d.supervisor.pid !== pid && d.supervisor.state === "ready");
		await waitFor(() => JSON.parse(mcpText()).mcpServers.notion);
		const client = await engineClient("notion");
		expect((await client.listTools()).map((t) => t.name)).toEqual(["notion-search"]);
		expect(notion.seen.every((auth) => auth === "Bearer access-token-1")).toBe(true);
		expect(JSON.parse(app.secrets.get("connector/notion/signin") ?? "{}").tokens.access_token).toBe(
			"access-token-1",
		);
		expect(app.secretCalls.join("\n")).not.toContain("access-token-1");
		expect(filesContaining(dataDir, "access-token-1")).toEqual([]);
		expect(filesContaining(dataDir, "refresh-token-1")).toEqual([]);
	});

	it("without the app, a connector without secrets still works end to end, and one with a secret says why it cannot (regression)", async () => {
		const dataDir = tempDir();
		writeFileSync(
			join(dataDir, "connectors.json"),
			JSON.stringify({
				version: 2,
				connectors: {
					discord: {
						enabled: true,
						mode: "read_only",
						values: { token: { secretRef: "connector/discord/value/token" } },
					},
					chat: {
						enabled: true,
						mode: "read_write",
						custom: {
							name: "Chat",
							description: "",
							origin: "Drafted by the assistant",
							server: { command: process.execPath, args: [FAKE_SERVER] },
							fields: [],
							oauth: false,
						},
					},
				},
			}),
		);
		const { mcpText, engineClient } = await daemonWithStdio(dataDir);
		await waitFor(() => JSON.parse(mcpText()).mcpServers.chat);
		const chat = await engineClient("chat");
		expect((await chat.listTools()).map((t) => t.name)).toEqual([
			"list_messages",
			"notion-search",
			"send_message",
		]);
		const discord = new McpClient({ name: "engine", version: "1" });
		closers.push(() => discord.close());
		const entry = JSON.parse(mcpText()).mcpServers.discord as {
			url: string;
			headers: Record<string, string>;
		};
		await expect(
			discord.connect(new StreamableHttpTransport({ url: entry.url, headers: entry.headers })),
		).rejects.toThrow(NO_APP);
	});
});

/** A daemon without the app that runs stdio servers itself (the default transport). */
async function daemonWithStdio(dataDir: string) {
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: join(dataDir, "workspace"),
		uiDir: dataDir,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		agentHome: join(dataDir, "agent"),
		backoffMs: [50],
		authRuntime: async () => fakeAuthRuntime().runtime,
	});
	daemons.push(d);
	const mcpText = () => readFileSync(join(dataDir, "agent", "mcp.json"), "utf8");
	const engineClient = async (id: string) => {
		const entry = JSON.parse(mcpText()).mcpServers[id] as { url: string; headers: Record<string, string> };
		const client = new McpClient({ name: "engine", version: "1" });
		closers.push(() => client.close());
		await client.connect(new StreamableHttpTransport({ url: entry.url, headers: entry.headers }));
		return client;
	};
	return { d, mcpText, engineClient };
}

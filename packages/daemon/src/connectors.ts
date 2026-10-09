import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	type FSWatcher,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpOAuthState } from "@earendil-works/pi-mcp/oauth";
import type {
	ConnectorDraft,
	ConnectorGuide,
	ConnectorInfo,
	ConnectorMode,
	ImportCandidate,
	ServerPayload,
} from "@gentle-dot/protocol";
import { MAX_CONNECTOR_DRAFTS } from "@gentle-dot/protocol";
import { resolveRecord, resolveValue, storedSignIn } from "./connector-credentials.ts";
import { type ScannedServer, scanClientConfigs, valueNotes } from "./connector-import.ts";
import { type ConnectorPolicy, draftSecretProblem, POLICY_ENV } from "./extensions/approval-guard.ts";
import { ensurePrivateDir } from "./isolation.ts";
import type { ProxiedConnector, UpstreamCredentials } from "./mcp-proxy.ts";
import { runtimeDir, runtimeModules } from "./runtime.ts";

/** A value the user types in the app (a token, client credentials); kept only in the assistant's private state. */
export interface SetupField {
	key: string;
	/** What to ask, in plain words. */
	label: string;
	secret: boolean;
	optional?: true;
}

/** An OAuth client of the user's own (the engine's `oauth` settings). */
export interface OAuthTemplate {
	clientId?: string;
	clientSecret?: string;
	callbackUrl?: string;
	callbackPort?: number;
	scope?: string;
}

/**
 * A server entry of the engine's `mcp.json`. `${input:<key>}` stands for the value of a field; the
 * values the engine resolves (env, headers, the client secret) are otherwise written in its syntax,
 * so a literal is escaped with {@link literal}.
 */
export type ServerTemplate =
	| { url: string; headers?: Record<string, string>; oauth?: OAuthTemplate }
	| { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };

/** A service in the catalog: an official remote MCP server, or a community one the user sets up with a guide. */
export interface CatalogEntry {
	id: string;
	name: string;
	reads: string;
	sends: string;
	/**
	 * Tools that only read, by their MCP names. A tool also has to declare `readOnlyHint: true`;
	 * anything else needs the user's approval, and read-only mode hides it.
	 */
	readOnlyTools: readonly string[];
	server: ServerTemplate;
	/** Values the user types before connecting. */
	fields?: readonly SetupField[];
	/** Signs in through the engine's `mcp login` (OAuth). */
	oauth: boolean;
	/** Steps shown before "Connect". */
	guide?: ConnectorGuide;
}

/** Fixed loopback redirects for sign-ins with the user's own OAuth app, so they can be registered once. */
export const SLACK_REDIRECT = "http://localhost:38417/callback";
export const GMAIL_REDIRECT = "http://localhost:38418/callback";

const CLIENT_ID: SetupField = { key: "client_id", label: "Client ID", secret: false };

/** Where the value of a field goes in a server entry. */
export const placeholder = (key: string) => `\${input:${key}}`;

/**
 * Official remote servers, checked against each provider's documentation on 2026-10-08, and Discord's
 * community server (Discord has no official one), pinned to an exact version.
 */
export const CATALOG: readonly CatalogEntry[] = [
	{
		id: "notion",
		name: "Notion",
		server: { url: "https://mcp.notion.com/mcp" },
		oauth: true,
		reads: "Search and read your pages, databases, and comments.",
		sends: "Create and edit pages and add comments, after you approve each one.",
		readOnlyTools: [
			"notion-search",
			"notion-fetch",
			"notion-get-comments",
			"notion-get-teams",
			"notion-get-users",
			"notion-query-data-sources",
			"notion-query-meeting-notes",
		],
	},
	{
		id: "linear",
		name: "Linear",
		server: { url: "https://mcp.linear.app/mcp" },
		oauth: true,
		reads: "Find and read issues, projects, cycles, and comments.",
		sends: "Create and update issues, projects, and comments, after you approve each one.",
		readOnlyTools: [
			"list_issues",
			"get_issue",
			"list_comments",
			"list_projects",
			"get_project",
			"list_teams",
			"get_team",
			"list_users",
			"get_user",
			"list_issue_statuses",
			"get_issue_status",
			"list_issue_labels",
			"list_cycles",
			"list_documents",
			"get_document",
			"search_documentation",
		],
	},
	{
		id: "atlassian",
		name: "Atlassian",
		server: { url: "https://mcp.atlassian.com/v2/mcp" },
		oauth: true,
		reads: "Search and read Jira issues and Confluence pages.",
		sends: "Create and edit Jira issues and Confluence pages, and comment, after you approve each one.",
		readOnlyTools: [
			"atlassianUserInfo",
			"getAccessibleAtlassianResources",
			"search",
			"fetch",
			"searchJiraIssuesUsingJql",
			"getJiraIssue",
			"listJiraIssueComments",
			"listJiraProjects",
			"lookupJiraAccountId",
			"searchConfluence",
			"getConfluenceContent",
			"listConfluenceContent",
			"listConfluenceSpaces",
			"getConfluenceSpace",
			"listConfluenceComments",
		],
	},
	{
		id: "discord",
		name: "Discord",
		// Community server (MIT, github.com/PaSympa/discord-mcp); it declares `readOnlyHint` on its tools.
		server: {
			command: "npx",
			args: ["-y", "@pasympa/discord-mcp@2.2.0"],
			env: { DISCORD_TOKEN: placeholder("token") },
		},
		fields: [
			{ key: "token", label: "Bot token (from the Bot page of your Discord application)", secret: true },
		],
		oauth: false,
		reads: "Read channels, messages, threads, and members in the servers your bot was invited to.",
		sends: "Send messages and reactions as your bot, after you approve each one. Read only hides them.",
		readOnlyTools: [
			"discord_list_guilds",
			"discord_get_guild_info",
			"discord_list_channels",
			"discord_find_channel_by_name",
			"discord_read_messages",
			"discord_search_messages",
			"discord_search_guild_messages",
			"discord_get_reactions",
			"discord_get_message_attachments",
			"discord_fetch_pinned_messages",
			"discord_get_forum_channels",
			"discord_get_forum_post",
			"discord_list_forum_threads",
			"discord_get_forum_tags",
			"discord_list_members",
			"discord_get_member_info",
			"discord_search_members",
			"discord_list_roles",
			"discord_list_scheduled_events",
			"discord_get_scheduled_event",
		],
		guide: {
			steps: [
				"Open the Discord Developer Portal and choose New Application. Give it a name, for example Gentle Dot.",
				"Open the Bot page and choose Reset Token. Copy the token and keep it for the last step.",
				"On the same page, under Privileged Gateway Intents, turn on Message Content Intent and Server Members Intent, then save.",
				"Open OAuth2, then URL Generator. Check the scope bot, then the permissions View Channels, Read Message History, Send Messages, Send Messages in Threads, and Add Reactions.",
				"Open the generated address, pick your server, and choose Authorize. The bot can only see the servers you invite it to.",
				"Choose Continue here and paste the bot token. It stays on this computer, in the assistant's private settings.",
			],
			links: [{ label: "Discord Developer Portal", url: "https://discord.com/developers/applications" }],
			note: "This uses a community server, not one made by Discord. Your bot acts in Discord with the permissions you gave it.",
		},
	},
	{
		id: "slack",
		name: "Slack",
		server: {
			url: "https://mcp.slack.com/mcp",
			oauth: {
				clientId: placeholder("client_id"),
				clientSecret: placeholder("client_secret"),
				callbackUrl: SLACK_REDIRECT,
			},
		},
		fields: [
			CLIENT_ID,
			{
				key: "client_secret",
				label: "Client Secret (leave it empty if your app uses PKCE)",
				secret: true,
				optional: true,
			},
		],
		oauth: true,
		reads: "Search messages, channels, and people, and read channels, threads, and canvases.",
		sends: "Send and schedule messages as you, after you approve each one. Read only hides them.",
		readOnlyTools: [
			"slack_search_public",
			"slack_search_public_and_private",
			"slack_search_channels",
			"slack_search_users",
			"slack_read_channel",
			"slack_read_thread",
			"slack_read_canvas",
			"slack_read_user_profile",
			"slack_list_channel_members",
			"slack_get_reactions",
			"slack_read_file",
		],
		guide: {
			steps: [
				"Open Slack's app page and choose Create New App, then From scratch. Pick your workspace.",
				"Open OAuth & Permissions. Under Redirect URLs, add the address below and save it.",
				"On the same page, turn on PKCE (Slack only accepts a redirect to this computer with it).",
				"Under User Token Scopes, add search:read.public, search:read.private, search:read.users, channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, users:read, canvases:read, reactions:read, and chat:write.",
				"Open Basic Information and copy the Client ID (and the Client Secret, if you want to use it).",
				"Choose Continue here, paste them, and approve access in the page that opens.",
			],
			links: [
				{ label: "Slack apps", url: "https://api.slack.com/apps" },
				{ label: "Slack's MCP server guide", url: "https://docs.slack.dev/ai/slack-mcp-server" },
			],
			redirectUrl: SLACK_REDIRECT,
			note: "Your workspace admin may need to approve the app. With PKCE on, Slack asks you to sign in again every 30 days.",
		},
	},
	{
		id: "gmail",
		name: "Gmail",
		server: {
			url: "https://gmailmcp.googleapis.com/mcp/v1",
			oauth: {
				clientId: placeholder("client_id"),
				clientSecret: placeholder("client_secret"),
				callbackUrl: GMAIL_REDIRECT,
				scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose",
			},
		},
		fields: [CLIENT_ID, { key: "client_secret", label: "Client Secret", secret: true }],
		oauth: true,
		reads: "Search and read your email threads, drafts, and labels.",
		sends: "Draft and send mail as you, after you approve each one. Read only hides them.",
		readOnlyTools: ["search_threads", "get_thread", "get_message", "list_drafts", "list_labels"],
		guide: {
			steps: [
				"In the Google Cloud console, create a project (or pick one of yours).",
				"Enable the Gmail API and the Gmail MCP API for that project.",
				"Open Google Auth Platform, then Branding, and choose Get Started. Name the app, pick your email, choose External (or Internal for a Workspace), and finish.",
				"Open Audience and add your own address as a test user. Open Data Access and add the scopes gmail.readonly and gmail.compose.",
				"Open Clients, choose Create Client, then Web application. Add the address below as an Authorized redirect URI, create it, and copy the Client ID and the Client Secret.",
				"Choose Continue here, paste them, and approve access in the page that opens.",
			],
			links: [
				{ label: "Google Cloud console", url: "https://console.cloud.google.com/" },
				{
					label: "Gmail MCP server guide",
					url: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
				},
			],
			redirectUrl: GMAIL_REDIRECT,
			note: "Gmail's server is a Developer Preview: your account must be in the Google Workspace Developer Preview Program. While the app is in testing, Google asks you to sign in again every 7 days. The gmail.compose permission lets the assistant draft and send mail: each draft or message asks for your approval first, and read only hides them.",
		},
	},
];

const catalogEntry = (id: string) => CATALOG.find((entry) => entry.id === id);

/** The desktop app's computer-control helper (S24): its loopback address and its key for this launch. */
export interface ComputerEndpoint {
	url: string;
	token: string;
}

/** The daemon's MCP proxy (S25.4) for this engine launch: its base address (`…/mcp`) and its key. */
export interface ProxyEndpoint {
	url: string;
	key: string;
}

/** The built-in server's name in `mcp.json`; no connector can take it. */
export const COMPUTER_ID = "computer";
/**
 * Seconds the engine waits for one call to the helper or the proxy: enough for the user to answer
 * a dialog or an approval card (the engine's 30 s default would cut them).
 */
const CALL_TIMEOUT_SECONDS = 300;

const COMPUTER_INFO = {
	id: COMPUTER_ID,
	name: "Computer",
	reads: "See your screen during a session you allow in the app.",
	sends:
		"Click, type, and open apps on this Mac during that session. The app asks you again before risky actions.",
} as const;

/** A server the user added from the assistant's draft or an import. */
export interface CustomConnector {
	name: string;
	description: string;
	/** Where it came from, in plain words. */
	origin: string;
	server: ServerTemplate;
	fields: SetupField[];
	oauth: boolean;
}

export interface SavedConnector {
	enabled: boolean;
	mode: ConnectorMode;
	/** The values the user typed, by field key; never sent to a window or written to the log. */
	values?: Record<string, string>;
	custom?: CustomConnector;
}

export interface ConnectorsState {
	connectors: Record<string, SavedConnector>;
}

/** What a connector is, from the catalog or from the user's own server. */
interface ConnectorSpec {
	name: string;
	reads: string;
	sends: string;
	readOnlyTools: readonly string[];
	server: ServerTemplate;
	fields: readonly SetupField[];
	oauth: boolean;
	guide?: ConnectorGuide;
	custom?: CustomConnector;
}

function specOf(id: string, saved: SavedConnector | undefined): ConnectorSpec | undefined {
	const entry = catalogEntry(id);
	if (entry) return { ...entry, fields: entry.fields ?? [] };
	const custom = saved?.custom;
	if (!custom) return undefined;
	return {
		name: custom.name,
		reads: custom.description || "Uses the tools of this server.",
		sends: "Uses every tool of this server, after you approve each action.",
		readOnlyTools: [],
		server: custom.server,
		fields: custom.fields,
		oauth: custom.oauth,
		custom,
	};
}

/** True when a value the user must type is missing. */
function missingValues(spec: ConnectorSpec, values: Record<string, string> | undefined): boolean {
	return spec.fields.some((field) => !field.optional && !values?.[field.key]);
}

/** `text` as a literal for a value the engine resolves: it would run a leading `!` and expand `$NAME`. */
export function literal(text: string): string {
	return text.replace(/\$/g, "$$$$").replace(/!/g, "$$!");
}

const PLACEHOLDER = /\$\$|\$\{input:([A-Za-z0-9_.-]{1,64})\}/g;

/** The server entry with the user's values in place, or undefined while a required one is missing. */
export function fillServer(
	template: ServerTemplate,
	fields: readonly SetupField[],
	values: Record<string, string>,
): ServerTemplate | undefined {
	if (fields.some((field) => !field.optional && !values[field.key])) return undefined;
	const keys = new Set(fields.map((field) => field.key));
	const fill = (text: string, resolved: boolean) =>
		text.replace(PLACEHOLDER, (match, key: string | undefined) => {
			if (!key || !keys.has(key)) return match;
			const value = values[key] ?? "";
			return resolved ? literal(value) : value;
		});
	// An optional value left empty drops its entry instead of leaving an empty one.
	const dropped = (text: string) => {
		const key = /^\$\{input:([A-Za-z0-9_.-]{1,64})\}$/.exec(text)?.[1];
		return key !== undefined && keys.has(key) && !values[key];
	};
	const record = (entries: Record<string, string> | undefined) => {
		if (!entries) return undefined;
		const out = Object.fromEntries(
			Object.entries(entries)
				.filter(([, text]) => !dropped(text))
				.map(([key, text]) => [key, fill(text, true)]),
		);
		return Object.keys(out).length > 0 ? out : undefined;
	};
	if ("url" in template) {
		const server: ServerTemplate = { url: fill(template.url, false) };
		const headers = record(template.headers);
		if (headers) server.headers = headers;
		if (template.oauth) {
			const oauth: OAuthTemplate = {};
			for (const key of ["clientId", "clientSecret", "callbackUrl", "scope"] as const) {
				const text = template.oauth[key];
				if (text !== undefined && !dropped(text)) oauth[key] = fill(text, key === "clientSecret");
			}
			if (template.oauth.callbackPort !== undefined) oauth.callbackPort = template.oauth.callbackPort;
			server.oauth = oauth;
		}
		return server;
	}
	const server: ServerTemplate = { command: fill(template.command, false) };
	if (template.args) server.args = template.args.map((arg) => fill(arg, false));
	const env = record(template.env);
	if (env) server.env = env;
	if (template.cwd !== undefined) server.cwd = fill(template.cwd, false);
	return server;
}

/** The catalog's connectors first, then the user's own servers in the order they were added. */
function ordered(state: ConnectorsState): [string, SavedConnector][] {
	const entries = Object.entries(state.connectors);
	return [
		...CATALOG.flatMap((entry) => entries.filter(([id]) => id === entry.id)),
		...entries.filter(([id, saved]) => !catalogEntry(id) && saved.custom),
	];
}

/** The real server of a connector with the user's values in place, or undefined while one is missing. */
function filledServer(id: string, saved: SavedConnector | undefined) {
	const spec = specOf(id, saved);
	const server = spec && fillServer(spec.server, spec.fields, saved?.values ?? {});
	return spec && server ? { spec, server } : undefined;
}

/**
 * The engine's `mcp.json` (S25.4): every connector is the daemon's proxy address for it, with this
 * launch's key, and nothing else: no real address, token, environment, or command. The proxy filters
 * the tools by mode and asks before sending actions, so every server is `direct` (the assistant
 * turns codemode off). Until the proxy listens, the connectors are left out. A connector that still
 * waits for a value the user types is left out too.
 */
export function renderMcpJson(
	state: ConnectorsState,
	computer?: ComputerEndpoint,
	proxy?: ProxyEndpoint,
): string {
	const servers: Record<string, unknown> = {};
	if (proxy)
		for (const [id, saved] of ordered(state)) {
			if (!filledServer(id, saved)) continue;
			servers[id] = {
				url: `${proxy.url}/${encodeURIComponent(id)}`,
				headers: { Authorization: `Bearer ${literal(proxy.key)}` },
				exposure: "direct",
				timeout: CALL_TIMEOUT_SECONDS,
				...(saved.enabled ? {} : { enabled: false }),
			};
		}
	// The helper checks its own key and asks the user itself, so all of its tools are direct.
	if (computer)
		servers[COMPUTER_ID] = {
			url: computer.url,
			headers: { Authorization: `Bearer ${literal(computer.token)}` },
			exposure: "direct",
			timeout: CALL_TIMEOUT_SECONDS,
		};
	return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

/**
 * The real servers, in the engine's format, for the daemon's own sign-in home: only the engine's
 * `mcp login` and `mcp logout` commands read it, never the engine that talks to the model. Read only
 * still hides every tool (`*`) except the curated ones, as the engine would have.
 */
export function renderSigninMcpJson(state: ConnectorsState): string {
	const servers: Record<string, unknown> = {};
	for (const [id, saved] of ordered(state)) {
		const filled = filledServer(id, saved);
		if (!filled) continue;
		const { spec, server } = filled;
		servers[id] = {
			...server,
			exposure: "direct",
			...(saved.mode === "read_only"
				? {
						toolExposure: {
							"*": "hidden",
							...Object.fromEntries(spec.readOnlyTools.map((tool) => [tool, "direct"])),
						},
					}
				: {}),
			...(saved.enabled ? {} : { enabled: false }),
		};
	}
	return `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
}

function writePrivate(path: string, text: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

export interface ConnectorStoreOptions {
	dataDir: string;
	/** The engine's home, which holds its `mcp.json` (and held `mcp-auth.json` before the proxy). */
	agentHome: string;
	/** The environment the values of imported servers may read (`$NAME`); default the daemon's. */
	env?: NodeJS.ProcessEnv;
	/** The engine's working folder; a project `.pi/mcp.json` there would add servers. */
	workspace?: string;
	/** The approval guard's own file, protected like the connector files. */
	guardPath?: string;
	log?: (line: string) => void;
}

/**
 * The connectors the user approved. The daemon reads `<data>/connectors.json` once, when it
 * starts, and from then on the state lives in memory and changes only through the Connectors
 * screen. The files (`connectors.json`, the engine's `mcp.json`, and the sign-in home's `mcp.json`)
 * are written from memory; a change made by anything else (the assistant has a shell) is put back,
 * and a project `.pi/mcp.json` in the workspace is removed. The sign-ins (`mcp-auth.json`) change
 * only during a sign-in or a token refresh; other changes are put back too. Checked on every file
 * event, before every engine start, and after every run. A change made while the daemon is not
 * running is loaded at its next start (S25.6).
 *
 * The engine's `mcp.json` lists only the daemon's proxy (S25.4). The real servers and the sign-ins
 * are in the daemon's own sign-in home (`<data>/connector-signin`), which only the engine's
 * `mcp login`/`mcp logout` commands are pointed at.
 */
export class ConnectorStore {
	readonly file: string;
	readonly mcpFile: string;
	/** The daemon's own folder for the sign-in command: the real servers and the sign-ins. */
	readonly signinHome: string;
	readonly signinMcpFile: string;
	/** The sign-ins (pi-mcp's OAuth state by `mcp__<server>|<url>`), in the sign-in home. */
	readonly authFile: string;
	/** Where the engine kept the sign-ins before the proxy; moved once into the sign-in home. */
	readonly legacyAuthFile: string;
	/** Called after a change made outside the Connectors screen was put back. */
	onReverted: () => void = () => {};
	/** Called after every change to the state (the proxy closes what it no longer may use). */
	onUpdated: () => void = () => {};
	private saved: ConnectorsState;
	/** The desktop app's helper while a window has it registered; only in memory and `mcp.json`. */
	private computer: ComputerEndpoint | undefined;
	/** The daemon's proxy for the running engine; only in memory and `mcp.json`. */
	private proxy: ProxyEndpoint | undefined;
	/** The sign-ins as the last sign-in or refresh left them (undefined: no file). */
	private authText: string | undefined;
	/** Sign-in commands running now; they write the sign-ins themselves. */
	private signins = 0;
	private watchers: FSWatcher[] = [];
	private readonly options: ConnectorStoreOptions;

	constructor(options: ConnectorStoreOptions) {
		this.options = options;
		this.file = join(options.dataDir, "connectors.json");
		this.mcpFile = join(options.agentHome, "mcp.json");
		this.signinHome = join(options.dataDir, "connector-signin");
		this.signinMcpFile = join(this.signinHome, "mcp.json");
		this.authFile = join(this.signinHome, "mcp-auth.json");
		this.legacyAuthFile = join(options.agentHome, "mcp-auth.json");
		this.moveLegacySignIns();
		this.authText = readOrUndefined(this.authFile);
		const { state, renamed } = this.load();
		this.saved = state;
		if (renamed) writePrivate(this.file, this.recordText());
	}

	get agentHome(): string {
		return this.options.agentHome;
	}

	state(): ConnectorsState {
		return structuredClone(this.saved);
	}

	/** Changes the state, then writes the files (each atomically, mode 0600). */
	update(change: (state: ConnectorsState) => void): void {
		const state = this.state();
		change(state);
		this.saved = state;
		mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
		ensurePrivateDir(this.signinHome);
		writePrivate(this.file, this.recordText());
		writePrivate(this.mcpFile, this.engineMcpText());
		writePrivate(this.signinMcpFile, renderSigninMcpJson(state));
		this.onUpdated();
	}

	/** Adds, replaces, or removes the computer helper in `mcp.json`; true when that changed it. */
	setComputer(endpoint: ComputerEndpoint | undefined): boolean {
		const same = endpoint?.url === this.computer?.url && endpoint?.token === this.computer?.token;
		if (same) return false;
		this.computer = endpoint ? { ...endpoint } : undefined;
		mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
		writePrivate(this.mcpFile, this.engineMcpText());
		return true;
	}

	/** Points `mcp.json` at the proxy with the key for the next engine launch; true when that changed it. */
	setProxy(endpoint: ProxyEndpoint): boolean {
		if (endpoint.url === this.proxy?.url && endpoint.key === this.proxy?.key) return false;
		this.proxy = { ...endpoint };
		mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
		writePrivate(this.mcpFile, this.engineMcpText());
		return true;
	}

	/** A connector as the proxy sees it, from the state in memory; undefined when it cannot run. */
	proxyView(id: string): ProxiedConnector | undefined {
		const saved = this.saved.connectors[id];
		const filled = saved && filledServer(id, saved);
		if (!saved || !filled) return undefined;
		const { spec, server } = filled;
		return {
			id,
			name: spec.name,
			enabled: saved.enabled,
			mode: saved.mode,
			readOnlyTools: [...spec.readOnlyTools],
			server:
				"url" in server
					? { url: server.url }
					: {
							command: server.command,
							...(server.args ? { args: [...server.args] } : {}),
							...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
						},
			// The server with its values: a new token or address makes a new connection.
			revision: createHash("sha256").update(JSON.stringify(server)).digest("hex"),
		};
	}

	/**
	 * What the proxy adds to the real server: the values the user typed (headers, a stdio server's
	 * environment) as they were typed, and for a remote server without its own Authorization header,
	 * the stored sign-in, refreshed when it expires.
	 */
	async credentials(id: string): Promise<UpstreamCredentials> {
		const filled = filledServer(id, this.saved.connectors[id]);
		if (!filled) throw new Error(`The connector ${id} is not set up.`);
		const { spec, server } = filled;
		const env = this.options.env ?? process.env;
		if ("command" in server) {
			const resolved = resolveRecord(server.env, env, spec.name);
			return resolved ? { env: resolved } : {};
		}
		const headers = resolveRecord(server.headers, env, spec.name);
		const ownAuthorization = Object.keys(server.headers ?? {}).some(
			(h) => h.toLowerCase() === "authorization",
		);
		if (ownAuthorization) return headers ? { headers } : {};
		const key = authKey(id, server.url);
		const { oauth } = server;
		const authProvider = storedSignIn(
			server.url,
			{ load: () => this.signIn(key), save: (state) => this.saveSignIn(key, state) },
			() => ({
				...(oauth?.clientId ? { clientId: oauth.clientId } : {}),
				...(oauth?.clientSecret
					? { clientSecret: resolveValue(oauth.clientSecret, env, `${spec.name} client secret`) }
					: {}),
				...(oauth?.callbackUrl ? { redirectUrl: oauth.callbackUrl } : {}),
			}),
		);
		return { ...(headers ? { headers } : {}), authProvider };
	}

	/**
	 * While the engine's sign-in command runs, it writes the sign-ins itself; call the returned
	 * function when it ended, so what it wrote is kept.
	 */
	signingIn(): () => void {
		this.signins++;
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.signins--;
			this.authText = readOrUndefined(this.authFile);
		};
	}

	/** The helper's address while it is registered (never its key). */
	computerUrl(): string | undefined {
		return this.computer?.url;
	}

	/**
	 * Puts back every connector file that differs from the approved state; true when one did.
	 * `report: false` only writes them (the daemon's start, where the files are what it just read).
	 */
	enforce(report = true): boolean {
		// A missing file is untouched while it would hold nothing: the record before any connector is saved,
		// and mcp.json before any connector or the computer helper is in it.
		const noConnectors = Object.keys(this.saved.connectors).length === 0;
		const changed: string[] = [];
		for (const [file, text, empty] of [
			[this.file, this.recordText(), noConnectors],
			[this.mcpFile, this.engineMcpText(), noConnectors && !this.computer],
			[this.signinMcpFile, renderSigninMcpJson(this.saved), noConnectors],
		] as const) {
			const current = readOrUndefined(file);
			if (current === text || (current === undefined && empty)) continue;
			mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
			ensurePrivateDir(this.signinHome);
			writePrivate(file, text);
			changed.push(file);
		}
		// The sign-ins change only through a sign-in or a refresh.
		if (this.signins === 0 && readOrUndefined(this.authFile) !== this.authText) {
			if (this.authText === undefined) unlinkSync(this.authFile);
			else {
				ensurePrivateDir(this.signinHome);
				writePrivate(this.authFile, this.authText);
			}
			changed.push(this.authFile);
		}
		if (this.removeProjectConfig()) changed.push("the workspace's .pi/mcp.json");
		if (changed.length === 0 || !report) return changed.length > 0;
		this.options.log?.(
			`connector files were changed outside the Connectors screen; put back ${changed.join(", ")}`,
		);
		this.onReverted();
		return true;
	}

	/**
	 * Puts changes back as soon as the files change (the folders are watched, so renames count).
	 * File events on macOS can be missed right after a watch starts, so a check every second backs them up.
	 */
	watch(): void {
		this.close();
		let timer: NodeJS.Timeout | undefined;
		const check = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				try {
					this.enforce();
				} catch (error) {
					this.options.log?.(`could not check the connector files: ${(error as Error).message}`);
				}
				this.watchProjectConfig();
			}, 20);
		};
		ensurePrivateDir(this.signinHome);
		const folders = [this.options.dataDir, this.options.agentHome, this.signinHome, this.options.workspace];
		for (const folder of folders) {
			if (!folder) continue;
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			this.watchers.push(watch(folder, check));
		}
		this.check = check;
		this.watchProjectConfig();
		this.poll = setInterval(check, 1000);
		this.poll.unref();
	}

	close(): void {
		clearInterval(this.poll);
		for (const watcher of this.watchers.splice(0)) watcher.close();
		this.projectWatcher?.close();
		this.projectWatcher = undefined;
	}

	/**
	 * What the approval guard enforces: the turned-on connectors, which of them the proxy fronts (it
	 * filters and asks, so the guard lets their tools through), and the files only the daemon writes.
	 */
	policy(): ConnectorPolicy {
		const connectors: NonNullable<ConnectorPolicy["connectors"]> = {};
		const proxied: string[] = [];
		for (const [id, saved] of ordered(this.saved)) {
			const spec = specOf(id, saved);
			if (!spec || !saved.enabled) continue;
			connectors[id] = { name: spec.name, mode: saved.mode, readOnlyTools: [...spec.readOnlyTools] };
			if (filledServer(id, saved)) proxied.push(id);
		}
		return {
			connectors,
			proxied,
			// Sign-ins and keys, connector state, and the daemon's access key.
			protectedPaths: [
				this.mcpFile,
				this.legacyAuthFile,
				this.signinHome,
				this.signinMcpFile,
				this.authFile,
				join(this.options.agentHome, "auth.json"),
				join(this.options.agentHome, "models.json"),
				this.file,
				join(this.options.dataDir, "token"),
				...(this.options.guardPath ? [this.options.guardPath] : []),
			],
			...(this.computer ? { builtin: [COMPUTER_ID] } : {}),
		};
	}

	/**
	 * True when the sign-in command stored tokens for the connector (key `mcp__<server>|<url>`, `-`
	 * as `_`). Token values are dropped while parsing, so they are never kept or passed on.
	 */
	isSignedIn(id: string): boolean {
		const server = filledServer(id, this.saved.connectors[id])?.server;
		if (!server || !("url" in server) || !URL.canParse(server.url) || !existsSync(this.authFile))
			return false;
		try {
			const states = JSON.parse(readFileSync(this.authFile, "utf8"), (key, value) =>
				key === "tokens" && typeof value === "object" && value !== null ? {} : value,
			) as Record<string, { tokens?: unknown } | undefined>;
			return typeof states[authKey(id, server.url)]?.tokens === "object";
		} catch {
			return false;
		}
	}

	/** One server's stored sign-in, for the proxy. */
	private signIn(key: string): McpOAuthState | undefined {
		try {
			const states = JSON.parse(readFileSync(this.authFile, "utf8")) as Record<
				string,
				McpOAuthState | undefined
			>;
			return states[key];
		} catch {
			return undefined;
		}
	}

	/** Keeps a refreshed sign-in; the file is then what it should be. */
	private saveSignIn(key: string, state: McpOAuthState): void {
		let states: Record<string, unknown> = {};
		try {
			states = JSON.parse(readFileSync(this.authFile, "utf8")) as Record<string, unknown>;
		} catch {}
		states[key] = state;
		const text = `${JSON.stringify(states, null, 2)}\n`;
		ensurePrivateDir(this.signinHome);
		writePrivate(this.authFile, text);
		this.authText = text;
	}

	/**
	 * Before the proxy, the engine kept the sign-ins in its home. Whenever that file is there it is
	 * moved: verbatim when the daemon holds no sign-ins yet, otherwise only the sign-ins the daemon
	 * does not hold (its own always win, so a file planted later never replaces one). The result is
	 * read back before the old file is removed, so a move that stopped halfway finishes next time.
	 */
	private moveLegacySignIns(): void {
		ensurePrivateDir(this.signinHome);
		const text = readOrUndefined(this.legacyAuthFile);
		if (text === undefined) return;
		const legacy = signInStates(text);
		const currentText = readOrUndefined(this.authFile);
		const current = currentText === undefined ? {} : signInStates(currentText);
		if (!legacy || !current) {
			this.options.log?.("could not read the connector sign-ins to move; they stay where they were");
			return;
		}
		const missing = Object.keys(legacy).filter((key) => !(key in current));
		if (currentText === undefined) writePrivate(this.authFile, text);
		else if (missing.length > 0) {
			const merged = { ...Object.fromEntries(missing.map((key) => [key, legacy[key]])), ...current };
			writePrivate(this.authFile, `${JSON.stringify(merged, null, 2)}\n`);
		}
		const moved = signInStates(readOrUndefined(this.authFile) ?? "");
		if (!moved || Object.keys(legacy).some((key) => !(key in moved))) {
			this.options.log?.("could not move the connector sign-ins; they stay where they were");
			return;
		}
		unlinkSync(this.legacyAuthFile);
		this.options.log?.("moved the connector sign-ins to the daemon's sign-in folder");
	}

	private engineMcpText(): string {
		return renderMcpJson(this.saved, this.computer, this.proxy);
	}

	private check: () => void = () => {};
	private poll: NodeJS.Timeout | undefined;
	private projectWatcher: FSWatcher | undefined;

	/** `.pi` appears after the watch starts; its folder is watched once it is there. */
	private watchProjectConfig(): void {
		const folder = this.options.workspace && join(this.options.workspace, ".pi");
		if (this.projectWatcher || !folder || this.watchers.length === 0 || !isFolder(folder)) return;
		try {
			const watcher = watch(folder, this.check);
			watcher.on("error", () => {
				watcher.close();
				if (this.projectWatcher === watcher) this.projectWatcher = undefined;
			});
			this.projectWatcher = watcher;
		} catch {}
	}

	/** Removes `<workspace>/.pi/mcp.json`; a `.pi` that is a link loses the link, never what it points to. */
	private removeProjectConfig(): boolean {
		if (!this.options.workspace) return false;
		const folder = join(this.options.workspace, ".pi");
		const link = lstatOrUndefined(folder);
		if (link?.isSymbolicLink()) {
			const target = join(folder, "mcp.json");
			if (!existsSync(target)) return false;
			unlinkSync(folder);
			return true;
		}
		const file = join(folder, "mcp.json");
		const stat = link && lstatOrUndefined(file);
		if (!stat || stat.isDirectory()) return false;
		unlinkSync(file);
		this.projectWatcher?.close();
		this.projectWatcher = undefined;
		return true;
	}

	private recordText(): string {
		return `${JSON.stringify({ version: 1, connectors: this.saved.connectors }, null, 2)}\n`;
	}

	/** The saved state; a connector saved as `computer` (the built-in helper's name) gets `computer-2`. */
	private load(): { state: ConnectorsState; renamed: boolean } {
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8")) as {
				connectors?: Record<string, Record<string, unknown> | undefined>;
			};
			const connectors: ConnectorsState["connectors"] = {};
			const entries = Object.entries(saved.connectors ?? {});
			const ordered = [
				...entries.filter(([id]) => id !== COMPUTER_ID),
				...entries.filter(([id]) => id === COMPUTER_ID),
			];
			let renamed = false;
			for (const [savedId, value] of ordered) {
				let id = savedId;
				if (id === COMPUTER_ID) {
					let n = 2;
					while (`${COMPUTER_ID}-${n}` in connectors || catalogEntry(`${COMPUTER_ID}-${n}`)) n++;
					id = `${COMPUTER_ID}-${n}`;
				}
				const custom = catalogEntry(id) ? undefined : parseCustom(value?.custom);
				if (!catalogEntry(id) && !custom) continue;
				renamed ||= id !== savedId;
				const entry: SavedConnector = {
					enabled: value?.enabled === true,
					mode: value?.mode === "read_write" ? "read_write" : "read_only",
				};
				const values = stringRecord(value?.values);
				if (values) entry.values = values;
				if (custom) entry.custom = custom;
				connectors[id] = entry;
			}
			return { state: { connectors }, renamed };
		} catch {
			return { state: { connectors: {} }, renamed: false };
		}
	}
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** A saved server of the user's own, or undefined when anything is malformed. */
function parseCustom(value: unknown): CustomConnector | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const custom = value as Partial<CustomConnector>;
	if (typeof custom.name !== "string" || typeof custom.origin !== "string") return undefined;
	const server = custom.server as Record<string, unknown> | undefined;
	if (typeof server?.url !== "string" && typeof server?.command !== "string") return undefined;
	const fields = Array.isArray(custom.fields)
		? custom.fields.filter((f): f is SetupField => typeof f?.key === "string" && typeof f.label === "string")
		: [];
	return {
		name: custom.name,
		description: typeof custom.description === "string" ? custom.description : "",
		origin: custom.origin,
		server: server as ServerTemplate,
		fields,
		oauth: custom.oauth === true,
	};
}

/** A sign-in's key in `mcp-auth.json`, like the engine's (`mcp__<server>|<url>`, `-` as `_`). */
function authKey(id: string, url: string): string {
	return `mcp__${id.replace(/-/g, "_")}|${new URL(url).href}`;
}

/** The sign-ins of an `mcp-auth.json` by key; undefined when it is not a JSON object. */
function signInStates(text: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(text) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function readOrUndefined(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

function lstatOrUndefined(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

const isFolder = (path: string) => lstatOrUndefined(path)?.isDirectory() === true;

/** How to run the engine's command line: `command ...args mcp <subcommand> <server>`. */
export interface McpCli {
	command: string;
	args: string[];
}

/** The command line of the engine bundled with the daemon (`pi-coding-agent`), from the runtime in an installed app. */
export function bundledMcpCli(env: NodeJS.ProcessEnv = process.env): McpCli {
	const runtime = runtimeDir(env);
	if (runtime) {
		const cli = join(
			runtimeModules(runtime),
			"@earendil-works",
			"pi-coding-agent",
			"dist",
			"bundle",
			"cli.js",
		);
		if (existsSync(cli)) return { command: process.execPath, args: [cli] };
		throw new Error(`The bundled assistant engine is missing from ${runtimeModules(runtime)}.`);
	}
	const require = createRequire(import.meta.url);
	for (const dir of require.resolve.paths("@earendil-works/pi-coding-agent") ?? []) {
		const cli = join(dir, "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		if (existsSync(cli)) return { command: process.execPath, args: [cli] };
	}
	throw new Error("The bundled assistant engine is missing. Run `pnpm install`.");
}

/** The approval guard the daemon loads into the engine. */
export const APPROVAL_GUARD = fileURLToPath(new URL("./extensions/approval-guard.ts", import.meta.url));

/** Why a connector action did not start; `message` is safe to show. */
export type ConnectorRefusal = {
	code:
		| "connector_busy"
		| "unknown_connector"
		| "connector_not_added"
		| "connector_no_setup"
		| "connector_no_signin"
		| "draft_not_found";
	message: string;
};

const REFUSALS = {
	busy: { code: "connector_busy", message: "Another sign-in is in progress. Finish or cancel it first." },
	unknown: { code: "unknown_connector", message: "That connector is not available." },
	notAdded: { code: "connector_not_added", message: "Connect that service first." },
	noSetup: { code: "connector_no_setup", message: "That connector has nothing to set up." },
	noSignin: { code: "connector_no_signin", message: "That connector does not use a sign-in." },
	noDraft: { code: "draft_not_found", message: "That draft is no longer waiting." },
} as const satisfies Record<string, ConnectorRefusal>;

type Emit = (payload: ServerPayload) => void;

interface Flow {
	id: string;
	connectorId: string;
	owner: object;
	emit: Emit;
	child: ChildProcess;
	/** From the authorization URL: where the browser returns, and the sign-in's `state`. */
	redirect?: { url: URL; state: string | null };
	cancelled: boolean;
	/** What the command printed so far: stdout until the link appears, the tail of stderr for the log. */
	printed: string | undefined;
	output: string;
}

/** The values a connector needs, asked one at a time in the window that started it. */
interface Setup {
	id: string;
	connectorId: string;
	owner: object;
	emit: Emit;
	fields: readonly SetupField[];
	values: Record<string, string>;
	finish: (values: Record<string, string>) => void;
}

const PASTE_PROMPT =
	"If the browser shows an error page after you approve, copy the full address from its address bar and paste it here.";
const DRAFT_ORIGIN = "Drafted by the assistant";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export interface ConnectorManagerOptions {
	store: ConnectorStore;
	cli: McpCli;
	/** The engine's environment (its own HOME, XDG folders, and memory settings). */
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** The home folder "Import my MCP servers" scans; default the user's. */
	importHome?: string;
	log?: (line: string) => void;
}

/**
 * Connects, sets up, signs in, changes, and removes connectors. Values the user types (a bot token,
 * an OAuth client) are asked one at a time with sign-in prompts, kept in the assistant's private
 * state, and never logged or sent back. Sign-in runs the engine's own `mcp login <server>` as a
 * separate process (one at a time; its loopback callback port is shared), relays the authorization
 * URL, and can finish with an address the user pastes when the browser could not reach this
 * computer. Drafts from the assistant and servers found in other apps are added only when the user
 * says so, read only, with every tool hidden. Nothing typed or printed is logged.
 */
export class ConnectorManager {
	/** `restart`: the engine must restart (when idle) to read the new `mcp.json`. */
	onChanged: (restart: boolean) => void = () => {};
	/** A change to the connector files made outside the Connectors screen was put back. */
	onBlocked: () => void = () => {};
	/** Whether the current model accepts images; undefined when that is not known. */
	imagesSupported: () => boolean | undefined = () => undefined;
	private flow: Flow | undefined;
	/** The window that registered the computer helper; it goes away with that window. */
	private computerOwner: object | undefined;
	private setupFlow: Setup | undefined;
	private readonly failed = new Set<string>();
	private readonly waiting = new Map<string, ConnectorDraft>();
	private scanned = new Map<string, ScannedServer>();
	private readonly options: ConnectorManagerOptions;

	constructor(options: ConnectorManagerOptions) {
		this.options = options;
		options.store.onReverted = () => this.onBlocked();
	}

	/** Puts back connector files changed outside the Connectors screen (for example after a run). */
	enforce(): void {
		try {
			this.options.store.enforce();
		} catch (error) {
			this.log(`could not check the connector files: ${(error as Error).message}`);
		}
	}

	list(): ConnectorInfo[] {
		const { connectors } = this.options.store.state();
		const ids = [
			...CATALOG.map((entry) => entry.id),
			...ordered({ connectors })
				.map(([id]) => id)
				.filter((id) => !catalogEntry(id)),
		];
		const infos = ids.flatMap((id) => {
			const saved = connectors[id];
			const spec = specOf(id, saved);
			if (!spec) return [];
			const info: ConnectorInfo = {
				id,
				name: spec.name,
				reads: spec.reads,
				sends: spec.sends,
				added: saved !== undefined,
				enabled: saved?.enabled === true,
				mode: saved?.mode ?? "read_only",
				status: this.status(id, spec, saved),
			};
			if (!spec.oauth) info.noSignIn = true;
			if (spec.guide) info.guide = spec.guide;
			if (spec.custom) info.custom = { origin: spec.custom.origin, summary: summarize(spec.custom.server) };
			return [info];
		});
		if (this.options.store.computerUrl() === undefined) return infos;
		const computer: ConnectorInfo = {
			...COMPUTER_INFO,
			added: true,
			enabled: true,
			mode: "read_write",
			status: "connected",
			noSignIn: true,
			builtin: true,
		};
		if (this.imagesSupported() === false) computer.noImages = true;
		return [...infos, computer];
	}

	/**
	 * The desktop app's computer helper, registered by one of its windows (S24.7). The engine reads it
	 * at its next start; its key is written only to `mcp.json`, never logged or sent to a window.
	 */
	registerComputer(owner: object, endpoint: ComputerEndpoint): void {
		this.computerOwner = owner;
		if (!this.options.store.setComputer(endpoint)) return;
		this.log("the desktop app registered computer control");
		this.onChanged(true);
	}

	/** Removes the helper; only the window that registered it can (it also goes when that window does). */
	unregisterComputer(owner: object): void {
		if (this.computerOwner !== owner) return;
		this.computerOwner = undefined;
		if (!this.options.store.setComputer(undefined)) return;
		this.log("computer control was unregistered");
		this.onChanged(true);
	}

	/** Adds or turns on a connector: asks for the values it still needs, then signs in when it has no sign-in yet. */
	connect(owner: object, id: string, emit: Emit): ConnectorRefusal | undefined {
		const saved = this.options.store.state().connectors[id];
		const spec = specOf(id, saved);
		if (!spec) return REFUSALS.unknown;
		if (this.busy()) return REFUSALS.busy;
		if (missingValues(spec, saved?.values)) {
			// Nothing is added until every value is there.
			this.askValues(owner, id, spec.fields, emit, (values, flowId) => {
				this.save(id, (current) => ({ ...current, enabled: true, values }));
				this.afterSetup(owner, id, emit, flowId);
			});
			return undefined;
		}
		this.save(id, (current) => ({ ...current, enabled: true }));
		this.afterSetup(owner, id, emit, `connector-${randomUUID()}`);
		return undefined;
	}

	/** Asks again for the values the user typed (a new token, another OAuth client). */
	setup(owner: object, id: string, emit: Emit): ConnectorRefusal | undefined {
		const saved = this.options.store.state().connectors[id];
		const spec = specOf(id, saved);
		if (!spec) return REFUSALS.unknown;
		if (!saved) return REFUSALS.notAdded;
		if (spec.fields.length === 0) return REFUSALS.noSetup;
		if (this.busy()) return REFUSALS.busy;
		this.askValues(owner, id, spec.fields, emit, (values, flowId) => {
			this.save(id, (current) => ({ ...current, values }));
			this.afterSetup(owner, id, emit, flowId);
		});
		return undefined;
	}

	signIn(owner: object, id: string, emit: Emit): ConnectorRefusal | undefined {
		const saved = this.options.store.state().connectors[id];
		const spec = specOf(id, saved);
		if (!spec) return REFUSALS.unknown;
		if (this.busy()) return REFUSALS.busy;
		if (!saved) return REFUSALS.notAdded;
		if (!spec.oauth) return REFUSALS.noSignin;
		this.startLogin(owner, id, emit);
		return undefined;
	}

	/** Answers the flow `owner` started: a typed value, a pasted address, or a cancellation. */
	reply(owner: object, flowId: string, answer: { value?: string; cancelled?: boolean }): boolean {
		const setup = this.setupFlow;
		if (setup && setup.id === flowId) {
			if (setup.owner !== owner) return false;
			if (answer.cancelled) this.cancelSetup(setup);
			else if (answer.value !== undefined) this.takeValue(setup, answer.value);
			else return false;
			return true;
		}
		const flow = this.flow;
		if (!flow || flow.id !== flowId || flow.owner !== owner) return false;
		if (answer.cancelled) {
			this.cancel(flow);
			return true;
		}
		if (answer.value === undefined) return false;
		void this.finishWithPastedAddress(flow, answer.value);
		return true;
	}

	owns(flowId: string): boolean {
		return flowId.startsWith("connector-");
	}

	/** A window that goes away takes its sign-in with it. */
	cancelOwnedBy(owner: object): void {
		if (this.setupFlow?.owner === owner) this.cancelSetup(this.setupFlow);
		if (this.flow?.owner === owner) this.cancel(this.flow);
	}

	cancelAll(): void {
		if (this.setupFlow) this.cancelSetup(this.setupFlow);
		if (this.flow) this.cancel(this.flow);
	}

	/** Turns a connector off; its sign-in is kept for when it is turned on again. */
	disconnect(id: string): ConnectorRefusal | undefined {
		return this.change(id, (saved) => ({ ...saved, enabled: false }));
	}

	setMode(id: string, mode: ConnectorMode): ConnectorRefusal | undefined {
		return this.change(id, (saved) => ({ ...saved, mode }));
	}

	/** Signs out (`mcp logout`, which needs the server still configured), then forgets the connector. */
	async remove(id: string): Promise<ConnectorRefusal | undefined> {
		const saved = this.options.store.state().connectors[id];
		const spec = specOf(id, saved);
		if (!spec) return REFUSALS.unknown;
		if (!saved) return REFUSALS.notAdded;
		if (this.flow?.connectorId === id) this.cancel(this.flow);
		if (this.setupFlow?.connectorId === id) this.cancelSetup(this.setupFlow);
		if (spec.oauth) {
			const code = await new Promise<number | null>((done) => {
				const child = this.run("logout", id);
				child.on("error", () => done(-1));
				child.on("close", (exit) => done(exit));
			});
			if (code !== 0) this.log(`sign-out of connector ${id} failed (exit ${code})`);
		}
		this.failed.delete(id);
		this.options.store.update((state) => {
			delete state.connectors[id];
		});
		this.onChanged(true);
		return undefined;
	}

	/**
	 * A draft from `propose_connector` (the engine's status text), checked and kept for the user's
	 * answer; undefined when it is malformed. Only the newest five wait.
	 */
	propose(text: string): ConnectorDraft | undefined {
		const draft = parseDraft(text);
		if (!draft) return undefined;
		this.waiting.set(draft.draftId, draft);
		for (const id of this.waiting.keys())
			if (this.waiting.size > MAX_CONNECTOR_DRAFTS) this.waiting.delete(id);
		return draft;
	}

	drafts(): ConnectorDraft[] {
		return [...this.waiting.values()];
	}

	/**
	 * The user's answer to a draft. Declining forgets it. Approving adds the server, turned on, read
	 * only, with every tool hidden, then asks for its secrets in the window that approved it and signs
	 * in when it needs to.
	 */
	decideDraft(owner: object, draftId: string, approve: boolean, emit: Emit): ConnectorRefusal | undefined {
		const draft = this.waiting.get(draftId);
		if (!draft) return REFUSALS.noDraft;
		if (approve && this.busy()) return REFUSALS.busy;
		this.waiting.delete(draftId);
		if (!approve) return undefined;
		const id = this.newId(draft.name);
		const server: ServerTemplate =
			draft.transport === "http"
				? { url: draft.url ?? "" }
				: {
						command: draft.command ?? "",
						...(draft.args?.length ? { args: draft.args } : {}),
						...(draft.envNames.length > 0
							? { env: Object.fromEntries(draft.envNames.map((name) => [name, placeholder(name)])) }
							: {}),
					};
		const custom: CustomConnector = {
			name: draft.name,
			description: draft.description,
			origin: DRAFT_ORIGIN,
			server,
			fields: draft.envNames.map((name) => ({ key: name, label: name, secret: true })),
			oauth: draft.transport === "http" && draft.needsOAuth,
		};
		this.save(id, () => ({ enabled: true, mode: "read_only", custom }));
		this.log(`added connector ${id} from the assistant's draft`);
		if (custom.fields.length === 0) this.afterSetup(owner, id, emit, `connector-${randomUUID()}`);
		else
			this.askValues(owner, id, custom.fields, emit, (values, flowId) => {
				this.save(id, (current) => ({ ...current, values }));
				this.afterSetup(owner, id, emit, flowId);
			});
		return undefined;
	}

	/** Reads the other apps' configurations (only reads them) and lists what it found, without any value. */
	scan(): ImportCandidate[] {
		const home = this.options.importHome ?? homedir();
		const groups = new Map<string, { candidate: ImportCandidate; server: ScannedServer }>();
		const found = new Map<string, ScannedServer>();
		const computerUrl = this.options.store.computerUrl();
		const computer = computerUrl === undefined ? undefined : fingerprint({ url: computerUrl });
		for (const server of scanClientConfigs(home)) {
			const key = server.server ? fingerprint(server.server) : `${server.source}:${server.name}`;
			// The helper is built in; a copy of it elsewhere is never offered.
			if (key === computer) continue;
			const group = groups.get(key);
			if (group) {
				if (!group.candidate.sources.includes(server.source)) group.candidate.sources.push(server.source);
				continue;
			}
			const id = `${server.source}:${server.name}`;
			const candidate = this.describeImport(id, server);
			groups.set(key, { candidate, server });
			found.set(id, server);
		}
		this.scanned = found;
		this.log(`found ${found.size} MCP servers in other apps`);
		return [...groups.values()].map(({ candidate }) => candidate);
	}

	/** The scanned servers `importServers(ids)` would add, by name and what they run; nothing changes. */
	importChoices(ids: string[]): { name: string; summary: string }[] {
		return this.importPlan(ids).choices;
	}

	/**
	 * What importing `ids` would add, frozen: the choices to confirm and a copy of the scanned
	 * servers behind them. Importing that copy adds exactly what was confirmed, even if a scan
	 * replaces the list while the user decides (B2, L114).
	 */
	importPlan(ids: string[]): {
		choices: { name: string; summary: string }[];
		servers: Map<string, ScannedServer>;
	} {
		const servers = new Map<string, ScannedServer>();
		const choices = ids.flatMap((key) => {
			const found = this.scanned.get(key);
			if (!found?.server || this.duplicateOf(found.server)) return [];
			servers.set(key, structuredClone(found));
			return [{ name: found.name, summary: summarize(found.server) }];
		});
		return { choices, servers };
	}

	/**
	 * Copies the chosen servers, with their values, read only with every tool hidden: from `from`
	 * (a confirmed plan) when given, else from the last scan.
	 */
	importServers(ids: string[], from: ReadonlyMap<string, ScannedServer> = this.scanned): string[] {
		const imported: string[] = [];
		for (const key of ids) {
			const found = from.get(key);
			if (!found?.server || this.duplicateOf(found.server)) continue;
			const id = this.newId(found.name);
			const custom: CustomConnector = {
				name: found.name,
				description: "",
				origin: `Imported from ${found.source}`,
				server: found.server,
				fields: found.fields,
				oauth: found.oauth,
			};
			this.options.store.update((state) => {
				state.connectors[id] = { enabled: true, mode: "read_only", custom };
			});
			imported.push(id);
		}
		if (imported.length > 0) {
			this.log(`imported ${imported.length} MCP servers: ${imported.join(", ")}`);
			this.onChanged(true);
		}
		return imported;
	}

	private describeImport(id: string, server: ScannedServer): ImportCandidate {
		const template = server.server;
		const candidate: ImportCandidate = {
			id,
			name: server.name,
			sources: [server.source],
			transport: server.transport,
			summary: template ? summarize(template) : "",
			envNames: template && "command" in template ? Object.keys(template.env ?? {}) : [],
			headerNames: template && "url" in template ? Object.keys(template.headers ?? {}) : [],
			inputs: server.fields.map((field) => field.label),
			importable: template !== undefined,
		};
		const notes = template ? valueNotes(template) : [];
		if (notes.length > 0) candidate.notes = notes;
		if (server.reason) candidate.reason = server.reason;
		const duplicate = template && this.duplicateOf(template);
		if (duplicate) {
			candidate.importable = false;
			candidate.duplicateOf = duplicate;
		}
		return candidate;
	}

	/** The connector with the same server: one the user added, or a catalog entry with a curated list. */
	private duplicateOf(server: ServerTemplate): string | undefined {
		const key = fingerprint(server);
		const { connectors } = this.options.store.state();
		for (const entry of CATALOG) if (fingerprint(entry.server) === key) return entry.id;
		for (const [id, saved] of Object.entries(connectors))
			if (saved.custom && fingerprint(saved.custom.server) === key) return id;
		return undefined;
	}

	/** A connector id from a name: lowercase letters, digits, and `-`, not taken yet. */
	private newId(name: string): string {
		const base =
			name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 32)
				.replace(/-+$/, "") || "server";
		const taken = (id: string) =>
			id === COMPUTER_ID || catalogEntry(id) !== undefined || id in this.options.store.state().connectors;
		if (!taken(base)) return base;
		for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
	}

	private status(
		id: string,
		spec: ConnectorSpec,
		saved: SavedConnector | undefined,
	): ConnectorInfo["status"] {
		if (!saved?.enabled) return "off";
		if (missingValues(spec, saved.values)) return "needs_setup";
		if (this.failed.has(id)) return "error";
		if (spec.oauth && !this.options.store.isSignedIn(id)) return "needs_signin";
		return "connected";
	}

	private busy(): boolean {
		return this.flow !== undefined || this.setupFlow !== undefined;
	}

	/** Changes one connector, keeping what is not changed, then has the engine read it again. */
	private save(id: string, update: (current: SavedConnector) => SavedConnector): void {
		this.options.store.update((state) => {
			state.connectors[id] = update(state.connectors[id] ?? { enabled: false, mode: "read_only" });
		});
		this.onChanged(true);
	}

	/** After the values are there: sign in when the connector needs it, otherwise it is done. */
	private afterSetup(owner: object, id: string, emit: Emit, flowId: string): void {
		const spec = specOf(id, this.options.store.state().connectors[id]);
		if (spec?.oauth && !this.options.store.isSignedIn(id)) this.startLogin(owner, id, emit, flowId);
		// Already signed in, or nothing to sign in to: the window that asked is told it is done.
		else emit({ type: "auth_done", flowId, providerId: id, ok: true });
	}

	private askValues(
		owner: object,
		connectorId: string,
		fields: readonly SetupField[],
		emit: Emit,
		finish: (values: Record<string, string>, flowId: string) => void,
	): void {
		const id = `connector-setup-${randomUUID()}`;
		this.setupFlow = {
			id,
			connectorId,
			owner,
			emit,
			fields,
			values: {},
			finish: (values) => finish(values, id),
		};
		this.askNext(this.setupFlow);
	}

	private askNext(setup: Setup, again = false): void {
		const field = setup.fields[Object.keys(setup.values).length];
		if (!field) return;
		setup.emit({
			type: "auth_prompt",
			prompt: {
				flowId: setup.id,
				kind: field.secret ? "secret" : "text",
				message: again ? `${field.label} is needed to continue.` : field.label,
				...(field.optional ? { optional: true } : {}),
			},
		});
	}

	private takeValue(setup: Setup, typed: string): void {
		const field = setup.fields[Object.keys(setup.values).length];
		if (!field) return;
		const value = typed.trim();
		if (!value && !field.optional) {
			this.askNext(setup, true);
			return;
		}
		setup.values[field.key] = value;
		if (Object.keys(setup.values).length < setup.fields.length) {
			this.askNext(setup);
			return;
		}
		this.setupFlow = undefined;
		setup.finish(setup.values);
	}

	private cancelSetup(setup: Setup): void {
		if (this.setupFlow === setup) this.setupFlow = undefined;
		setup.emit({
			type: "auth_done",
			flowId: setup.id,
			providerId: setup.connectorId,
			ok: false,
			message: "Setup cancelled.",
		});
	}

	private change(
		id: string,
		update: (saved: SavedConnector) => SavedConnector,
	): ConnectorRefusal | undefined {
		const saved = this.options.store.state().connectors[id];
		if (!specOf(id, saved)) return REFUSALS.unknown;
		if (!saved) return REFUSALS.notAdded;
		this.options.store.update((state) => {
			state.connectors[id] = update(saved);
		});
		this.onChanged(true);
		return undefined;
	}

	/** The engine's sign-in command, pointed at the daemon's sign-in home (the real servers), never the engine's. */
	private run(subcommand: "login" | "logout", id: string): ChildProcess {
		const { cli, env, cwd, store } = this.options;
		const done = store.signingIn();
		const child = spawn(cli.command, [...cli.args, "mcp", subcommand, id], {
			cwd,
			env: { ...env, PI_CODING_AGENT_DIR: store.signinHome },
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.on("error", done);
		child.on("close", done);
		return child;
	}

	private startLogin(owner: object, connectorId: string, emit: Emit, flowId?: string): void {
		const child = this.run("login", connectorId);
		const flow: Flow = {
			id: flowId ?? `connector-${randomUUID()}`,
			connectorId,
			owner,
			emit,
			child,
			cancelled: false,
			printed: "",
			output: "",
		};
		this.flow = flow;
		this.failed.delete(connectorId);
		child.stdout?.on("data", (chunk: Buffer) => this.onOutput(flow, chunk.toString("utf8")));
		child.stderr?.on("data", (chunk: Buffer) => {
			flow.output = `${flow.output}${chunk.toString("utf8")}`.slice(-2000);
		});
		child.on("error", (error) => this.log(`connector sign-in could not start: ${error.message}`));
		child.on("close", (code) => this.onExit(flow, code));
	}

	private onOutput(flow: Flow, text: string): void {
		if (flow.printed === undefined) return;
		flow.printed = `${flow.printed}${text}`.slice(-8000);
		// The link ends with its line; a chunk may stop in the middle of it.
		const url = flow.printed.match(/https?:\/\/\S+(?=\s)/)?.[0];
		if (!url || !URL.canParse(url)) return;
		flow.printed = undefined;
		const authorization = new URL(url);
		const redirect = authorization.searchParams.get("redirect_uri");
		if (redirect && URL.canParse(redirect))
			flow.redirect = { url: new URL(redirect), state: authorization.searchParams.get("state") };
		const name =
			specOf(flow.connectorId, this.options.store.state().connectors[flow.connectorId])?.name ??
			flow.connectorId;
		flow.emit({
			type: "auth_event",
			flowId: flow.id,
			event: {
				kind: "auth_url",
				url,
				instructions: `Open the ${name} page and approve access. You can come back here when it says you are done.`,
			},
		});
		this.askForAddress(flow);
	}

	private askForAddress(flow: Flow, retry = false): void {
		flow.emit({
			type: "auth_prompt",
			prompt: {
				flowId: flow.id,
				kind: "manual_code",
				message: retry ? `That address is not from this sign-in. ${PASTE_PROMPT}` : PASTE_PROMPT,
			},
		});
	}

	/**
	 * The browser could not reach this computer's sign-in page (for example, the assistant runs
	 * elsewhere): the pasted address is that page's address, so open it here. Only the exact
	 * loopback address of this sign-in, with its `state`, is accepted.
	 */
	private async finishWithPastedAddress(flow: Flow, pasted: string): Promise<void> {
		const expected = flow.redirect;
		const url = URL.canParse(pasted.trim()) ? new URL(pasted.trim()) : undefined;
		const loopback = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if (
			!expected ||
			!url ||
			!loopback ||
			url.protocol !== "http:" ||
			url.origin !== expected.url.origin ||
			url.pathname !== expected.url.pathname ||
			url.searchParams.get("state") !== expected.state
		) {
			this.askForAddress(flow, true);
			return;
		}
		if (url.hostname === "localhost") url.hostname = "127.0.0.1";
		try {
			// Only this loopback address; where it redirects is not followed.
			await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
		} catch {
			if (this.flow === flow) this.askForAddress(flow, true);
		}
	}

	private cancel(flow: Flow): void {
		flow.cancelled = true;
		flow.child.kill("SIGTERM");
	}

	private onExit(flow: Flow, code: number | null): void {
		if (this.flow === flow) this.flow = undefined;
		const done = { type: "auth_done", flowId: flow.id, providerId: flow.connectorId } as const;
		if (code === 0 && !flow.cancelled) {
			this.log(`signed in to connector ${flow.connectorId}`);
			flow.emit({ ...done, ok: true });
		} else if (flow.cancelled) {
			flow.emit({ ...done, ok: false, message: "Sign-in cancelled." });
		} else {
			this.failed.add(flow.connectorId);
			const detail =
				flow.output
					.trim()
					.split("\n")
					.pop()
					?.replace(/https?:\/\/\S+/g, "[address]") ?? "";
			this.log(`sign-in to connector ${flow.connectorId} failed (exit ${code}): ${detail.slice(0, 200)}`);
			flow.emit({ ...done, ok: false, message: "Sign-in did not finish. Please try again." });
		}
		this.onChanged(false);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

/** A draft's fields, checked; undefined when anything is missing or malformed. */
function parseDraft(text: string): ConnectorDraft | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	// A typed value in the command line or the address would hand the secret to the model's choice.
	if (draftSecretProblem(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.name === "string" ? raw.name.trim() : "";
	const description = raw.description === undefined ? "" : raw.description;
	const envNames = raw.env_names === undefined ? [] : raw.env_names;
	if (!name || name.length > 60 || typeof description !== "string" || description.length > 500)
		return undefined;
	if (
		!Array.isArray(envNames) ||
		envNames.length > 20 ||
		!envNames.every((n) => typeof n === "string" && ENV_NAME.test(n))
	)
		return undefined;
	const base = {
		draftId: randomUUID(),
		name,
		description: description.trim(),
		envNames: [...new Set(envNames)],
	};
	if (raw.transport === "stdio") {
		const { command, args = [] } = raw;
		if (typeof command !== "string" || !command.trim() || command.length > 300) return undefined;
		if (
			!Array.isArray(args) ||
			args.length > 40 ||
			!args.every((a) => typeof a === "string" && a.length <= 500)
		)
			return undefined;
		return { ...base, transport: "stdio", command, ...(args.length > 0 ? { args } : {}), needsOAuth: false };
	}
	if (raw.transport === "http") {
		const url =
			typeof raw.url === "string" && raw.url.length <= 2000 && URL.canParse(raw.url)
				? new URL(raw.url)
				: undefined;
		const loopback = url && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
		if (!url || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return undefined;
		return { ...base, transport: "http", url: raw.url as string, needsOAuth: raw.needs_oauth === true };
	}
	return undefined;
}

/** Compares servers by what they run or reach: an npm package's version and a URL's query do not count. */
function fingerprint(server: ServerTemplate): string {
	if ("url" in server) {
		const url = URL.canParse(server.url) ? new URL(server.url) : undefined;
		return url ? `url ${url.origin}${url.pathname.replace(/\/+$/, "")}` : `url ${server.url}`;
	}
	const unversioned = (arg: string) => arg.replace(/^(@?[^@\s/]+(?:\/[^@\s]+)?)@[\w.^~<>=*-]+$/, "$1");
	return ["cmd", server.command, ...(server.args ?? []).map(unversioned)].join("\u0000");
}

const MASK = "•••";
/** A flag or name whose value is a credential. */
const SECRET_FLAG = /token|secret|key|pass|auth|cred|bearer/i;
/** A header that carries a credential (`Name: value`). */
const SECRET_HEADER =
	/^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|key|auth|pass|cred|session|bearer/i;
const HEADER_FLAG = /^(--header|-H)$/;
/** Known credential prefixes: GitHub, OpenAI and Stripe style, Slack, AWS, GitLab. */
const SECRET_PREFIX = /^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|sk-|sk_|rk_|xox[abprse]-|AKIA|ASIA|glpat-)/;
/** A long run of letters and digits with no separators, as tokens are (a word-only name is kept). */
const OPAQUE = (min: number) =>
	new RegExp(`^(?=[A-Za-z0-9_-]{${min},}$)(?=.*\\d|.*[a-z].*[A-Z]|.*[A-Z].*[a-z])`);
const OPAQUE_SEGMENT = OPAQUE(20);
const OPAQUE_WORD = OPAQUE(32);
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * The command line or address as the user can recognize it (command, host, path), with every value
 * that can hold a credential masked: an address loses its user and password, its query values, and
 * long opaque path segments; a header passed as an argument keeps only its name; the value of a
 * flag named like a credential is masked, and so are known token prefixes. Env values and headers
 * are never part of it.
 */
export function summarize(server: ServerTemplate): string {
	if ("url" in server) return maskAddress(server.url);
	const words = [server.command, ...(server.args ?? [])];
	return words.map((word, index) => maskWord(word, index > 0 ? words[index - 1] : undefined)).join(" ");
}

function maskWord(word: string, previous: string | undefined): string {
	if (previous !== undefined && HEADER_FLAG.test(previous)) return maskHeader(word, true);
	if (
		previous !== undefined &&
		/^--?[A-Za-z0-9][\w.-]*$/.test(previous) &&
		SECRET_FLAG.test(previous) &&
		!word.startsWith("-")
	)
		return MASK;
	if (previous !== undefined && /^(bearer|basic|token)$/i.test(previous)) return MASK;
	if (URL_LIKE.test(word)) return maskAddress(word);
	const assignment = /^(-{0,2}[A-Za-z0-9_][\w.-]*)=(.*)$/s.exec(word);
	if (assignment) {
		const [, name = "", value = ""] = assignment;
		if (HEADER_FLAG.test(name)) return `${name}=${maskHeader(value, true)}`;
		if (SECRET_FLAG.test(name)) return `${name}=${MASK}`;
		return `${name}=${maskWord(value, undefined)}`;
	}
	const header = maskHeader(word, false);
	if (header !== word) return header;
	return SECRET_PREFIX.test(word) || OPAQUE_WORD.test(word) ? MASK : word;
}

/** `Name: value` with the value masked when the name carries a credential, or always after `--header`. */
function maskHeader(word: string, always: boolean): string {
	const header = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/s.exec(word);
	if (!header) return always ? MASK : word;
	const [, name = ""] = header;
	return always || SECRET_HEADER.test(name) ? `${name}: ${MASK}` : word;
}

/** An address as scheme, host, and path: no user or password, query values masked, no fragment. */
function maskAddress(text: string): string {
	if (!URL.canParse(text)) return text.replace(/[?#].*$/s, "").replace(/^([^/]*\/\/)[^/@]*@/, "$1");
	const url = new URL(text);
	const path = url.pathname
		.split("/")
		.map((segment) => (OPAQUE_SEGMENT.test(segment) || SECRET_PREFIX.test(segment) ? MASK : segment))
		.join("/");
	const keys = [...new Set(url.searchParams.keys())];
	const query =
		keys.length > 0 ? `?${keys.map((key) => `${maskWord(key, undefined)}=${MASK}`).join("&")}` : "";
	return `${url.protocol}//${url.host}${path}${query}`;
}

/** The guard's policy for the engine's environment; the engine cannot change its own environment. */
export function policyEnv(store: ConnectorStore): NodeJS.ProcessEnv {
	return { [POLICY_ENV]: JSON.stringify(store.policy()) };
}

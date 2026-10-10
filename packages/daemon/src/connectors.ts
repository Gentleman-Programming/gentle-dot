import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	type FSWatcher,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { childGuardFile, childGuardText } from "./child-guard.ts";
import { resolveRecord, resolveValue, storedSignIn } from "./connector-credentials.ts";
import { type ScannedServer, scanClientConfigs, valueNotes } from "./connector-import.ts";
import {
	INTEGRITY_KEY_ID,
	macMatches,
	newIntegrityKey,
	parseIntegrityKey,
	recordMac,
} from "./connector-integrity.ts";
import { type OAuthSettings, type SignIn, SignInCancelledError, startSignIn } from "./connector-oauth.ts";
import { type ConnectorPolicy, draftSecretProblem, POLICY_ENV } from "./extensions/approval-guard.ts";
import type { ProxiedConnector, UpstreamCredentials } from "./mcp-proxy.ts";
import { runtimeDir, runtimeModules } from "./runtime.ts";
import { NO_APP, type SecretSource, SecretsUnavailableError } from "./secret-source.ts";

export { INTEGRITY_KEY_ID } from "./connector-integrity.ts";

/** What windows are told once after a changed `connectors.json` was set aside (S25.6). */
export const SET_ASIDE_NOTICE =
	"Connectors were changed while Gentle Dot was closed, so they were set aside. Review them in Connectors.";
/** The app is there but the integrity key could not be read or stored: nothing that needs a secret runs (A1, L120). */
export const INTEGRITY_UNCHECKED =
	"Gentle Dot could not check your connectors, so the ones that need a secret stay locked. Restart Gentle Dot to try again.";
/** A signed `connectors.json` was deleted while Gentle Dot was closed (A3, L120). */
export const MISSING_NOTICE =
	"Your connectors file was removed while Gentle Dot was closed. Add your connectors again in Connectors.";

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
	/** Signs in with OAuth (run by the daemon). */
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
	/**
	 * The values the user typed, by field key; never sent to a window or written to the log. A secret
	 * one is only a reference to its item in the app's secure store ({@link secretRef}).
	 */
	values?: Record<string, string>;
	custom?: CustomConnector;
	/** The OAuth sign-in: a reference to its item in the app's secure store. */
	signIn?: string;
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

/**
 * A secret in the daemon's memory is only a reference to its item in the app's secure store (S25.5):
 * this prefix and the item's id. No typed or imported text can start with NUL. Files get
 * `{"secretRef": "<id>"}` in its place, and the value itself is fetched from the app when needed.
 */
const REF = "\u0000secret-ref:";
const SECRET_ID = /^[A-Za-z0-9._:@/-]{1,200}$/;
/** The reference to the secret item `id`. */
export const secretRef = (id: string) => `${REF}${id}`;
const refId = (text: string) => (text.startsWith(REF) ? text.slice(REF.length) : undefined);
/**
 * Whether `text` is the reference to the secret of exactly this slot. Ids follow from the
 * connector and the field, so a reference to any other item (one planted in `connectors.json`
 * while the daemon was down, pointing at another connector's secret) is never read (A1, L117).
 */
const ownRef = (text: string, slotId: string) => refId(text) === slotId;

/** A part of a secret id: as it is when the app accepts it, otherwise a hash of it. */
const idPart = (text: string) =>
	/^[A-Za-z0-9._-]{1,64}$/.test(text) ? text : createHash("sha256").update(text).digest("hex").slice(0, 32);
/** Where a connector's secrets live in the app's store: `connector/<id>/…`. */
export const secretPrefix = (connectorId: string) => `connector/${idPart(connectorId)}/`;
const signInId = (connectorId: string) => `${secretPrefix(connectorId)}signin`;
/** The connector's own sign-in reference, or undefined when it has none or refers elsewhere (A1). */
const signInRef = (connectorId: string, saved: SavedConnector) =>
	saved.signIn && refId(saved.signIn) === signInId(connectorId) ? signInId(connectorId) : undefined;

/** A value of a server of the user's own that is a secret: anything but an empty one or one with a field in it. */
const FIELD_START = placeholder("").slice(0, -1);
const secretText = (text: string) => text !== "" && !text.includes(FIELD_START);

/**
 * The connector with each secret it holds passed through `map(id, text)`: the values of secret
 * fields, and for a server of the user's own its environment values, headers, and OAuth client
 * secret (imported or drafted servers keep them in their entry). The sign-in is not included.
 */
function mapSecrets(
	id: string,
	saved: SavedConnector,
	map: (secretId: string, text: string) => string,
): SavedConnector {
	const spec = specOf(id, saved);
	const out = structuredClone(saved);
	const prefix = secretPrefix(id);
	if (out.values && spec)
		for (const field of spec.fields) {
			const text = out.values[field.key];
			if (field.secret && text) out.values[field.key] = map(`${prefix}value/${idPart(field.key)}`, text);
		}
	const server = out.custom?.server;
	const record = (entries: Record<string, string> | undefined, kind: string) => {
		for (const [name, text] of Object.entries(entries ?? {}))
			if (entries && typeof text === "string" && secretText(text))
				entries[name] = map(`${prefix}${kind}/${idPart(name)}`, text);
	};
	if (server && "command" in server) record(server.env, "env");
	else if (server) {
		record(server.headers, "header");
		const secret = server.oauth?.clientSecret;
		if (server.oauth && secret && secretText(secret))
			server.oauth.clientSecret = map(`${prefix}client-secret`, secret);
	}
	return out;
}

/** Every secret item a connector refers to, its sign-in included. */
function refsOf(id: string, saved: SavedConnector): string[] {
	const ids: string[] = [];
	mapSecrets(id, saved, (secretId, text) => {
		if (ownRef(text, secretId)) ids.push(secretId);
		return text;
	});
	const signIn = signInRef(id, saved);
	if (signIn) ids.push(signIn);
	return ids;
}

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

function writePrivate(path: string, text: string): void {
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, text, { mode: 0o600 });
	renameSync(temp, path);
}

export interface ConnectorStoreOptions {
	dataDir: string;
	/** The engine's home, which holds its `mcp.json` (and held `mcp-auth.json` before the proxy). */
	agentHome: string;
	/**
	 * Where the connectors' secrets live: the desktop app's secure store over its channel (S25.5).
	 * Without one, connectors that need a secret fail closed with {@link NO_APP}.
	 */
	secrets?: SecretSource;
	/** The environment the values of imported servers may read (`$NAME`); default the daemon's. */
	env?: NodeJS.ProcessEnv;
	/** The engine's working folder; a project `.pi/mcp.json` there would add servers. */
	workspace?: string;
	/** The approval guard's own file, protected like the connector files. */
	guardPath?: string;
	/**
	 * Keeps the file that loads the guard (`guardPath`) into the engine's subagents in the engine's
	 * extensions folder, written and put back like `mcp.json` and protected like the guard (S25.4).
	 */
	childGuard?: boolean;
	log?: (line: string) => void;
}

/** What a remote connector's OAuth sign-in needs: its server, the user's own client, and the stored sign-in. */
export interface SignInTarget {
	serverUrl: string;
	settings: OAuthSettings;
	stored?: McpOAuthState;
}

/**
 * The connectors the user approved. The daemon reads `<data>/connectors.json` once, when it
 * starts, and from then on the state lives in memory and changes only through the Connectors
 * screen. The files (`connectors.json` and the engine's `mcp.json`) are written from memory; a change
 * made by anything else (the assistant has a shell) is put back, and a project `.pi/mcp.json` in the
 * workspace is removed. Checked on every file event, before every engine start, and after every
 * run. Every write of `connectors.json` is signed (S25.6, {@link checkIntegrity}): with the app, a
 * file changed while the daemon was not running is set aside at the next start instead of loaded.
 *
 * Secrets (S25.5) are never in a file: `connectors.json` holds `{"secretRef": "<id>"}` in their
 * place, the values live in the desktop app's secure store, and the daemon keeps the ones it read
 * in memory until the app's channel closes. The engine's `mcp.json` lists only the daemon's proxy
 * (S25.4). Secrets that files held before (`connectors.json`, the old sign-in home, and the
 * engine's `mcp-auth.json`) move into the app's store once, with {@link ConnectorStore.migrate}.
 */
export class ConnectorStore {
	readonly file: string;
	readonly mcpFile: string;
	/** Where the daemon kept the real servers and the sign-ins before T23d; removed once migrated. */
	readonly signinHome: string;
	readonly signinMcpFile: string;
	/** The sign-ins of the old sign-in home (pi-mcp's OAuth state by `mcp__<server>|<url>`). */
	readonly authFile: string;
	/** Where the engine kept the sign-ins before the proxy. */
	readonly legacyAuthFile: string;
	/** Called after a change made outside the Connectors screen was put back. */
	onReverted: () => void = () => {};
	/** Called after every change to the state (the proxy closes what it no longer may use). */
	onUpdated: () => void = () => {};
	/** Called once when a changed `connectors.json` was set aside at start; `notice` is for the user. */
	onSetAside: (notice: string) => void = () => {};
	private saved: ConnectorsState;
	/** `connectors.json` as it was read at start: its text, and the record when it was a JSON object. */
	private loaded: { text: string; record?: Record<string, unknown> } | undefined;
	/** Set when the app is there but the file could not be checked: secrets stay locked until a start can (A1). */
	private unchecked = false;
	/** The signing key from the app's store, once {@link checkIntegrity} read it; only in memory. */
	private integrityKey: Buffer | undefined;
	/** True once the record differs from what was read at start (a change, a move, a migration). */
	private edited = false;
	/** The desktop app's helper while a window has it registered; only in memory and `mcp.json`. */
	private computer: ComputerEndpoint | undefined;
	/** The daemon's proxy for the running engine; only in memory and `mcp.json`. */
	private proxy: ProxyEndpoint | undefined;
	/** Secrets read from or stored in the app's store, by id; only in memory. */
	private readonly cache = new Map<string, string>();
	/** Secrets `connectors.json` still holds as text, by the id they move to; kept in the file until then. */
	private readonly pending = new Map<string, string>();
	/** True once the sign-in files were moved (`version: 2`); files that appear later are not imported. */
	private migrated: boolean;
	private migrating: Promise<void> | undefined;
	/** Stores still running (a secret sealed by {@link update}). */
	private readonly writes = new Set<Promise<unknown>>();
	/** Sign-in files that appeared after the move and were reported. */
	private readonly reported = new Set<string>();
	private watchers: FSWatcher[] = [];
	/** Set once a child guard that cannot be written was reported, so the checks every second stay quiet. */
	private childGuardReported = false;
	private readonly options: ConnectorStoreOptions;
	/** The file that loads the guard into the engine's subagents, when the store keeps one. */
	readonly childGuard: { file: string; text: string } | undefined;

	constructor(options: ConnectorStoreOptions) {
		this.options = options;
		this.file = join(options.dataDir, "connectors.json");
		this.mcpFile = join(options.agentHome, "mcp.json");
		this.childGuard =
			options.childGuard && options.guardPath
				? { file: childGuardFile(options.agentHome), text: childGuardText(options.guardPath) }
				: undefined;
		this.signinHome = join(options.dataDir, "connector-signin");
		this.signinMcpFile = join(this.signinHome, "mcp.json");
		this.authFile = join(this.signinHome, "mcp-auth.json");
		this.legacyAuthFile = join(options.agentHome, "mcp-auth.json");
		const { state, renamed, version } = this.load();
		this.saved = state;
		// A new install has nothing to move.
		this.migrated =
			version >= 2 || (version === 0 && ![this.authFile, this.legacyAuthFile].some((f) => existsSync(f)));
		if (renamed) {
			this.edited = true;
			writePrivate(this.file, this.recordText());
		}
	}

	get agentHome(): string {
		return this.options.agentHome;
	}

	state(): ConnectorsState {
		return structuredClone(this.saved);
	}

	/**
	 * Changes the state, then writes the files (each atomically, mode 0600). A secret the change put
	 * in as text is stored in the app's store and replaced by its reference first; without the app it
	 * is dropped (the connector then needs it again).
	 */
	update(change: (state: ConnectorsState) => void): void {
		const state = this.state();
		change(state);
		for (const [id, saved] of Object.entries(state.connectors))
			state.connectors[id] = mapSecrets(id, saved, (secretId, text) =>
				refId(text) !== undefined ? text : this.seal(secretId, text),
			);
		this.saved = state;
		this.edited = true;
		mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
		writePrivate(this.file, this.recordText());
		writePrivate(this.mcpFile, this.engineMcpText());
		this.onUpdated();
	}

	/**
	 * Checks the signature of `connectors.json` as it was read at start (S25.6); the daemon awaits it
	 * before it watches the files or starts the engine. With the app's store: the signing key is read,
	 * or created on the first start with the app (and the current file signed: the first start after
	 * T23e). A file that was signed before (it has a `mac`, or the key already existed) whose `mac` is
	 * missing or wrong was changed while the daemon was down: it is moved to
	 * `connectors.rejected-<UTC time>.json` (0600), the daemon starts with no connectors, and
	 * {@link onSetAside} tells the user once; the secrets in the app's store are left alone. Without
	 * the app (or when the key cannot be read) the file cannot be checked: it stays loaded as it is,
	 * that is logged, and it is put back byte for byte, so its signature survives until a daemon the
	 * app launches checks it.
	 */
	async checkIntegrity(): Promise<void> {
		const source = this.options.secrets;
		const present = this.loaded !== undefined;
		const notVerified = (why: string) => {
			if (present)
				this.log(
					`connectors.json was not verified: ${why}; it is used as it is, and connectors that need a secret stay locked without the app`,
				);
		};
		if (!source?.available) {
			notVerified("the desktop app is not connected");
			return;
		}
		// With the app there, a check that cannot run fails closed: the file stays as it is and no
		// secret is read until a start that can check it (A1).
		const cannot = (why: string) => {
			this.unchecked = true;
			this.log(`connectors.json could not be checked: ${why}; connectors that need a secret stay locked`);
			this.onSetAside(INTEGRITY_UNCHECKED);
		};
		let stored: string | undefined;
		try {
			stored = await source.get(INTEGRITY_KEY_ID);
		} catch (error) {
			cannot(`its key could not be read (${(error as Error).message})`);
			return;
		}
		let key = parseIntegrityKey(stored);
		if (!key) {
			const created = newIntegrityKey();
			try {
				await this.verifiedPut(source, INTEGRITY_KEY_ID, created);
			} catch (error) {
				cannot(`its key could not be stored (${(error as Error).message})`);
				return;
			}
			key = Buffer.from(created, "hex");
		}
		this.integrityKey = key;
		if (!this.loaded) {
			// A file that was signed before is gone: say so instead of starting empty in silence (A3).
			if (stored !== undefined) {
				this.log("connectors.json was signed before and is missing; starting with no connectors");
				this.onSetAside(MISSING_NOTICE);
			}
			return;
		}
		const record = this.loaded.record;
		const signedBefore = stored !== undefined || (record !== undefined && "mac" in record);
		if (!signedBefore) {
			this.edited = true;
			writePrivate(this.file, this.recordText());
			this.log("signed connectors.json for the first time");
			return;
		}
		if (record && macMatches(key, record)) return;
		this.setAside();
	}

	/** Waits for the secrets {@link update} is still storing. */
	async settled(): Promise<void> {
		while (this.writes.size > 0) await Promise.allSettled([...this.writes]);
	}

	/**
	 * Stores the values the user typed for a connector: the secret ones in the app's store (only
	 * their references in memory and `connectors.json`), the others as they are. A secret left empty
	 * removes its item. Rejects without the app, and then nothing changes.
	 */
	async keepValues(id: string, values: Record<string, string>): Promise<void> {
		const current = this.saved.connectors[id] ?? { enabled: false, mode: "read_only" };
		const spec = specOf(id, current);
		if (!spec) throw new Error(`The connector ${id} is not available.`);
		const prefix = secretPrefix(id);
		const kept: Record<string, string> = {};
		for (const [key, value] of Object.entries(values)) {
			const field = spec.fields.find((f) => f.key === key);
			const secretId = `${prefix}value/${idPart(key)}`;
			if (!field?.secret) kept[key] = value;
			else if (value) {
				await this.keep(secretId, value);
				kept[key] = secretRef(secretId);
			} else {
				kept[key] = "";
				await this.secrets().delete(secretId);
				this.cache.delete(secretId);
			}
		}
		this.update((state) => {
			state.connectors[id] = { ...(state.connectors[id] ?? current), values: kept };
		});
	}

	/** Forgets a connector's secrets in the app's store (when it is removed); the state is not changed. */
	async forget(id: string): Promise<void> {
		const prefix = secretPrefix(id);
		for (const key of [...this.cache.keys(), ...this.pending.keys()])
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
				this.pending.delete(key);
			}
		const source = this.options.secrets;
		if (!source?.available) {
			this.log(`the secrets of connector ${id} stay in the app's secure store: the app is not connected`);
			return;
		}
		try {
			for (const secretId of await source.list())
				if (secretId.startsWith(prefix)) await source.delete(secretId);
		} catch (error) {
			this.log(`could not remove the secrets of connector ${id}: ${(error as Error).message}`);
		}
	}

	/** Forgets every secret read so far (the app's channel closed); the next use asks the app again. */
	lock(): void {
		if (this.cache.size === 0) return;
		this.cache.clear();
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

	/** Reads a connector's secrets from the app before the proxy uses it; failures leave it locked. */
	async prepare(id: string): Promise<void> {
		await this.unlock(id).catch(() => {});
	}

	/**
	 * A connector as the proxy sees it, from the state in memory; undefined when it cannot run. When
	 * a secret it needs is not in memory (no app, or its item is gone), `unavailable` says why.
	 */
	proxyView(id: string): ProxiedConnector | undefined {
		const saved = this.saved.connectors[id];
		if (!saved) return undefined;
		const { open, locked } = this.open(id, saved);
		const filled = filledServer(id, open);
		if (!filled) return undefined;
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
			revision: createHash("sha256")
				.update(JSON.stringify(server))
				.update(locked ?? "")
				.digest("hex"),
			...(locked ? { unavailable: locked } : {}),
		};
	}

	/**
	 * What the proxy adds to the real server: the values the user typed (headers, a stdio server's
	 * environment) as they were typed, and for a remote server without its own Authorization header,
	 * the stored sign-in, refreshed when it expires (the new tokens go to the app's store).
	 */
	async credentials(id: string): Promise<UpstreamCredentials> {
		const { spec, server } = await this.unlocked(id);
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
		const authProvider = storedSignIn(
			server.url,
			{ load: () => this.signInState(id), save: (state) => this.saveSignIn(id, state) },
			() => {
				const { clientId, clientSecret, callbackUrl } = oauthSettings(spec.name, server, env);
				return {
					...(clientId ? { clientId } : {}),
					...(clientSecret ? { clientSecret } : {}),
					...(callbackUrl ? { redirectUrl: callbackUrl } : {}),
				};
			},
		);
		return { ...(headers ? { headers } : {}), authProvider };
	}

	/** What a sign-in to a remote connector needs; rejects when its secrets cannot be read. */
	async signInTarget(id: string): Promise<SignInTarget> {
		const { spec, server } = await this.unlocked(id);
		if (!("url" in server)) throw new Error(`${spec.name} does not use a sign-in.`);
		const stored = this.signInState(id);
		return {
			serverUrl: server.url,
			settings: oauthSettings(spec.name, server, this.options.env ?? process.env),
			...(stored ? { stored } : {}),
		};
	}

	/** Stores a sign-in (new, or refreshed) in the app's store and refers to it from the state. */
	async saveSignIn(id: string, state: McpOAuthState): Promise<void> {
		const secretId = signInId(id);
		await this.keep(secretId, JSON.stringify(state));
		if (this.saved.connectors[id] && this.saved.connectors[id].signIn !== secretRef(secretId))
			this.update((current) => {
				const saved = current.connectors[id];
				if (saved) saved.signIn = secretRef(secretId);
			});
	}

	/** The helper's address while it is registered (never its key). */
	computerUrl(): string | undefined {
		return this.computer?.url;
	}

	/**
	 * Moves the secrets files still hold into the app's store, once the app is there (S25.5): text
	 * secrets in `connectors.json`, then the sign-ins of the old sign-in home and of the engine's old
	 * `mcp-auth.json` (the daemon's own win). Each one is stored, read back, and compared before the
	 * file loses it; when one fails, the files stay as they were and the next start tries again. An
	 * empty sign-in file is removed (logged); one that cannot be read or parsed is reported and left
	 * as it is, the rest still move, and the move is not marked done until it can be read. Afterwards
	 * `connectors.json` says so (`version: 2`), and sign-in files that appear later are reported once
	 * and left alone, never imported. Nothing secret is logged.
	 */
	migrate(): Promise<void> {
		this.migrating ??= this.runMigration().finally(() => {
			this.migrating = undefined;
		});
		return this.migrating;
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
		] as const) {
			const current = readOrUndefined(file);
			if (current === text || (current === undefined && empty)) continue;
			mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
			writePrivate(file, text);
			changed.push(file);
		}
		if (this.enforceChildGuard()) changed.push(this.childGuard?.file ?? "");
		if (this.removeProjectConfig()) changed.push("the workspace's .pi/mcp.json");
		this.reportPlanted();
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
		const folders = [this.options.dataDir, this.options.agentHome, this.options.workspace];
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
	 * The old sign-in files stay protected in case they appear again.
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
				...(this.childGuard ? [this.childGuard.file] : []),
			],
			...(this.computer ? { builtin: [COMPUTER_ID] } : {}),
		};
	}

	/** True when the connector has a stored sign-in with tokens. No token value is kept or passed on. */
	isSignedIn(id: string): boolean {
		const saved = this.saved.connectors[id];
		const ref = saved && signInRef(id, saved);
		if (!ref) return false;
		const text = this.cache.get(ref);
		// Stored only once it had tokens; until it is read again it counts as signed in.
		if (text === undefined) return true;
		return typeof this.signInState(id)?.tokens?.access_token === "string";
	}

	private secrets(): SecretSource {
		if (this.unchecked) throw new SecretsUnavailableError(INTEGRITY_UNCHECKED);
		const source = this.options.secrets;
		if (!source?.available) throw new SecretsUnavailableError();
		return source;
	}

	/** Stores a secret in the app's store and keeps it in memory. */
	private async keep(id: string, secret: string): Promise<void> {
		await this.secrets().put(id, secret);
		this.cache.set(id, secret);
	}

	/** A secret {@link update} got as text: stored in the app's store in the background, or dropped without one. */
	private seal(id: string, text: string): string {
		const source = this.options.secrets;
		if (!source?.available) {
			this.log("a connector secret was not kept: the app's secure store is not connected");
			return secretRef(id);
		}
		this.cache.set(id, text);
		const write = source
			.put(id, text)
			.catch((error: Error) => {
				if (this.cache.get(id) === text) this.cache.delete(id);
				this.log(`a connector secret could not be stored: ${error.message}`);
			})
			.finally(() => this.writes.delete(write));
		this.writes.add(write);
		return secretRef(id);
	}

	/** Reads every secret the connector refers to that is not in memory yet; rejects without the app. */
	private async unlock(id: string): Promise<void> {
		await this.migrating;
		const saved = this.saved.connectors[id];
		if (!saved) return;
		const missing = refsOf(id, saved).filter((ref) => !this.cache.has(ref) && !this.pending.has(ref));
		if (missing.length === 0) return;
		const source = this.secrets();
		for (const ref of missing) {
			const secret = await source.get(ref);
			if (secret !== undefined) this.cache.set(ref, secret);
		}
	}

	/** The connector's server with its secrets in place; rejects with why when one is missing. */
	private async unlocked(id: string) {
		await this.unlock(id);
		const saved = this.saved.connectors[id];
		if (!saved) throw new Error(`The connector ${id} is not set up.`);
		const { open, locked } = this.open(id, saved);
		if (locked) throw new SecretsUnavailableError(locked);
		const filled = filledServer(id, open);
		if (!filled) throw new Error(`The connector ${id} is not set up.`);
		return filled;
	}

	/**
	 * The connector with the secrets in memory in place of their references, and why it cannot run
	 * when one is not there: no app (or a secret still waiting in a file), or an item that is gone.
	 */
	private open(id: string, saved: SavedConnector): { open: SavedConnector; locked?: string } {
		let missing = false;
		let waiting = false;
		const open = mapSecrets(id, saved, (secretId, text) => {
			const ref = refId(text);
			if (ref === undefined) return text;
			if (!ownRef(text, secretId)) {
				// Another item's reference in this slot: never resolved, and the connector stays locked.
				missing = true;
				return text;
			}
			const secret = this.cache.get(ref);
			if (secret !== undefined) return secret;
			if (this.pending.has(ref)) waiting = true;
			missing = true;
			// Kept as the reference, so the connector still counts as set up.
			return text;
		});
		const signIn = signInRef(id, saved);
		if (saved.signIn && !signIn) missing = true;
		if (signIn && !this.cache.has(signIn) && !this.options.secrets?.available) missing = true;
		// A reference anywhere else (a changed file) never reaches a server.
		if (!missing && JSON.stringify(open.custom ?? {}).includes(JSON.stringify(REF).slice(1, -1)))
			missing = true;
		if (!missing) return { open };
		const name = specOf(id, saved)?.name ?? id;
		const locked =
			waiting || !this.options.secrets?.available
				? NO_APP
				: `A secret ${name} needs is missing from the app's secure store. Ask the user to set up ${name} again in Connectors.`;
		return { open, locked };
	}

	/** One connector's sign-in, from memory. */
	private signInState(id: string): McpOAuthState | undefined {
		const saved = this.saved.connectors[id];
		const ref = saved && signInRef(id, saved);
		const text = ref && this.cache.get(ref);
		if (!text) return undefined;
		try {
			return JSON.parse(text) as McpOAuthState;
		} catch {
			return undefined;
		}
	}

	private async runMigration(): Promise<void> {
		const source = this.options.secrets;
		if (!source?.available) return;
		// Secrets `connectors.json` still holds as text: all of them, or none.
		if (this.pending.size > 0) {
			try {
				for (const [id, secret] of this.pending) await this.verifiedPut(source, id, secret);
			} catch (error) {
				this.log(
					`could not move the connector secrets into the app's secure store (${(error as Error).message}); the files stay as they were`,
				);
				return;
			}
			const moved = this.pending.size;
			for (const [id, secret] of this.pending) this.cache.set(id, secret);
			this.pending.clear();
			this.edited = true;
			writePrivate(this.file, this.recordText());
			this.log(`moved ${moved} connector secrets from connectors.json into the app's secure store`);
		}
		if (!this.migrated) {
			let moved = 0;
			let dropped = 0;
			// A file that could not be read may hold secrets: the move is not done until it is.
			let unread = false;
			// The daemon's own sign-ins first: they win over the engine's older ones.
			for (const file of [this.authFile, this.legacyAuthFile]) {
				const states = this.readSignIns(file);
				if (states === "unread") unread = true;
				if (!states || states === "unread") continue;
				const refs: Record<string, string> = {};
				try {
					for (const [key, state] of Object.entries(states)) {
						const id = this.connectorForKey(key);
						if (!id) {
							dropped++;
							continue;
						}
						if (this.saved.connectors[id]?.signIn || refs[id]) continue;
						const secretId = signInId(id);
						const text = JSON.stringify(state);
						await this.verifiedPut(source, secretId, text);
						this.cache.set(secretId, text);
						refs[id] = secretRef(secretId);
						moved++;
					}
				} catch (error) {
					this.log(
						`could not move the connector sign-ins into the app's secure store (${(error as Error).message}); they stay where they were`,
					);
					this.applySignIns(refs);
					return;
				}
				this.applySignIns(refs);
				unlinkSync(file);
			}
			if (moved > 0) this.log(`moved ${moved} connector sign-ins into the app's secure store`);
			if (dropped > 0)
				this.log(
					`dropped ${dropped} sign-in${dropped === 1 ? "" : "s"} for a connector that is no longer added`,
				);
			if (unread) return;
			if (existsSync(this.signinMcpFile)) unlinkSync(this.signinMcpFile);
			try {
				if (readdirSync(this.signinHome).length === 0) rmdirSync(this.signinHome);
			} catch {}
			this.migrated = true;
			this.edited = true;
			mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
			writePrivate(this.file, this.recordText());
		}
		this.reportPlanted();
	}

	/** Stores a secret and reads it back; throws when it is not the same. */
	private async verifiedPut(source: SecretSource, id: string, secret: string): Promise<void> {
		await source.put(id, secret);
		if ((await source.get(id)) !== secret) throw new Error("a secret did not read back the same");
	}

	/**
	 * The sign-ins of an old file, by key; undefined when there is none or it is empty (an empty one
	 * holds nothing: it is removed, and that is logged). `"unread"` when it cannot be read or is not a
	 * list of sign-ins: it may hold secrets, so it is left as it is, reported, and tried again later.
	 */
	private readSignIns(file: string): Record<string, unknown> | "unread" | undefined {
		const unread = (why: string) => {
			this.log(
				`${file} ${why}; it may hold connector secrets and stays on disk as it is. The move into the app's secure store will be tried again at the next start; fix or remove the file`,
			);
			return "unread" as const;
		};
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return unread("could not be read");
		}
		if (text.trim() === "") {
			unlinkSync(file);
			this.log(`removed ${file}: it was empty and held no sign-ins`);
			return undefined;
		}
		return signInStates(text) ?? unread("is not a list of sign-ins");
	}

	/** The added connector whose remote server an old sign-in key names (`mcp__<server>|<url>`). */
	private connectorForKey(key: string): string | undefined {
		for (const [id, saved] of Object.entries(this.saved.connectors)) {
			const server = filledServer(id, saved)?.server;
			if (server && "url" in server && URL.canParse(server.url) && authKey(id, server.url) === key) return id;
		}
		return undefined;
	}

	private applySignIns(refs: Record<string, string>): void {
		if (Object.keys(refs).length === 0) return;
		this.update((state) => {
			for (const [id, ref] of Object.entries(refs)) {
				const saved = state.connectors[id];
				if (saved) saved.signIn = ref;
			}
		});
	}

	/** After the move, an old sign-in file that appears again is reported once and never read. */
	private reportPlanted(): void {
		if (!this.migrated) return;
		for (const file of [this.authFile, this.legacyAuthFile]) {
			if (this.reported.has(file) || !existsSync(file)) continue;
			this.reported.add(file);
			this.log(
				`found ${file} after the connector sign-ins moved to the app's secure store; it was not imported and was left as it is`,
			);
		}
	}

	private engineMcpText(): string {
		return renderMcpJson(this.saved, this.computer, this.proxy);
	}

	/** Moves a changed `connectors.json` aside (private), and starts over with no connectors, signed. */
	private setAside(): void {
		const stamp = new Date().toISOString().replace(/[-:.]/g, "");
		let target = join(this.options.dataDir, `connectors.rejected-${stamp}.json`);
		for (let n = 2; existsSync(target); n++)
			target = join(this.options.dataDir, `connectors.rejected-${stamp}-${n}.json`);
		let moved = false;
		try {
			renameSync(this.file, target);
			moved = true;
			// A planted link is moved as a link; what it points to is never touched.
			if (lstatSync(target).isFile()) chmodSync(target, 0o600);
		} catch (error) {
			this.log(`could not move connectors.json aside (${(error as Error).message}); it is replaced`);
		}
		this.saved = { connectors: {} };
		this.pending.clear();
		this.cache.clear();
		// Nothing from the changed file is trusted: old sign-in files are reported, never imported.
		this.migrated = true;
		this.edited = true;
		mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
		writePrivate(this.file, this.recordText());
		this.log(
			`connectors.json was changed while Gentle Dot was closed (its signature does not match)${moved ? `; moved it to ${target}` : ""} and started with no connectors; the secrets in the app's secure store were not touched`,
		);
		this.onUpdated();
		this.onSetAside(SET_ASIDE_NOTICE);
	}

	private log(line: string): void {
		this.options.log?.(line);
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

	/** True when the engine's subagents will load the guard: its file is in place, in a real folder. */
	childGuardReady(): boolean {
		if (!this.childGuard) return false;
		const { file, text } = this.childGuard;
		return (
			isFolder(dirname(file)) && lstatOrUndefined(file)?.isFile() === true && readOrUndefined(file) === text
		);
	}

	/**
	 * Writes the child guard's file when it differs or is missing; true when it did. An extensions
	 * folder that is a link loses the link, never what it points to. When the folder or the file's
	 * place holds something else, or it cannot be written, that is reported once and left alone, and
	 * the engine starts with subagents off ({@link childGuardReady}); the other connector files are
	 * still checked.
	 */
	private enforceChildGuard(): boolean {
		if (!this.childGuard || this.childGuardReady()) return false;
		const { file, text } = this.childGuard;
		const folder = dirname(file);
		const cannot = (why?: unknown) => {
			if (!this.childGuardReported)
				this.options.log?.(
					`the subagents' approval guard cannot be written to ${file}${why instanceof Error ? `: ${why.message}` : ""}`,
				);
			this.childGuardReported = true;
			return false;
		};
		try {
			if (lstatOrUndefined(folder)?.isSymbolicLink()) unlinkSync(folder);
			const inFolder = lstatOrUndefined(folder);
			const inPlace = inFolder && lstatOrUndefined(file);
			if ((inFolder && !inFolder.isDirectory()) || inPlace?.isDirectory()) return cannot();
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			writePrivate(file, text);
		} catch (error) {
			return cannot(error);
		}
		this.childGuardReported = false;
		return true;
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

	/**
	 * `connectors.json`: each secret as `{"secretRef": "<id>"}`, or as the text it still was until it
	 * moves, and `mac`, its signature (S25.6). Without the key the daemon cannot sign: a signed record
	 * as it was read is kept byte for byte while nothing changed it, so its signature is never lost.
	 */
	private recordText(): string {
		const signedAtStart = this.loaded?.record !== undefined && "mac" in this.loaded.record;
		if (!this.integrityKey && !this.edited && signedAtStart && this.loaded) return this.loaded.text;
		const record = JSON.parse(
			JSON.stringify(
				{ version: this.migrated ? 2 : 1, connectors: this.saved.connectors },
				(_key, value: unknown) => {
					const ref = typeof value === "string" ? refId(value) : undefined;
					return ref === undefined ? value : (this.pending.get(ref) ?? { secretRef: ref });
				},
			),
		) as Record<string, unknown>;
		const signed = this.integrityKey ? { ...record, mac: recordMac(this.integrityKey, record) } : record;
		return `${JSON.stringify(signed, null, 2)}\n`;
	}

	/**
	 * The saved state; a connector saved as `computer` (the built-in helper's name) gets `computer-2`.
	 * A secret saved as text (before T23d) waits in memory for {@link migrate} and is not used.
	 */
	private load(): { state: ConnectorsState; renamed: boolean; version: number } {
		let saved: { version?: unknown; connectors?: Record<string, Record<string, unknown> | undefined> };
		try {
			const text = readFileSync(this.file, "utf8");
			this.loaded = { text };
			const raw = JSON.parse(text) as unknown;
			if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
				this.loaded.record = raw as Record<string, unknown>;
			saved = JSON.parse(text, (_key, value: unknown) => {
				const ref = (value as { secretRef?: unknown } | null)?.secretRef;
				return typeof value === "object" && typeof ref === "string" && SECRET_ID.test(ref)
					? secretRef(ref)
					: value;
			});
		} catch {
			return { state: { connectors: {} }, renamed: false, version: existsSync(this.file) ? 1 : 0 };
		}
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
			if (typeof value?.signIn === "string" && refId(value.signIn)) entry.signIn = value.signIn;
			connectors[id] = mapSecrets(id, entry, (secretId, text) => {
				if (refId(text) !== undefined) return text;
				this.pending.set(secretId, text);
				return secretRef(secretId);
			});
		}
		const version = typeof saved.version === "number" ? saved.version : 1;
		return { state: { connectors }, renamed, version };
	}
}

/** The user's own OAuth client of a remote server, its secret resolved like the engine resolved it. */
function oauthSettings(
	name: string,
	server: Extract<ServerTemplate, { url: string }>,
	env: NodeJS.ProcessEnv,
): OAuthSettings {
	const { oauth } = server;
	return {
		...(oauth?.clientId ? { clientId: oauth.clientId } : {}),
		...(oauth?.clientSecret
			? { clientSecret: resolveValue(oauth.clientSecret, env, `${name} client secret`) }
			: {}),
		...(oauth?.callbackUrl ? { callbackUrl: oauth.callbackUrl } : {}),
		...(oauth?.callbackPort !== undefined ? { callbackPort: oauth.callbackPort } : {}),
		...(oauth?.scope ? { scope: oauth.scope } : {}),
	};
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
	/** The OAuth flow, once the connector's settings were read. */
	signIn?: SignIn;
	cancelled: boolean;
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

/** How sign-ins reach the provider and the user's browser; tests replace both. */
export interface ConnectorOAuthOptions {
	/** The fetch for discovery, client registration, and tokens; default the global one. */
	fetch?: typeof fetch;
	/** Called with each page to approve access on, besides sending it to the window (tests act as the browser). */
	openBrowser?: (url: string) => void;
}

export interface ConnectorManagerOptions {
	store: ConnectorStore;
	oauth?: ConnectorOAuthOptions;
	/** The home folder "Import my MCP servers" scans; default the user's. */
	importHome?: string;
	log?: (line: string) => void;
}

/**
 * Connects, sets up, signs in, changes, and removes connectors. Values the user types (a bot token,
 * an OAuth client) are asked one at a time with sign-in prompts; the secret ones go to the desktop
 * app's secure store (S25.5) and are never logged, sent back, or written to a file. Sign-in runs in
 * the daemon with pi-mcp's OAuth (one at a time; a fixed loopback callback port may be shared),
 * relays the authorization URL to the window that started it, and can finish with an address the
 * user pastes when the browser could not reach this computer; the tokens go to the app's store.
 * Drafts from the assistant and servers found in other apps are added only when the user says so,
 * read only, with every tool hidden. Nothing typed or printed is logged.
 */
export class ConnectorManager {
	/** `restart`: the engine must restart (when idle) to read the new `mcp.json`. */
	onChanged: (restart: boolean) => void = () => {};
	/** A change to the connector files made outside the Connectors screen was put back. */
	onBlocked: () => void = () => {};
	/** A `connectors.json` changed while the daemon was down was set aside; `notice` is for the user. */
	onSetAside: (notice: string) => void = () => {};
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
		options.store.onSetAside = (notice) => this.onSetAside(notice);
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
			this.askValues(owner, id, spec.fields, emit, (values, flowId) =>
				this.keepValues(
					id,
					values,
					emit,
					flowId,
					(current) => ({ ...current, enabled: true }),
					() => this.afterSetup(owner, id, emit, flowId),
				),
			);
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
		this.askValues(owner, id, spec.fields, emit, (values, flowId) =>
			this.keepValues(
				id,
				values,
				emit,
				flowId,
				(current) => current,
				() => this.afterSetup(owner, id, emit, flowId),
			),
		);
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
		this.finishWithPastedAddress(flow, answer.value);
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

	/** Forgets the connector and its secrets (its sign-in, tokens, and typed values) in the app's store. */
	async remove(id: string): Promise<ConnectorRefusal | undefined> {
		const saved = this.options.store.state().connectors[id];
		const spec = specOf(id, saved);
		if (!spec) return REFUSALS.unknown;
		if (!saved) return REFUSALS.notAdded;
		if (this.flow?.connectorId === id) this.cancel(this.flow);
		if (this.setupFlow?.connectorId === id) this.cancelSetup(this.setupFlow);
		await this.options.store.forget(id);
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
			this.askValues(owner, id, custom.fields, emit, (values, flowId) =>
				this.keepValues(
					id,
					values,
					emit,
					flowId,
					(current) => current,
					() => this.afterSetup(owner, id, emit, flowId),
				),
			);
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
	 * Copies the chosen servers, read only with every tool hidden: from `from` (a confirmed plan) when
	 * given, else from the last scan. Their header and environment values go to the app's secure
	 * store, with only references in the files.
	 */
	async importServers(
		ids: string[],
		from: ReadonlyMap<string, ScannedServer> = this.scanned,
	): Promise<string[]> {
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
		await this.options.store.settled();
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

	/**
	 * Stores the typed values (the secret ones in the app's store), then changes the connector with
	 * `update` and continues; without the app the window is told why and nothing changes.
	 */
	private keepValues(
		id: string,
		values: Record<string, string>,
		emit: Emit,
		flowId: string,
		update: (current: SavedConnector) => SavedConnector,
		then: () => void,
	): void {
		this.options.store.keepValues(id, values).then(
			() => {
				this.save(id, update);
				then();
			},
			(error: Error) => {
				this.log(`could not keep the values of connector ${id}: ${error.message}`);
				emit({
					type: "auth_done",
					flowId,
					providerId: id,
					ok: false,
					message:
						error instanceof SecretsUnavailableError ? error.message : "Could not save it. Please try again.",
				});
			},
		);
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

	private startLogin(owner: object, connectorId: string, emit: Emit, flowId?: string): void {
		const flow: Flow = {
			id: flowId ?? `connector-${randomUUID()}`,
			connectorId,
			owner,
			emit,
			cancelled: false,
		};
		this.flow = flow;
		this.failed.delete(connectorId);
		void this.runLogin(flow);
	}

	/** The sign-in, run here with pi-mcp's OAuth; the result goes to the app's secure store only. */
	private async runLogin(flow: Flow): Promise<void> {
		const { store, oauth } = this.options;
		const done = { type: "auth_done", flowId: flow.id, providerId: flow.connectorId } as const;
		try {
			const target = await store.signInTarget(flow.connectorId);
			if (flow.cancelled) throw new SignInCancelledError();
			flow.signIn = startSignIn({
				...target,
				...(oauth?.fetch ? { fetch: oauth.fetch } : {}),
				onAuthorizationUrl: (url) => this.onAuthorizationUrl(flow, url),
			});
			const state = await flow.signIn.done;
			await store.saveSignIn(flow.connectorId, state);
			this.log(`signed in to connector ${flow.connectorId}`);
			flow.emit({ ...done, ok: true });
		} catch (error) {
			if (flow.cancelled || error instanceof SignInCancelledError)
				flow.emit({ ...done, ok: false, message: "Sign-in cancelled." });
			else {
				this.failed.add(flow.connectorId);
				const detail = ((error as Error)?.message ?? String(error)).replace(/https?:\/\/\S+/g, "[address]");
				this.log(`sign-in to connector ${flow.connectorId} failed: ${detail.slice(0, 200)}`);
				flow.emit({
					...done,
					ok: false,
					message:
						error instanceof SecretsUnavailableError
							? error.message
							: "Sign-in did not finish. Please try again.",
				});
			}
		} finally {
			if (this.flow === flow) this.flow = undefined;
			this.onChanged(false);
		}
	}

	/** The page to approve access on goes to the window that started the sign-in. */
	private onAuthorizationUrl(flow: Flow, url: URL): void {
		if (flow.cancelled) return;
		const name =
			specOf(flow.connectorId, this.options.store.state().connectors[flow.connectorId])?.name ??
			flow.connectorId;
		flow.emit({
			type: "auth_event",
			flowId: flow.id,
			event: {
				kind: "auth_url",
				url: url.href,
				instructions: `Open the ${name} page and approve access. You can come back here when it says you are done.`,
			},
		});
		this.options.oauth?.openBrowser?.(url.href);
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
	 * elsewhere): the pasted address is that page's address. Only this sign-in's loopback address,
	 * with its `state`, is accepted; nothing is fetched.
	 */
	private finishWithPastedAddress(flow: Flow, pasted: string): void {
		if (!flow.signIn?.paste(pasted)) this.askForAddress(flow, true);
	}

	private cancel(flow: Flow): void {
		flow.cancelled = true;
		flow.signIn?.cancel();
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

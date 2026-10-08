import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorInfo, ConnectorMode, ServerPayload } from "@gentle-dot/protocol";
import { type ConnectorPolicy, POLICY_ENV } from "./extensions/approval-guard.ts";

/** A service in the catalog: an official remote MCP server with OAuth sign-in. */
export interface CatalogEntry {
	id: string;
	name: string;
	url: string;
	reads: string;
	sends: string;
	/**
	 * Tools that only read, by their MCP names. A tool also has to declare `readOnlyHint: true`;
	 * anything else needs the user's approval, and read-only mode hides it.
	 */
	readOnlyTools: readonly string[];
}

/** Official remote servers, checked against each provider's documentation on 2026-10-08. */
export const CATALOG: readonly CatalogEntry[] = [
	{
		id: "notion",
		name: "Notion",
		url: "https://mcp.notion.com/mcp",
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
		url: "https://mcp.linear.app/mcp",
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
		url: "https://mcp.atlassian.com/v2/mcp",
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
];

const catalogEntry = (id: string) => CATALOG.find((entry) => entry.id === id);

export interface ConnectorsState {
	connectors: Record<string, { enabled: boolean; mode: ConnectorMode }>;
}

/**
 * The engine's `mcp.json` for the added connectors. The assistant turns codemode off, so every
 * server is `direct`. Read only hides every tool (`*`) except the curated ones (exact names win
 * over patterns in the engine), so a tool the catalog does not know stays hidden.
 */
export function renderMcpJson(state: ConnectorsState): string {
	const servers: Record<string, unknown> = {};
	for (const entry of CATALOG) {
		const saved = state.connectors[entry.id];
		if (!saved) continue;
		servers[entry.id] = {
			url: entry.url,
			exposure: "direct",
			...(saved.mode === "read_only"
				? {
						toolExposure: {
							"*": "hidden",
							...Object.fromEntries(entry.readOnlyTools.map((tool) => [tool, "direct"])),
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
	/** The engine's home, which holds `mcp.json` and `mcp-auth.json`. */
	agentHome: string;
	/** The engine's working folder; a project `.pi/mcp.json` there would add servers. */
	workspace?: string;
	/** The approval guard's own file, protected like the connector files. */
	guardPath?: string;
	log?: (line: string) => void;
}

/**
 * The connectors the user approved. The daemon reads `<data>/connectors.json` once, when it
 * starts, and from then on the state lives in memory and changes only through the Connectors
 * screen. The files (`connectors.json`, the engine's `mcp.json`) are written from memory; a change
 * made by anything else (the assistant has a shell) is put back, and a project `.pi/mcp.json` in
 * the workspace is removed. Checked on every file event, before every engine start, and after
 * every run. A change made while the daemon is not running is loaded at its next start (stage 2, S25).
 */
export class ConnectorStore {
	readonly file: string;
	readonly mcpFile: string;
	readonly authFile: string;
	/** Called after a change made outside the Connectors screen was put back. */
	onReverted: () => void = () => {};
	private saved: ConnectorsState;
	private watchers: FSWatcher[] = [];
	private readonly options: ConnectorStoreOptions;

	constructor(options: ConnectorStoreOptions) {
		this.options = options;
		this.file = join(options.dataDir, "connectors.json");
		this.mcpFile = join(options.agentHome, "mcp.json");
		this.authFile = join(options.agentHome, "mcp-auth.json");
		this.saved = this.load();
	}

	get agentHome(): string {
		return this.options.agentHome;
	}

	state(): ConnectorsState {
		return structuredClone(this.saved);
	}

	/** Changes the state, then writes both files (each atomically, mode 0600). */
	update(change: (state: ConnectorsState) => void): void {
		const state = this.state();
		change(state);
		this.saved = state;
		mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
		writePrivate(this.file, this.recordText());
		writePrivate(this.mcpFile, renderMcpJson(state));
	}

	/**
	 * Puts back every connector file that differs from the approved state; true when one did.
	 * `report: false` only writes them (the daemon's start, where the files are what it just read).
	 */
	enforce(report = true): boolean {
		const untouched = Object.keys(this.saved.connectors).length === 0;
		const changed: string[] = [];
		for (const [file, text] of [
			[this.file, this.recordText()],
			[this.mcpFile, renderMcpJson(this.saved)],
		] as const) {
			const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
			if (current === text || (current === undefined && untouched)) continue;
			mkdirSync(this.options.agentHome, { recursive: true, mode: 0o700 });
			writePrivate(file, text);
			changed.push(file);
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

	/** What the approval guard enforces: the turned-on connectors and the files only the daemon writes. */
	policy(): ConnectorPolicy {
		const connectors: NonNullable<ConnectorPolicy["connectors"]> = {};
		for (const [id, saved] of Object.entries(this.state().connectors)) {
			const entry = catalogEntry(id);
			if (entry && saved.enabled)
				connectors[id] = { name: entry.name, mode: saved.mode, readOnlyTools: [...entry.readOnlyTools] };
		}
		return {
			connectors,
			// Sign-ins and keys, connector state, and the daemon's access key.
			protectedPaths: [
				this.mcpFile,
				this.authFile,
				join(this.options.agentHome, "auth.json"),
				join(this.options.agentHome, "models.json"),
				this.file,
				join(this.options.dataDir, "token"),
				...(this.options.guardPath ? [this.options.guardPath] : []),
			],
		};
	}

	/**
	 * True when the engine stored tokens for the connector (key `mcp__<id>|<url>`). Token values
	 * are dropped while parsing, so they are never kept or passed on.
	 */
	isSignedIn(id: string): boolean {
		const entry = catalogEntry(id);
		if (!entry || !existsSync(this.authFile)) return false;
		try {
			const states = JSON.parse(readFileSync(this.authFile, "utf8"), (key, value) =>
				key === "tokens" && typeof value === "object" && value !== null ? {} : value,
			) as Record<string, { tokens?: unknown } | undefined>;
			return typeof states[`mcp__${id}|${new URL(entry.url).href}`]?.tokens === "object";
		} catch {
			return false;
		}
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

	private load(): ConnectorsState {
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8")) as {
				connectors?: Record<string, { enabled?: unknown; mode?: unknown }>;
			};
			const connectors: ConnectorsState["connectors"] = {};
			for (const [id, value] of Object.entries(saved.connectors ?? {})) {
				if (!catalogEntry(id)) continue;
				connectors[id] = {
					enabled: value?.enabled === true,
					mode: value?.mode === "read_write" ? "read_write" : "read_only",
				};
			}
			return { connectors };
		} catch {
			return { connectors: {} };
		}
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

/** The command line of the engine bundled with the daemon (`pi-coding-agent`). */
export function bundledMcpCli(): McpCli {
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
	code: "connector_busy" | "unknown_connector" | "connector_not_added";
	message: string;
};

const REFUSALS = {
	busy: { code: "connector_busy", message: "Another sign-in is in progress. Finish or cancel it first." },
	unknown: { code: "unknown_connector", message: "That connector is not available." },
	notAdded: { code: "connector_not_added", message: "Connect that service first." },
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

const PASTE_PROMPT =
	"If the browser shows an error page after you approve, copy the full address from its address bar and paste it here.";

export interface ConnectorManagerOptions {
	store: ConnectorStore;
	cli: McpCli;
	/** The engine's environment (its own HOME, XDG folders, and memory settings). */
	env: NodeJS.ProcessEnv;
	cwd: string;
	log?: (line: string) => void;
}

/**
 * Connects, signs in, changes, and removes connectors. Sign-in runs the engine's own
 * `mcp login <server>` as a separate process (one at a time; its loopback callback port is
 * shared), relays the authorization URL, and can finish with an address the user pastes when
 * the browser could not reach this computer. Nothing typed or printed is logged.
 */
export class ConnectorManager {
	/** `restart`: the engine must restart (when idle) to read the new `mcp.json`. */
	onChanged: (restart: boolean) => void = () => {};
	/** A change to the connector files made outside the Connectors screen was put back. */
	onBlocked: () => void = () => {};
	private flow: Flow | undefined;
	private readonly failed = new Set<string>();
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
		return CATALOG.map((entry) => {
			const saved = connectors[entry.id];
			const status = !saved?.enabled
				? "off"
				: this.failed.has(entry.id)
					? "error"
					: this.options.store.isSignedIn(entry.id)
						? "connected"
						: "needs_signin";
			return {
				id: entry.id,
				name: entry.name,
				reads: entry.reads,
				sends: entry.sends,
				added: saved !== undefined,
				enabled: saved?.enabled === true,
				mode: saved?.mode ?? "read_only",
				status,
			};
		});
	}

	/** Adds or turns on a connector, then signs in when it has no sign-in yet. */
	connect(owner: object, id: string, emit: Emit): ConnectorRefusal | undefined {
		if (!catalogEntry(id)) return REFUSALS.unknown;
		if (this.flow) return REFUSALS.busy;
		this.options.store.update((state) => {
			state.connectors[id] = { enabled: true, mode: state.connectors[id]?.mode ?? "read_only" };
		});
		this.onChanged(true);
		if (!this.options.store.isSignedIn(id)) this.startLogin(owner, id, emit);
		// Already signed in: the window that asked is told it is done.
		else emit({ type: "auth_done", flowId: `connector-${randomUUID()}`, providerId: id, ok: true });
		return undefined;
	}

	signIn(owner: object, id: string, emit: Emit): ConnectorRefusal | undefined {
		if (!catalogEntry(id)) return REFUSALS.unknown;
		if (this.flow) return REFUSALS.busy;
		if (!this.options.store.state().connectors[id]) return REFUSALS.notAdded;
		this.startLogin(owner, id, emit);
		return undefined;
	}

	/** Answers the flow `owner` started: a pasted address, or a cancellation. */
	reply(owner: object, flowId: string, answer: { value?: string; cancelled?: boolean }): boolean {
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
		if (this.flow?.owner === owner) this.cancel(this.flow);
	}

	cancelAll(): void {
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
		if (!catalogEntry(id)) return REFUSALS.unknown;
		if (!this.options.store.state().connectors[id]) return REFUSALS.notAdded;
		if (this.flow?.connectorId === id) this.cancel(this.flow);
		const code = await new Promise<number | null>((done) => {
			const child = this.run("logout", id);
			child.on("error", () => done(-1));
			child.on("close", (exit) => done(exit));
		});
		if (code !== 0) this.log(`sign-out of connector ${id} failed (exit ${code})`);
		this.failed.delete(id);
		this.options.store.update((state) => {
			delete state.connectors[id];
		});
		this.onChanged(true);
		return undefined;
	}

	private change(
		id: string,
		update: (saved: ConnectorsState["connectors"][string]) => ConnectorsState["connectors"][string],
	): ConnectorRefusal | undefined {
		if (!catalogEntry(id)) return REFUSALS.unknown;
		const saved = this.options.store.state().connectors[id];
		if (!saved) return REFUSALS.notAdded;
		this.options.store.update((state) => {
			state.connectors[id] = update(saved);
		});
		this.onChanged(true);
		return undefined;
	}

	private run(subcommand: "login" | "logout", id: string): ChildProcess {
		const { cli, env, cwd } = this.options;
		return spawn(cli.command, [...cli.args, "mcp", subcommand, id], {
			cwd,
			env: { ...env, PI_CODING_AGENT_DIR: this.options.store.agentHome },
			stdio: ["ignore", "pipe", "pipe"],
		});
	}

	private startLogin(owner: object, connectorId: string, emit: Emit): void {
		const child = this.run("login", connectorId);
		const flow: Flow = {
			id: `connector-${randomUUID()}`,
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
		const name = catalogEntry(flow.connectorId)?.name ?? flow.connectorId;
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

/** The guard's policy for the engine's environment; the engine cannot change its own environment. */
export function policyEnv(store: ConnectorStore): NodeJS.ProcessEnv {
	return { [POLICY_ENV]: JSON.stringify(store.policy()) };
}

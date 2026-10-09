import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import type { McpTransport } from "@earendil-works/pi-mcp";
import {
	type AttachmentLimits,
	type ClientMessage,
	CloseCode,
	PROTOCOL_VERSION,
	parseClientMessage,
} from "@gentle-dot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { AppChannel } from "./app-channel.ts";
import { AuthManager, type AuthRuntime, createModelAuthRuntime, resolveAgentHome } from "./auth.ts";
import { type BridgeClient, DotBridge } from "./bridge.ts";
import {
	APPROVAL_GUARD,
	bundledMcpCli,
	ConnectorManager,
	ConnectorStore,
	type McpCli,
	policyEnv,
} from "./connectors.ts";
import { approvalRequest } from "./extensions/approval-guard.ts";
import { ensureMemoryProject, ensurePrivateDir, isolatedAgentEnv, privateMemory } from "./isolation.ts";
import { MCP_PREFIX, McpProxy, type ProxiedConnector, type UpstreamCredentials } from "./mcp-proxy.ts";
import { defaultImportPath, ProfileStore } from "./profiles.ts";
import { type RotationLimits, rotationLimits } from "./rotation.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { UploadStore } from "./uploads.ts";
import { VoiceService } from "./voice.ts";
import { identityArgs } from "./white-label.ts";

export interface DaemonOptions {
	port: number;
	host: string;
	dataDir: string;
	/** The engine's working folder, owned by the assistant; it names the memory project. */
	workspace: string;
	/** A folder the user prefers to work in; the engine is told about it but keeps its own workspace. */
	preferredFolder?: string;
	/** Directory with the built web UI (`index.html`). */
	uiDir: string;
	agentCommand: string;
	agentArgs?: string[];
	agentExtraArgs?: string[];
	agentEnv?: NodeJS.ProcessEnv;
	/** The assistant's own Gentle Shell home (`--home`); profiles go next to it. */
	agentHome?: string;
	/** Another setup's `profiles.json` offered for a one-time import; defaults to the user's Gentle Shell store. */
	profilesImportPath?: string;
	/** Creates the sign-in runtime; defaults to Pi's ModelRuntime on the agent home. */
	authRuntime?: () => Promise<AuthRuntime>;
	/** The fetch for voice requests to OpenAI; tests pass a fake one. */
	voiceFetch?: typeof fetch;
	/** The engine's command line for connector sign-in; default `GENTLE_DOT_MCP_CLI` (JSON array) or the bundled one. */
	connectorCli?: McpCli;
	/** The home folder "Import my MCP servers" reads other apps' configs from; default `GENTLE_DOT_IMPORT_HOME` or the user's. */
	importHome?: string;
	/** The connection the MCP proxy makes to a connector's real server; tests pass a stand-in. */
	connectorTransport?: (connector: ProxiedConnector, credentials: UpstreamCredentials) => McpTransport;
	/**
	 * The desktop app's end of its private channel (fd 3 when the app launched the daemon, S25.1).
	 * Without it, connector changes and approvals fail closed.
	 */
	appChannel?: Duplex;
	/** How long an approval waits for the app's answer; default 130 s (the app declines at 120 s). */
	approvalWaitMs?: number;
	/** Origins allowed to open the WebSocket, besides the daemon's own and the desktop app's. */
	allowedOrigins?: string[];
	backoffMs?: number[];
	/** Several conversations instead of one continuous chat; default `GENTLE_DOT_CONVERSATIONS=1`. */
	conversations?: boolean;
	/** When the chat's session is rotated; default from `GENTLE_DOT_ROTATE_BYTES` and `GENTLE_DOT_ROTATE_COMPACTIONS`. */
	rotation?: RotationLimits;
	/** Messages per history page; default `GENTLE_DOT_HISTORY_PAGE` or 100. */
	historyPage?: number;
	/** Upload limits; default 25 MB per file, 10 files and 50 MB per message (S31.3). */
	uploadLimits?: AttachmentLimits;
	log?: (line: string) => void;
}

export interface DotDaemon {
	port: number;
	token: string;
	url: string;
	bridge: DotBridge;
	supervisor: AgentSupervisor;
	close(): Promise<void>;
}

const HELLO_TIMEOUT_MS = 5000;
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};

/**
 * Reads the access token from `<dataDir>/token`, creating a random one when
 * absent. The data folder is kept at 0700 and the token at 0600.
 */
export function ensureToken(dataDir: string): string {
	ensurePrivateDir(dataDir);
	const file = join(dataDir, "token");
	if (existsSync(file)) {
		chmodSync(file, 0o600);
		const existing = readFileSync(file, "utf8").trim();
		if (existing.length >= 32) return existing;
	}
	const token = randomBytes(32).toString("base64url");
	writeFileSync(file, `${token}\n`, { mode: 0o600 });
	return token;
}

/**
 * The line printed at startup. The access key is shown only on an interactive
 * terminal; redirected output (a log file, `docker logs`) says where it is instead.
 */
export function startupMessage(url: string, dataDir: string, interactive: boolean): string {
	if (interactive) return `Gentle Dot is running at ${url}`;
	return `Gentle Dot is running at ${url.split("#")[0]} (the access key is in ${join(dataDir, "token")})`;
}

export async function startDaemon(options: DaemonOptions): Promise<DotDaemon> {
	const log = options.log ?? (() => {});
	const token = ensureToken(options.dataDir);
	mkdirSync(options.workspace, { recursive: true, mode: 0o700 });
	ensureMemoryProject(options.workspace);
	const folderArgs = options.preferredFolder
		? [
				"--append-system-prompt",
				`The user's preferred working folder is ${options.preferredFolder}. Use absolute paths there unless told otherwise.`,
			]
		: [];
	let agentEnv = { ...(options.agentEnv ?? process.env) };
	const homeArgs: string[] = [];
	const memory = options.agentHome ? await privateMemory(agentEnv, options.dataDir, log) : undefined;
	if (options.agentHome) {
		homeArgs.push("--home", options.agentHome);
		// The engine also writes under the home folder; it gets one of its own.
		agentEnv = isolatedAgentEnv(agentEnv, options.dataDir);
		agentEnv.GENTLE_PI_CONFIG_HOME = join(options.dataDir, "gentle-ai");
	}
	const agentHome = options.agentHome ?? resolveAgentHome(process.env, options.dataDir);
	// The approved connectors are read once, here; the engine cannot change them (docs/design.md).
	const connectorStore = new ConnectorStore({
		dataDir: options.dataDir,
		agentHome,
		workspace: options.workspace,
		guardPath: APPROVAL_GUARD,
		env: agentEnv,
		log,
	});
	// The engine reaches every connector through the proxy (S25.4); its key changes with every launch.
	let port = options.port;
	const proxy = new McpProxy({
		connector: (id) => connectorStore.proxyView(id),
		credentials: (id) => connectorStore.credentials(id),
		// In the desktop app's native dialog, outside the agent's reach (S25.3).
		approve: (preview, signal) =>
			bridge.askInApp(
				approvalRequest(preview.connector, preview.connectorId, preview.tool, preview.arguments),
				signal,
			),
		...(options.connectorTransport ? { transport: options.connectorTransport } : {}),
		env: agentEnv,
		cwd: options.workspace,
		log,
	});
	connectorStore.onUpdated = () => proxy.sync();
	// The assistant's own engine loads the approval guard for connector actions.
	const guardArgs = options.agentHome ? ["-e", APPROVAL_GUARD] : [];
	const supervisor = new AgentSupervisor({
		command: options.agentCommand,
		args: [...(options.agentArgs ?? []), ...homeArgs],
		extraArgs: [
			...identityArgs(options.dataDir),
			...folderArgs,
			...guardArgs,
			...(options.agentExtraArgs ?? []),
		],
		cwd: options.workspace,
		dataDir: options.dataDir,
		env: agentEnv,
		// mcp.json is read when a session starts: put back anything not approved, and hand the guard
		// its policy from the daemon's memory, never from the files.
		// The proxy's key changes with every launch (after the check, so a change is still reported).
		prepareSpawn: () => {
			connectors.enforce();
			connectorStore.setProxy({ url: `http://127.0.0.1:${port}/mcp`, key: proxy.rotateKey() });
			return policyEnv(connectorStore);
		},
		// The first start in a new home installs the engine's companion packages.
		...(options.agentHome ? { startTimeoutMs: 180_000 } : {}),
		...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
		log: (line) => log(`[agent] ${line}`),
	});
	const auth = new AuthManager({
		runtime: options.authRuntime ?? (() => createModelAuthRuntime(agentHome, options.workspace)),
		log,
	});
	const profiles = new ProfileStore({
		configHome: join(options.dataDir, "gentle-ai"),
		agentHome,
		importPath: options.profilesImportPath ?? defaultImportPath(process.env),
	});
	const connectors = new ConnectorManager({
		store: connectorStore,
		cli: options.connectorCli ?? mcpCliFromEnv(process.env) ?? bundledMcpCli(),
		env: { ...agentEnv },
		cwd: options.workspace,
		...((options.importHome ?? process.env.GENTLE_DOT_IMPORT_HOME)
			? { importHome: options.importHome ?? process.env.GENTLE_DOT_IMPORT_HOME }
			: {}),
		log,
	});
	const voice = new VoiceService({
		apiKey: () => auth.openAIApiKey(),
		...(options.voiceFetch ? { fetch: options.voiceFetch } : {}),
		log,
	});
	const uploads = new UploadStore({
		workspace: options.workspace,
		...(options.uploadLimits ? { limits: options.uploadLimits } : {}),
	});
	const historyPage = options.historyPage ?? Number(process.env.GENTLE_DOT_HISTORY_PAGE);
	const app = options.appChannel
		? new AppChannel(options.appChannel, {
				log,
				...(options.approvalWaitMs ? { approvalWaitMs: options.approvalWaitMs } : {}),
			})
		: undefined;
	const bridge = new DotBridge(supervisor, {
		dataDir: options.dataDir,
		log,
		auth,
		profiles,
		connectors,
		voice,
		uploads,
		...(app ? { app } : {}),
		features: { conversations: options.conversations ?? process.env.GENTLE_DOT_CONVERSATIONS === "1" },
		rotation: options.rotation ?? rotationLimits(process.env),
		...(Number.isInteger(historyPage) && historyPage > 0 ? { historyPage } : {}),
	});

	if (app) {
		app.handler = (method, params) => appRequest(method, params, bridge, connectors, app);
		// The computer helper belongs to the app that registered it (S24.7).
		app.onClose(() => {
			log("the desktop app's channel closed");
			connectors.unregisterComputer(app);
		});
	} else log("no desktop app channel: connector changes and approvals are refused");

	// The files as the daemon writes them (an older version kept a hash), then watched.
	connectorStore.enforce(false);
	connectorStore.watch();

	const server = createServer((req, res) => {
		const { pathname } = new URL(req.url ?? "/", "http://localhost");
		if (pathname === "/upload") {
			void handleUpload(req, res, token, allowedOrigins(port, options), uploads);
			return;
		}
		if (pathname.startsWith(MCP_PREFIX)) {
			proxy.handle(req, res);
			return;
		}
		handleHttp(req, res, options.uiDir, bridge);
	});
	const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

	server.on("upgrade", (req, socket, head) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const origin = req.headers.origin;
		if (url.pathname !== "/ws" || (origin !== undefined && !allowedOrigins(port, options).has(origin))) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		wss.handleUpgrade(req, socket, head, (ws) => acceptClient(ws, token, bridge));
	});

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port, options.host, () => done());
	});
	port = (server.address() as AddressInfo).port;

	await supervisor.start().catch((error: Error) => log(`agent failed to start: ${error.message}; retrying`));

	return {
		port,
		token,
		url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}/#token=${token}`,
		bridge,
		supervisor,
		async close() {
			app?.close();
			for (const client of wss.clients) client.terminate();
			wss.close();
			// Stops waiting approvals and the connectors' servers (stdio ones are processes of the daemon).
			await proxy.close();
			await new Promise<void>((done) => server.close(() => done()));
			await supervisor.stop();
			connectorStore.close();
			await memory?.stop();
		},
	};
}

/** What the desktop app asks over its channel: a window's connector change, or its computer helper. */
async function appRequest(
	method: string,
	params: unknown,
	bridge: DotBridge,
	connectors: ConnectorManager,
	app: AppChannel,
): Promise<object> {
	const fields = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
	switch (method) {
		case "command":
			await bridge.handleFromApp(String(fields.clientId ?? ""), fields.message);
			return {};
		case "computer_register": {
			const parsed = parseClientMessage(JSON.stringify({ ...fields, type: "computer_register" }));
			if (parsed?.type !== "computer_register") throw new Error("That is not the computer helper's address.");
			connectors.registerComputer(app, { url: parsed.url, token: parsed.token });
			return {};
		}
		case "computer_unregister":
			connectors.unregisterComputer(app);
			return {};
		default:
			throw new Error(`Unknown request: ${method}`);
	}
}

function mcpCliFromEnv(env: NodeJS.ProcessEnv): McpCli | undefined {
	if (!env.GENTLE_DOT_MCP_CLI) return undefined;
	const [command, ...args] = JSON.parse(env.GENTLE_DOT_MCP_CLI) as string[];
	return command ? { command, args } : undefined;
}

function allowedOrigins(port: number, options: DaemonOptions): Set<string> {
	return new Set([
		`http://127.0.0.1:${port}`,
		`http://localhost:${port}`,
		"tauri://localhost",
		"http://tauri.localhost",
		...(options.allowedOrigins ?? []),
	]);
}

function acceptClient(ws: WebSocket, token: string, bridge: DotBridge): void {
	let seq = 0;
	let detach: (() => void) | undefined;
	const client: BridgeClient = {
		send(payload) {
			if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ ...payload, seq: ++seq }));
		},
	};
	const helloTimer = setTimeout(() => ws.close(CloseCode.unauthorized, "hello required"), HELLO_TIMEOUT_MS);

	ws.on("message", (data) => {
		const message = parseClientMessage(String(data));
		if (!detach) {
			clearTimeout(helloTimer);
			if (message?.type !== "hello" || !sameToken(message.token, token)) {
				ws.close(CloseCode.unauthorized, "unauthorized");
				return;
			}
			if (message.protocol !== PROTOCOL_VERSION) {
				ws.close(CloseCode.badProtocol, "unsupported protocol");
				return;
			}
			detach = bridge.attach(client);
			return;
		}
		if (!message) {
			client.send({
				type: "error",
				code: "bad_message",
				message: "The app sent a message the assistant did not understand.",
			});
			return;
		}
		void bridge.handle(client, message as ClientMessage);
	});
	ws.on("close", () => {
		clearTimeout(helloTimer);
		detach?.();
	});
}

function sameToken(given: string, expected: string): boolean {
	const a = Buffer.from(given);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `POST /upload` (S31.2): one file per request, the raw bytes as the body, its name in
 * `X-File-Name` (URI-encoded), and `X-Upload-Id` to add it to the message folder of an earlier
 * file. The same access key and Origin rules as the WebSocket: the key only in
 * `Authorization: Bearer`, never in the address.
 */
async function handleUpload(
	req: IncomingMessage,
	res: ServerResponse,
	token: string,
	origins: Set<string>,
	uploads: UploadStore,
): Promise<void> {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	const refuse = (status: number, code: string, message: string) => {
		// The rest of the body is discarded, never stored.
		res.setHeader("Connection", "close");
		reply(res, status, { code, message });
		req.resume();
	};
	const origin = req.headers.origin;
	if (origin !== undefined && !origins.has(origin))
		return refuse(403, "forbidden", "This page may not upload.");
	if (origin !== undefined) {
		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Vary", "Origin");
	}
	if (req.method === "OPTIONS") {
		res.writeHead(204, {
			"Access-Control-Allow-Methods": "POST",
			"Access-Control-Allow-Headers": "Authorization, Content-Type, X-File-Name, X-Upload-Id",
			"Access-Control-Max-Age": "600",
		});
		res.end();
		return;
	}
	if (req.method !== "POST") return refuse(405, "method_not_allowed", "Upload files with POST.");
	const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1];
	if (!bearer || !sameToken(bearer, token))
		return refuse(401, "unauthorized", "The access key is not valid.");
	let name: string;
	try {
		name = decodeURIComponent(String(req.headers["x-file-name"] ?? ""));
	} catch {
		name = "";
	}
	if (name.trim() === "") return refuse(400, "bad_request", "The file has no name.");
	const uploadId = req.headers["x-upload-id"];
	if (uploadId !== undefined && (typeof uploadId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(uploadId))) {
		return refuse(400, "bad_request", "That upload is not valid.");
	}
	const declared = Number(req.headers["content-length"]);
	const outcome = await uploads.receive(req, {
		name,
		...(uploadId ? { uploadId } : {}),
		...(Number.isFinite(declared) && req.headers["content-length"] !== undefined ? { length: declared } : {}),
	});
	if (!outcome.ok) return refuse(outcome.status, outcome.code, outcome.message);
	reply(res, 200, outcome.file);
}

function reply(res: ServerResponse, status: number, body: object): void {
	if (res.headersSent || res.destroyed) return;
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

function handleHttp(req: IncomingMessage, res: ServerResponse, uiDir: string, bridge: DotBridge): void {
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405).end();
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname === "/health") {
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: true, agentState: bridge.agentState }));
		return;
	}
	let pathname: string;
	try {
		pathname = decodeURIComponent(url.pathname);
	} catch {
		res.writeHead(400).end();
		return;
	}
	const root = resolve(uiDir);
	const target = resolve(root, `.${pathname}`);
	if (target !== root && !target.startsWith(root + sep)) {
		res.writeHead(403).end();
		return;
	}
	const file = existsSync(target) && statSync(target).isFile() ? target : join(root, "index.html");
	if (!existsSync(file)) {
		res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
		res.end("The interface is not built yet. Run `pnpm build`.");
		return;
	}
	const isIndex = file.endsWith("index.html");
	res.writeHead(200, {
		"Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
		"Cache-Control": isIndex ? "no-store" : "public, max-age=3600",
	});
	res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}

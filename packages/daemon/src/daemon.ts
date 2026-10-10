import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
import { AuthHelper } from "./auth-helper.ts";
import { type BridgeClient, DotBridge } from "./bridge.ts";
import {
	APPROVAL_GUARD,
	ConnectorManager,
	type ConnectorOAuthOptions,
	ConnectorStore,
	policyEnv,
} from "./connectors.ts";
import { directAccess, type EngineAccess, engineAccess } from "./engine-access.ts";
import { approvalRequest } from "./extensions/approval-guard.ts";
import {
	claimEngineHome,
	ensureMemoryProject,
	ensurePrivateDir,
	isolatedAgentEnv,
	privateMemory,
} from "./isolation.ts";
import { MCP_PREFIX, McpProxy, type ProxiedConnector, type UpstreamCredentials } from "./mcp-proxy.ts";
import { writePrivateFile } from "./private-file.ts";
import { defaultImportPath, ProfileStore } from "./profiles.ts";
import { type RotationLimits, rotationLimits } from "./rotation.ts";
import { FileSecretSource, SECRETS_FILE, SECRETS_KEY_VAR } from "./secret-file.ts";
import { AppSecretSource } from "./secret-source.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { UploadStore } from "./uploads.ts";
import { VoiceService } from "./voice.ts";
import { CONNECTOR_HOME, chownHandOver, prepareVpsLayout, type VpsOptions } from "./vps.ts";
import { PIN_FILE, PinGate } from "./web-pin.ts";
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
	/** How connector sign-ins reach the provider and the browser; tests pass stand-ins. */
	connectorOAuth?: ConnectorOAuthOptions;
	/** The home folder "Import my MCP servers" reads other apps' configs from; default `GENTLE_DOT_IMPORT_HOME` or the user's. */
	importHome?: string;
	/** The connection the MCP proxy makes to a connector's real server; tests pass a stand-in. */
	connectorTransport?: (connector: ProxiedConnector, credentials: UpstreamCredentials) => McpTransport;
	/**
	 * The desktop app's end of its private channel (fd 3 when the app launched the daemon, S25.1).
	 * Without it, connector changes and approvals fail closed. With it, the daemon stops when the
	 * channel closes (S35.2): the app that launched it is gone.
	 */
	appChannel?: Duplex;
	/** How long an approval waits for the app's answer; default 130 s (the app declines at 120 s). */
	approvalWaitMs?: number;
	/**
	 * Server mode (S25.8, `GENTLE_DOT_VPS`): the engine runs as another user, connector secrets are
	 * encrypted in a daemon file, and without the app the web page uses a PIN for privileged actions.
	 */
	vps?: VpsOptions;
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
	/** Stops the daemon; calling it again returns the same stop. */
	close(): Promise<void>;
	/** Settles once the daemon stopped, whether `close` was called or the app's channel closed. */
	closed: Promise<void>;
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
 * absent. The data folder is kept at 0700 (0711 in server mode, so the engine reaches its own folders by name) and the token at 0600.
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
	writePrivateFile(file, `${token}\n`);
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
	const vps = options.vps;
	// Server mode (S25.8): the daemon's files stay its own, the engine's folders become the engine's,
	// and from here on the daemon reaches them only as the engine's user (B1, engine-access.ts).
	if (vps) prepareVpsLayout(options.dataDir, vps.handOver ?? chownHandOver(vps.engine, log), vps.connector);
	const access: EngineAccess = vps ? (vps.access ?? engineAccess(vps.engine)) : directAccess;
	// Before anything is written there: the engine skips its first-run setup in a home it did not
	// create (S35.3). Only the assistant's default home; a home the user chose is never marked.
	if (options.agentHome && resolve(options.agentHome) === resolve(options.dataDir, "agent"))
		claimEngineHome(options.agentHome, log, access);
	access(() => mkdirSync(options.workspace, { recursive: true, mode: 0o700 }));
	ensureMemoryProject(options.workspace, access);
	const folderArgs = options.preferredFolder
		? [
				"--append-system-prompt",
				`The user's preferred working folder is ${options.preferredFolder}. Use absolute paths there unless told otherwise.`,
			]
		: [];
	let agentEnv = { ...(options.agentEnv ?? process.env) };
	// The server's secrets key is the daemon's only, whatever the engine is (S25.8).
	delete agentEnv[SECRETS_KEY_VAR];
	const homeArgs: string[] = [];
	const memory = options.agentHome ? await privateMemory(agentEnv, options.dataDir, log, access) : undefined;
	if (options.agentHome) {
		homeArgs.push("--home", options.agentHome);
		// The engine also writes under the home folder; it gets one of its own.
		agentEnv = isolatedAgentEnv(agentEnv, options.dataDir, access);
		agentEnv.GENTLE_PI_CONFIG_HOME = join(options.dataDir, "gentle-ai");
	}
	const agentHome = options.agentHome ?? resolveAgentHome(process.env, options.dataDir);
	const app = options.appChannel
		? new AppChannel(options.appChannel, {
				log,
				...(options.approvalWaitMs ? { approvalWaitMs: options.approvalWaitMs } : {}),
			})
		: undefined;
	// The approved connectors are read once, here; the engine cannot change them (docs/design.md).
	// Their secrets come from the app's secure store over its channel, and only into memory (S25.5).
	const connectorStore = new ConnectorStore({
		dataDir: options.dataDir,
		agentHome,
		workspace: options.workspace,
		guardPath: APPROVAL_GUARD,
		// The assistant's own engine: its subagents load the guard from its extensions folder (S25.4).
		...(options.agentHome ? { childGuard: true } : {}),
		...(vps ? { engineAccess: access } : {}),
		env: agentEnv,
		// On a server without the app, an encrypted file with a key from the daemon's environment (S25.8).
		secrets:
			vps && !app
				? new FileSecretSource({
						file: join(options.dataDir, SECRETS_FILE),
						key: vps.secretsKey,
						...(vps.secretsKeyProblem ? { problem: vps.secretsKeyProblem } : {}),
					})
				: new AppSecretSource(app),
		log,
	});
	// The engine reaches every connector through the proxy (S25.4); its key changes with every launch.
	let port = options.port;
	const proxy = new McpProxy({
		connector: (id) => connectorStore.proxyView(id),
		prepare: (id) => connectorStore.prepare(id),
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
		...(vps?.connector
			? { stdio: { user: vps.connector, home: join(options.dataDir, CONNECTOR_HOME) } }
			: {}),
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
		...(vps ? { user: vps.engine } : {}),
		// mcp.json is read when a session starts: put back anything not approved, and hand the guard
		// its policy from the daemon's memory, never from the files.
		// The proxy's key changes with every launch (after the check, so a change is still reported).
		// Subagents start only with the guard in place for them; otherwise this launch has none.
		prepareSpawn: () => {
			connectors.enforce();
			connectorStore.setProxy({ url: `http://127.0.0.1:${port}/mcp`, key: proxy.rotateKey() });
			const env = policyEnv(connectorStore);
			if (options.agentHome && agentEnv.GENTLE_PI_AGENTS !== "0" && !connectorStore.childGuardReady()) {
				log("subagents are off for this engine start: their approval guard is not in place");
				env.GENTLE_PI_AGENTS = "0";
			}
			return env;
		},
		// The first start in a new home installs the engine's companion packages.
		...(options.agentHome ? { startTimeoutMs: 180_000 } : {}),
		...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
		log: (line) => log(`[agent] ${line}`),
	});
	// In server mode Pi's ModelRuntime runs in a helper as the engine's user, never as root (B1).
	const authHelper =
		vps?.authHelper && !options.authRuntime
			? new AuthHelper({
					...vps.authHelper,
					user: vps.engine,
					env: agentEnv,
					agentHome,
					cwd: options.workspace,
					log,
				})
			: undefined;
	const auth = new AuthManager({
		runtime:
			options.authRuntime ??
			(authHelper
				? () => authHelper.runtime()
				: vps
					? () => Promise.reject(new Error("sign-in has no helper on this server"))
					: () => createModelAuthRuntime(agentHome, options.workspace)),
		log,
	});
	const profiles = new ProfileStore({
		configHome: join(options.dataDir, "gentle-ai"),
		agentHome,
		importPath: options.profilesImportPath ?? defaultImportPath(process.env),
		...(vps ? { access } : {}),
	});
	const connectors = new ConnectorManager({
		store: connectorStore,
		...(options.connectorOAuth ? { oauth: options.connectorOAuth } : {}),
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
		...(vps ? { access } : {}),
		...(options.uploadLimits ? { limits: options.uploadLimits } : {}),
	});
	const historyPage = options.historyPage ?? Number(process.env.GENTLE_DOT_HISTORY_PAGE);
	const bridge = new DotBridge(supervisor, {
		dataDir: options.dataDir,
		log,
		auth,
		profiles,
		connectors,
		voice,
		uploads,
		...(app ? { app } : {}),
		...(vps && !app ? { pin: new PinGate({ file: join(options.dataDir, PIN_FILE) }) } : {}),
		...(options.approvalWaitMs ? { approvalWaitMs: options.approvalWaitMs } : {}),
		...(vps ? { engineAccess: access } : {}),
		features: { conversations: options.conversations ?? process.env.GENTLE_DOT_CONVERSATIONS === "1" },
		rotation: options.rotation ?? rotationLimits(process.env),
		...(Number.isInteger(historyPage) && historyPage > 0 ? { historyPage } : {}),
	});

	// connectors.json as read at start is checked against its signature before anything rewrites it,
	// watches it, or starts the engine (S25.6).
	const integrity = connectorStore
		.checkIntegrity()
		.catch((error: Error) => log(`could not check connectors.json: ${error.message}`));
	if (app) {
		// Nothing the app asks changes connectors before connectors.json was checked (S25.6).
		app.handler = async (method, params) => {
			await integrity;
			return appRequest(method, params, bridge, connectors, app);
		};
		// The computer helper belongs to the app that registered it (S24.7).
		app.onClose(() => {
			log("the desktop app's channel closed");
			connectors.unregisterComputer(app);
			// Secrets read from the app are forgotten; connectors that need one fail closed until it is back.
			connectorStore.lock();
		});
	} else if (vps)
		log(
			`server mode: the engine runs as uid ${vps.engine.uid}; connector changes and approvals need the web PIN${vps.secretsKey ? "" : `; ${vps.secretsKeyProblem ?? "connector secrets are off"}`}`,
		);
	else
		log(
			"no desktop app channel: connector changes and approvals are refused, and connectors that need a secret fail closed; to use them, stop this assistant and open the Gentle Dot app, which starts its own",
		);

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

	let stopped = () => {};
	const closed = new Promise<void>((done) => {
		stopped = done;
	});
	const shutdown = async () => {
		// Not listening any more first, so an app relaunched meanwhile starts a daemon of its own.
		const serverClosed = new Promise<void>((done) => server.close(() => done()));
		app?.close();
		for (const client of wss.clients) client.terminate();
		wss.close();
		// Stops waiting approvals and the connectors' servers (stdio ones are processes of the daemon).
		await proxy.close();
		await serverClosed;
		await supervisor.stop();
		connectorStore.close();
		authHelper?.close();
		await memory?.stop();
	};
	let stopping: Promise<void> | undefined;
	const close = (): Promise<void> => {
		if (!stopping) {
			stopping = shutdown();
			stopping.then(stopped, (error: Error) => {
				log(`the assistant did not stop cleanly: ${error.message}`);
				stopped();
			});
		}
		return stopping;
	};
	// The daemon lives as long as the app that launched it (S35.2): a daemon left behind with no
	// channel would keep connectors locked, and a relaunched app could not get a channel to it.
	app?.onClose(() => {
		log("the desktop app's channel closed; stopping the assistant");
		void close().catch(() => {});
	});

	// Listening first keeps the app's health check answered while its store is asked for the key.
	await integrity;
	// Secrets that files still hold move into the app's store, once; on a server, into its encrypted file.
	if (app?.connected || (vps && !app && vps.secretsKey))
		void connectorStore
			.migrate()
			.catch((error: Error) => log(`connector secrets were not moved: ${error.message}`));
	// The files as the daemon writes them (an older version kept a hash), then watched.
	if (!stopping) {
		connectorStore.enforce(false);
		connectorStore.watch();
		await supervisor
			.start()
			.catch((error: Error) => log(`agent failed to start: ${error.message}; retrying`));
	}

	return {
		port,
		token,
		url: `http://${options.host === "0.0.0.0" ? "127.0.0.1" : options.host}:${port}/#token=${token}`,
		bridge,
		supervisor,
		close,
		closed,
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

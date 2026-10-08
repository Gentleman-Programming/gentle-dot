import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { type ClientMessage, CloseCode, PROTOCOL_VERSION, parseClientMessage } from "@gentle-dot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { AuthManager, type AuthRuntime, createModelAuthRuntime, resolveAgentHome } from "./auth.ts";
import { type BridgeClient, DotBridge } from "./bridge.ts";
import { defaultImportPath, ProfileStore } from "./profiles.ts";
import { AgentSupervisor } from "./supervisor.ts";
import { identityArgs } from "./white-label.ts";

export interface DaemonOptions {
	port: number;
	host: string;
	dataDir: string;
	workspace: string;
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
	/** Origins allowed to open the WebSocket, besides the daemon's own and the desktop app's. */
	allowedOrigins?: string[];
	backoffMs?: number[];
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

/** Reads the access token from `<dataDir>/token`, creating a random one (mode 0600) when absent. */
export function ensureToken(dataDir: string): string {
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const file = join(dataDir, "token");
	if (existsSync(file)) {
		const existing = readFileSync(file, "utf8").trim();
		if (existing.length >= 32) return existing;
	}
	const token = randomBytes(32).toString("base64url");
	writeFileSync(file, `${token}\n`, { mode: 0o600 });
	return token;
}

export async function startDaemon(options: DaemonOptions): Promise<DotDaemon> {
	const log = options.log ?? (() => {});
	const token = ensureToken(options.dataDir);
	const agentEnv = { ...(options.agentEnv ?? process.env) };
	const homeArgs: string[] = [];
	if (options.agentHome) {
		homeArgs.push("--home", options.agentHome);
		agentEnv.GENTLE_PI_CONFIG_HOME = join(options.dataDir, "gentle-ai");
	}
	const supervisor = new AgentSupervisor({
		command: options.agentCommand,
		args: [...(options.agentArgs ?? []), ...homeArgs],
		extraArgs: [...identityArgs(options.dataDir), ...(options.agentExtraArgs ?? [])],
		cwd: options.workspace,
		dataDir: options.dataDir,
		env: agentEnv,
		// The first start in a new home installs the engine's companion packages.
		...(options.agentHome ? { startTimeoutMs: 180_000 } : {}),
		...(options.backoffMs ? { backoffMs: options.backoffMs } : {}),
		log: (line) => log(`[agent] ${line}`),
	});
	const agentHome = options.agentHome ?? resolveAgentHome(process.env, options.dataDir);
	const auth = new AuthManager({
		runtime: options.authRuntime ?? (() => createModelAuthRuntime(agentHome, options.workspace)),
		log,
	});
	const profiles = new ProfileStore({
		configHome: join(options.dataDir, "gentle-ai"),
		agentHome,
		importPath: options.profilesImportPath ?? defaultImportPath(process.env),
	});
	const bridge = new DotBridge(supervisor, { dataDir: options.dataDir, log, auth, profiles });

	const server = createServer((req, res) => handleHttp(req, res, options.uiDir, bridge));
	const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
	let port = options.port;

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
			for (const client of wss.clients) client.terminate();
			wss.close();
			await new Promise<void>((done) => server.close(() => done()));
			await supervisor.stop();
		},
	};
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

import { readFileSync } from "node:fs";
import WebSocket from "ws";
import { type ClientMessage, CloseCode, PROTOCOL_VERSION, type ServerMessage } from "./protocol.ts";

export interface DaemonClientOptions {
	/** The daemon's WebSocket address, for example `ws://127.0.0.1:4317/ws`. */
	url: string;
	/** File holding the access key; read again before every connection. */
	tokenFile: string;
	onMessage(message: ServerMessage): void;
	/** Called once when retrying cannot help (wrong key, other protocol, no key file); the client stops. */
	onFatal(reason: string): void;
	/** Connected after `hello`, or disconnected. */
	onConnection?(connected: boolean): void;
	log?(message: string): void;
	/** Milliseconds to wait before reconnect attempt `attempt` (1-based). */
	delay?(attempt: number): number;
}

/** 1 s, doubling, at most 30 s. */
export function reconnectDelay(attempt: number): number {
	return Math.min(1000 * 2 ** (attempt - 1), 30_000);
}

/** One connection to the Gentle Dot daemon that comes back on its own when it drops. */
export class DaemonClient {
	private readonly options: DaemonClientOptions;
	private socket: WebSocket | undefined;
	private timer: NodeJS.Timeout | undefined;
	private attempt = 0;
	private stopped = false;
	/** The daemon answered at least once, so a missing key file is a restart, not a wrong setup. */
	private answered = false;

	constructor(options: DaemonClientOptions) {
		this.options = options;
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
		this.socket?.terminate();
		this.socket = undefined;
	}

	/** Sends a message; false when there is no open connection. */
	send(message: ClientMessage): boolean {
		if (this.socket?.readyState !== WebSocket.OPEN) return false;
		this.socket.send(JSON.stringify(message));
		return true;
	}

	get connected(): boolean {
		return this.socket?.readyState === WebSocket.OPEN;
	}

	private connect(): void {
		if (this.stopped) return;
		let token: string;
		try {
			token = readFileSync(this.options.tokenFile, "utf8").trim();
		} catch {
			if (this.answered) {
				this.options.log?.(`the access key at ${this.options.tokenFile} is missing; retrying`);
				this.retry();
			} else this.fatal(`Cannot read the Gentle Dot access key at ${this.options.tokenFile}. Is Gentle Dot installed?`);
			return;
		}
		const socket = new WebSocket(this.options.url);
		this.socket = socket;
		socket.on("open", () => {
			socket.send(JSON.stringify({ type: "hello", token, protocol: PROTOCOL_VERSION }));
			this.options.onConnection?.(true);
		});
		socket.on("message", (data) => {
			let value: unknown;
			try {
				value = JSON.parse(String(data));
			} catch {
				return;
			}
			if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") {
				// Only an answer proves the hello was accepted; until then the delay keeps growing.
				this.attempt = 0;
				this.answered = true;
				this.options.onMessage(value as ServerMessage);
			}
		});
		// Without a listener an unreachable daemon would throw; "close" follows and retries.
		socket.on("error", () => {});
		socket.on("close", (code) => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.options.onConnection?.(false);
			if (code === CloseCode.unauthorized) {
				this.fatal("The daemon refused the access key. Check GENTLE_DOT_TOKEN_FILE.");
			} else if (code === CloseCode.badProtocol) {
				this.fatal("The daemon speaks another protocol version; update dot-telegram.");
			} else {
				this.retry();
			}
		});
	}

	private retry(): void {
		if (this.stopped) return;
		this.attempt += 1;
		const wait = (this.options.delay ?? reconnectDelay)(this.attempt);
		this.timer = setTimeout(() => this.connect(), wait);
	}

	private fatal(reason: string): void {
		if (this.stopped) return;
		this.stopped = true;
		this.options.onFatal(reason);
	}
}

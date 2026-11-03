import { WebSocket } from "ws";
import { EventEmitter } from "events";
import type { ClientMessage, ServerMessage, CloseCode } from "./protocol.js";

const HEARTBEAT_MS = 30_000;
const RECONNECT_DELAY = 5_000;

export interface DaemonClientOptions {
	url: string;
	tokenFile: string;
	log(message: string): void;
	onMessage(message: ServerMessage): void;
	onConnection(connected: boolean): void;
	onFatal(reason: string): void;
}

/** Connects to the Gentle Dot daemon over WebSocket and keeps the connection alive. */
export class DaemonClient extends EventEmitter {
	private readonly options: DaemonClientOptions;
	private ws: WebSocket | null = null;
	private readonly tokenFile: string;
	private seq = 0;
	private heartbeatInterval: NodeJS.Timeout | null = null;
	private reconnectTimeout: NodeJS.Timeout | null = null;
	private connecting = false;

	constructor(options: DaemonClientOptions) {
		super();
		this.options = options;
		this.tokenFile = options.tokenFile;
	}

	private async readToken(): Promise<string> {
		const { readFile } = await import("node:fs/promises");
		return readFile(this.tokenFile, "utf8").then((t) => t.trim());
	}

	async start(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;

		const token = await this.readToken();
		const wsUrl = `${this.options.url}?token=${encodeURIComponent(token)}`;

		return new Promise((resolve, reject) => {
			this.ws = new WebSocket(wsUrl);

			this.ws.on("open", () => {
				this.connecting = false;
				this.options.onConnection(true);
				this.startHeartbeat();
				resolve();
			});

			this.ws.on("message", (data: Buffer) => {
				try {
					const message = JSON.parse(data.toString()) as ServerMessage;
					this.options.onMessage(message);
				} catch (error) {
					this.options.log(`failed to parse daemon message: ${(error as Error).message}`);
				}
			});

			this.ws.on("close", (code) => {
				this.options.onConnection(false);
				this.stopHeartbeat();
				if (code === CloseCode.unauthorized) {
					this.options.onFatal("Daemon rejected our token; is it stale?");
					return;
				}
				this.scheduleReconnect();
			});

			this.ws.on("error", (error) => {
				this.options.log(`WebSocket error: ${error.message}`);
				if (this.connecting) reject(error);
			});
		});
	}

	async stop(): Promise<void> {
		if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
		this.stopHeartbeat();
		if (this.ws) this.ws.close();
	}

	send(message: ClientMessage): boolean {
		if (this.ws?.readyState !== WebSocket.OPEN) return false;
		this.ws.send(JSON.stringify({ ...message, seq: ++this.seq, timestamp: Date.now() }));
		return true;
	}

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "ping" });
		}, HEARTBEAT_MS);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
	}

	private scheduleReconnect(): void {
		if (this.reconnectTimeout) return;
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.start().catch((error) => this.options.log(`reconnect failed: ${error.message}`));
		}, RECONNECT_DELAY);
	}
}
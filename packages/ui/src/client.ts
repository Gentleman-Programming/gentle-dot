import { type ClientMessage, CloseCode, PROTOCOL_VERSION, type ServerMessage } from "@gentle-dot/protocol";
import type { ConnectionStatus } from "./store.ts";

export interface ConnectionInfo {
	url: string;
	token: string;
	webUrl?: string;
}

interface ClientHandlers {
	onStatus: (status: ConnectionStatus) => void;
	onMessage: (message: ServerMessage) => void;
	WebSocketImpl?: typeof WebSocket;
}

const BACKOFF_MS = [500, 1000, 2000, 5000];
const TOKEN_KEY = "gentle-dot-token";

/** One WebSocket session with the daemon: hello, reconnect with backoff, and history refresh. */
export class DotClient {
	private socket: WebSocket | undefined;
	private ready = false;
	private stopped = false;
	private attempts = 0;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly info: ConnectionInfo;
	private readonly handlers: ClientHandlers;

	constructor(info: ConnectionInfo, handlers: ClientHandlers) {
		this.info = info;
		this.handlers = handlers;
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		clearTimeout(this.retryTimer);
		this.socket?.close();
	}

	send(message: ClientMessage): boolean {
		if (!this.ready || !this.socket || this.socket.readyState !== 1) return false;
		this.socket.send(JSON.stringify(message));
		return true;
	}

	private connect(): void {
		const Impl = this.handlers.WebSocketImpl ?? WebSocket;
		const socket = new Impl(this.info.url);
		this.socket = socket;
		this.ready = false;
		this.handlers.onStatus("connecting");
		socket.onopen = () => {
			socket.send(JSON.stringify({ type: "hello", token: this.info.token, protocol: PROTOCOL_VERSION }));
		};
		socket.onmessage = (event: MessageEvent) => {
			let message: ServerMessage;
			try {
				message = JSON.parse(String(event.data)) as ServerMessage;
			} catch {
				return;
			}
			this.handlers.onMessage(message);
			if (message.type === "ready") {
				this.ready = true;
				this.attempts = 0;
				this.handlers.onStatus("open");
				this.send({ type: "get_history" });
				this.send({ type: "list_conversations" });
				this.send({ type: "auth_list" });
			}
		};
		socket.onclose = (event: CloseEvent) => {
			if (socket !== this.socket) return;
			this.ready = false;
			if (event.code === CloseCode.unauthorized) {
				this.handlers.onStatus("unauthorized");
				return;
			}
			this.handlers.onStatus("closed");
			if (this.stopped) return;
			const delay = BACKOFF_MS[Math.min(this.attempts, BACKOFF_MS.length - 1)] ?? 5000;
			this.attempts += 1;
			this.retryTimer = setTimeout(() => this.connect(), delay);
		};
	}
}

interface LocationLike {
	hash: string;
	pathname: string;
	search: string;
}

interface StorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * The browser receives the token once in the URL fragment (`#token=…`), keeps it
 * in session storage, and removes it from the address bar.
 */
export function tokenFromLocation(
	location: LocationLike,
	storage: StorageLike,
	replaceUrl: (url: string) => void,
): string | undefined {
	const match = /(?:^#|&)token=([^&]+)/.exec(location.hash);
	if (match?.[1]) {
		const token = decodeURIComponent(match[1]);
		storage.setItem(TOKEN_KEY, token);
		replaceUrl(`${location.pathname}${location.search}`);
		return token;
	}
	return storage.getItem(TOKEN_KEY) ?? undefined;
}

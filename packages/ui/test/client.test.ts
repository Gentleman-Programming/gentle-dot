import type { ServerMessage } from "@gentle-dot/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DotClient, tokenFromLocation } from "../src/client.ts";
import type { ConnectionStatus } from "../src/store.ts";

class FakeSocket {
	static all: FakeSocket[] = [];
	readyState = 0;
	sent: unknown[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	readonly url: string;
	constructor(url: string) {
		this.url = url;
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	receive(message: { type: ServerMessage["type"]; [key: string]: unknown }) {
		this.onmessage?.({ data: JSON.stringify({ seq: 1, ...message }) });
	}
	drop(code = 1006) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
}

function makeClient() {
	const statuses: ConnectionStatus[] = [];
	const messages: ServerMessage[] = [];
	const client = new DotClient(
		{ url: "ws://127.0.0.1:4317/ws", token: "secret" },
		{
			onStatus: (s) => statuses.push(s),
			onMessage: (m) => messages.push(m),
			WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
		},
	);
	return { client, statuses, messages };
}

beforeEach(() => {
	FakeSocket.all = [];
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("DotClient", () => {
	it("says hello with the token, then asks for history, conversations, and accounts once ready", () => {
		const { client, statuses, messages } = makeClient();
		client.start();
		const socket = FakeSocket.all[0];
		socket?.open();
		expect(socket?.sent).toEqual([{ type: "hello", token: "secret", protocol: 1 }]);
		socket?.receive({ type: "ready", agentState: "idle" });
		expect(statuses.at(-1)).toBe("open");
		expect(messages.map((m) => m.type)).toEqual(["ready"]);
		expect(socket?.sent.slice(1)).toEqual([
			{ type: "get_history" },
			{ type: "list_conversations" },
			{ type: "auth_list" },
		]);
	});

	it("reconnects with backoff after a drop", () => {
		const { client, statuses } = makeClient();
		client.start();
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.receive({ type: "ready", agentState: "idle" });
		FakeSocket.all[0]?.drop();
		expect(statuses.at(-1)).toBe("closed");
		vi.advanceTimersByTime(499);
		expect(FakeSocket.all).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(FakeSocket.all).toHaveLength(2);
	});

	it("stops retrying when the token is rejected", () => {
		const { client, statuses } = makeClient();
		client.start();
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.drop(4401);
		vi.advanceTimersByTime(60_000);
		expect(FakeSocket.all).toHaveLength(1);
		expect(statuses.at(-1)).toBe("unauthorized");
	});

	it("reports whether a message could be sent", () => {
		const { client } = makeClient();
		client.start();
		expect(client.send({ type: "abort" })).toBe(false);
		FakeSocket.all[0]?.open();
		FakeSocket.all[0]?.receive({ type: "ready", agentState: "idle" });
		expect(client.send({ type: "abort" })).toBe(true);
	});
});

describe("tokenFromLocation", () => {
	it("reads the token from the fragment, stores it, and removes it from the address", () => {
		const storage = new Map<string, string>();
		const replace = vi.fn();
		const token = tokenFromLocation(
			{ hash: "#token=abc", pathname: "/", search: "" },
			{ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
			replace,
		);
		expect(token).toBe("abc");
		expect(storage.get("gentle-dot-token")).toBe("abc");
		expect(replace).toHaveBeenCalledWith("/");
		const again = tokenFromLocation(
			{ hash: "", pathname: "/", search: "" },
			{ getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
			replace,
		);
		expect(again).toBe("abc");
	});
});

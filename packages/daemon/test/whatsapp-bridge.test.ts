import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { WhatsAppBridge } from "../src/whatsapp-bridge.ts";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const daemons: DotDaemon[] = [];
afterEach(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.close()));
});

const AUTHORIZED_CHAT = "5491100000001@s.whatsapp.net";
const INTRUDER_CHAT = "5491100000002@s.whatsapp.net";

/**
 * Mock del provider (Baileys/BuilderBot) con registro de envíos y handlers
 * disparables, inyectado por la costura `client` del config.
 */
function makeBridge(options: {
	dataDir: string;
	daemonUrl: string;
	token: string;
	retries?: number;
	backoff?: number;
}) {
	const handlers = new Map<string, (...args: never[]) => void>();
	const sent: Array<{ chatId: string; text: string }> = [];
	let initialized = false;
	let closed = false;
	const client = {
		on: (event: string, handler: (...args: never[]) => void) => {
			handlers.set(event, handler);
		},
		initialize: async () => {
			initialized = true;
		},
		close: async () => {
			closed = true;
		},
		sendMessage: async (chatId: string, text: string) => {
			sent.push({ chatId, text });
		},
		downloadMedia: async () => null,
	};
	const bridge = new WhatsAppBridge({
		daemonUrl: options.daemonUrl,
		accessToken: options.token,
		origin: "whatsapp",
		authorizedChatId: AUTHORIZED_CHAT,
		client: client as unknown as WhatsAppBridge["client"],
		maxSendRetries: options.retries ?? 3,
		retryBackoffMs: options.backoff ?? 20,
	});
	return {
		bridge,
		sent,
		wasInitialized: () => initialized,
		wasClosed: () => closed,
		fireMessage: (from: string, body: string) =>
			(handlers.get("message") as ((msg: unknown) => Promise<void>) | undefined)?.({
				from,
				body,
				hasMedia: false,
				downloadMedia: async () => null,
			}),
	};
}

async function startDaemonFor(): Promise<{ daemon: DotDaemon; url: string; token: string }> {
	const dataDir = tempDir();
	const uiDir = join(dataDir, "ui");
	mkdirSync(uiDir);
	writeFileSync(join(uiDir, "index.html"), "<!doctype html><title>t</title>");
	const d = await startDaemon({
		port: 0,
		host: "127.0.0.1",
		dataDir,
		workspace: dataDir,
		uiDir,
		conversations: true,
		agentCommand: process.execPath,
		agentArgs: [FAKE_AGENT],
		backoffMs: [50],
	});
	daemons.push(d);
	return { daemon: d, url: `http://127.0.0.1:${d.port}`, token: d.token };
}

describe("WhatsAppBridge", () => {
	it("lifecycle: start initializes the provider and connects; stop closes cleanly", async () => {
		const { daemon, url, token } = await startDaemonFor();
		const b = makeBridge({ dataDir: tempDir(), daemonUrl: url, token });
		await b.bridge.start();
		expect(b.wasInitialized()).toBe(true);
		await b.bridge.stop();
		expect(b.wasClosed()).toBe(true);
	}, 15_000);

	it("routes daemon responses only to the authorized chat", async () => {
		const { url, token } = await startDaemonFor();
		const b = makeBridge({ dataDir: tempDir(), daemonUrl: url, token });
		await b.bridge.start();
		await b.fireMessage(AUTHORIZED_CHAT, "hola daemon");
		const done = await waitFor(() => b.sent.find((s) => s.text === "Echo: hola daemon"), 14_000);
		expect(done?.chatId).toBe(AUTHORIZED_CHAT);
		await b.bridge.stop();
	}, 15_000);

	it("refuses messages from non-authorized chats without forwarding them", async () => {
		const { url, token } = await startDaemonFor();
		const b = makeBridge({ dataDir: tempDir(), daemonUrl: url, token });
		await b.bridge.start();
		await b.fireMessage(INTRUDER_CHAT, "intruder text");
		await waitFor(() => b.sent.some((s) => s.chatId === INTRUDER_CHAT), 3_000);
		expect(b.sent.some((s) => s.text.includes("vinculado"))).toBe(true);
		// The intruder text never produces an echo to anyone.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(b.sent.some((s) => s.text.includes("intruder text"))).toBe(false);
		// Nothing leaked to the authorized chat either.
		expect(b.sent.every((s) => s.chatId === INTRUDER_CHAT)).toBe(true);
		await b.bridge.stop();
	}, 15_000);

	it("binds the daemon conversation id into the session mapping", async () => {
		const { url, token } = await startDaemonFor();
		const b = makeBridge({ dataDir: tempDir(), daemonUrl: url, token });
		await b.bridge.start();
		// Espera del handshake WS + ready: el binding de conversación ocurre al
		// recibir el ready del daemon.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await b.fireMessage(AUTHORIZED_CHAT, "!gentle session");
		const reply = await waitFor(
			() => b.sent.find((s) => s.text.startsWith("Sesión actual:") && !s.text.includes("ninguna")),
			5_000,
		);
		expect(reply?.chatId).toBe(AUTHORIZED_CHAT);
		await b.bridge.stop();
	}, 15_000);

	it("reports non-delivery after bounded retries when the daemon is unreachable", async () => {
		const { daemon, url, token } = await startDaemonFor();
		const b = makeBridge({ dataDir: tempDir(), daemonUrl: url, token, retries: 3, backoff: 20 });
		await b.bridge.start();
		// Confirm the connection works before dropping the daemon.
		await b.fireMessage(AUTHORIZED_CHAT, "ping");
		await waitFor(() => b.sent.some((s) => s.text === "Echo: ping"), 8_000);
		await daemon.close();
		await new Promise((resolve) => setTimeout(resolve, 100));
		await b.fireMessage(AUTHORIZED_CHAT, "mensaje durante caída");
		const notice = await waitFor(
			() => b.sent.find((s) => s.text.includes("No pude entregar")),
			5_000,
		);
		expect(notice?.chatId).toBe(AUTHORIZED_CHAT);
		await b.bridge.stop();
	}, 15_000);
});

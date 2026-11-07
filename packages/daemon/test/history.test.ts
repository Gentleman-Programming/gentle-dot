/**
 * T2.2: a window that opens later shows the conversation. The daemon records what it routed and
 * serves it back; without this a reopened window starts blank while the engine still remembers.
 */
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootDaemon, BRIDGE_KEY } from "./harness.ts";
import { tempDir, waitFor } from "./helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

type Frame = Record<string, unknown> & { type: string };

async function openWindow(port: number): Promise<{ ws: WebSocket; frames: Frame[] }> {
	const frames: Frame[] = [];
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	await new Promise<void>((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
	ws.on("message", (raw: Buffer) => {
		try {
			frames.push(JSON.parse(raw.toString()) as Frame);
		} catch {
			// ignore
		}
	});
	ws.send(JSON.stringify({ type: "hello", token: BRIDGE_KEY, protocol: 1 }));
	await waitFor(() => frames.some((f) => f.type === "ready"), 60_000);
	return { ws, frames };
}

describe("history over the client protocol (T2.2)", () => {
	it("serves the conversation to a window that connects after it happened", async () => {
		const booted = await bootDaemon();

		const first = await openWindow(booted.port);
		first.ws.send(JSON.stringify({ type: "send", text: "hola" }));
		await waitFor(() => first.frames.some((f) => f.type === "message_done"), 120_000);
		first.ws.close();

		// A second window knows nothing until it asks.
		const second = await openWindow(booted.port);
		second.ws.send(JSON.stringify({ type: "get_history" }));

		await waitFor(() => second.frames.some((f) => f.type === "history"), 60_000);
		const history = second.frames.find((f) => f.type === "history");
		const messages = history?.["messages"] as { role: string; text: string }[];

		expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(messages[0]?.text).toBe("hola");
		expect(String(messages[1]?.text)).toContain("Echo: hola");
		expect(history?.["hasEarlier"]).toBe(false);

		// Asking for what came before the first message returns nothing more.
		second.ws.send(JSON.stringify({ type: "get_earlier", before: messages[0]?.id ?? "" }));
		await waitFor(() => second.frames.some((f) => f.type === "earlier"), 60_000);
		const earlier = second.frames.find((f) => f.type === "earlier");
		expect((earlier?.["messages"] as unknown[]).length).toBe(0);
		expect(earlier?.["hasEarlier"]).toBe(false);

		second.ws.close();
		await booted.stop();
	});

	it("keeps the conversation across a daemon restart", async () => {
		const dataDir = tempDir();

		const first = await bootDaemon({ dataDir });
		const window1 = await openWindow(first.port);
		window1.ws.send(JSON.stringify({ type: "send", text: "sobrevive" }));
		await waitFor(() => window1.frames.some((f) => f.type === "message_done"), 120_000);
		window1.ws.close();
		await first.stop();

		// Same data dir, new daemon: the file outlives the process.
		const second = await bootDaemon({ dataDir });
		const window2 = await openWindow(second.port);
		window2.ws.send(JSON.stringify({ type: "get_history" }));
		await waitFor(() => window2.frames.some((f) => f.type === "history"), 60_000);

		const messages = window2.frames.find((f) => f.type === "history")?.["messages"] as {
			role: string;
			text: string;
		}[];
		expect(messages[0]).toMatchObject({ role: "user", text: "sobrevive" });
		expect(messages.some((m) => m.role === "assistant")).toBe(true);

		window2.ws.close();
		await second.stop();
	});
});

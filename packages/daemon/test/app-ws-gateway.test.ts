/**
 * T2.2: a window connects with the client protocol (flat frames) and sees the answer stream
 * live, instead of only the final message.
 */
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootDaemon, BRIDGE_KEY } from "./harness.ts";
import { waitFor } from "./helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

type Frame = Record<string, unknown> & { type: string };

function collect(ws: WebSocket, frames: Frame[]): void {
	ws.on("message", (raw: Buffer) => {
		try {
			frames.push(JSON.parse(raw.toString()) as Frame);
		} catch {
			// a non-JSON frame is not what this test asserts
		}
	});
}

describe("the app WebSocket gateway (T2.2)", () => {
	it("greets a window with ready and streams the answer as flat frames", async () => {
		const booted = await bootDaemon();
		const frames: Frame[] = [];

		const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/ws`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		collect(ws, frames);

		// The client protocol: flat hello, no envelope, no connectorType.
		ws.send(JSON.stringify({ type: "hello", token: BRIDGE_KEY, protocol: 1 }));

		await waitFor(() => frames.some((f) => f.type === "ready"), 60_000);
		const ready = frames.find((f) => f.type === "ready");
		expect(ready?.["protocol"]).toBe(1);
		expect(typeof ready?.["clientId"]).toBe("string");

		ws.send(JSON.stringify({ type: "send", text: "hola" }));

		await waitFor(() => frames.some((f) => f.type === "message_done"), 120_000);
		const deltas = frames.filter((f) => f.type === "message_delta");
		const done = frames.find((f) => f.type === "message_done");

		expect(deltas.length).toBeGreaterThan(0);
		// Flat frames: the payload fields sit at the top level, as the protocol expects.
		expect(typeof deltas[0]?.["delta"]).toBe("string");
		expect(typeof done?.["text"]).toBe("string");
		expect(String(done?.["text"]).length).toBeGreaterThan(0);

		ws.close();
		await booted.stop();
	});

	it("asks the window and takes its answer back to the engine", async () => {
		const booted = await bootDaemon();
		const frames: Frame[] = [];

		const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/ws`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		collect(ws, frames);

		ws.send(JSON.stringify({ type: "hello", token: BRIDGE_KEY, protocol: 1 }));
		await waitFor(() => frames.some((f) => f.type === "ready"), 60_000);

		// The fake engine answers "ask:select" by asking the user to pick a colour.
		ws.send(JSON.stringify({ type: "send", text: "ask:select" }));

		await waitFor(() => frames.some((f) => f.type === "ask"), 120_000);
		const ask = frames.find((f) => f.type === "ask");
		expect(ask?.["method"]).toBe("select");
		expect(ask?.["title"]).toBe("Pick a color");
		expect(ask?.["options"]).toContain("Blue");

		ws.send(JSON.stringify({ type: "ui_response", requestId: ask?.["requestId"], value: "Blue" }));

		await waitFor(() => frames.some((f) => f.type === "message_done"), 120_000);
		const done = frames.find((f) => f.type === "message_done");
		expect(String(done?.["text"])).toContain("You chose Blue");

		ws.close();
		await booted.stop();
	});
});

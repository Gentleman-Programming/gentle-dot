/**
 * The daemon boots with an injected engine argv, so tests can drive it with the fake agent
 * instead of the real gentle-shell. This is the harness the refactor lost when `startDaemon`
 * and `agentCommand` disappeared, and the first test it buys is the owed one for T2.1:
 * streaming deltas must reach the app channel, not only the connector that asked.
 */
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { FAKE_AGENT, tempDir, waitFor } from "./helpers.ts";

const home = tempDir();
// AppChannel resolves its socket from HOME at module load, so HOME must be set first.
process.env["HOME"] = home;

const PORT = 4321;
const SOCKET = join(home, ".gentle-dot", "app-channel.sock");

type Frame = { type: string; payload?: Record<string, unknown> };

/** A raw client on the daemon's app channel socket; collects every frame it receives. */
function appClient(frames: Frame[]) {
	const sock = net.createConnection(SOCKET);
	let buffer = "";
	sock.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
		let index: number;
		while ((index = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			if (!line) continue;
			try {
				frames.push(JSON.parse(line) as Frame);
			} catch {
				// a partial or non-JSON frame is not what this test asserts
			}
		}
	});
	return sock;
}

const daemons: { stop(): Promise<void> }[] = [];

afterAll(async () => {
	await Promise.all(daemons.splice(0).map((d) => d.stop()));
});

describe("the app channel sees the answer stream", () => {
	it("mirrors message_delta and message_done to the app while the connector gets them", async () => {
		mkdirSync(join(home, ".gentle-dot"), { recursive: true });
		const { createDaemon } = await import("../src/daemon.ts");

		// The loader resolves its default path against the repo root, so the test hands it an
		// explicit minimal config instead of depending on the caller's cwd.
		// The daemon reads connector defaults from its own config, so the test reuses the repo's
		// config instead of a stub that would miss the required connector blocks.
		const configPath = fileURLToPath(new URL("../connectors.yaml", import.meta.url));

		const daemon = await createDaemon({
			configPath,
			port: PORT,
			host: "127.0.0.1",
			dataDir: tempDir(),
			workspace: tempDir(),
			engineCommand: [process.execPath, FAKE_AGENT],
		});
		daemons.push(daemon);

		const appFrames: Frame[] = [];
		const app = appClient(appFrames);
		await waitFor(() => appFrames.some((f) => f.type === "welcome"));

		const connectorFrames: Frame[] = [];
		const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
		await new Promise<void>((resolve, reject) => {
			ws.once("open", () => resolve());
			ws.once("error", reject);
		});
		ws.on("message", (raw: Buffer) => {
			try {
				connectorFrames.push(JSON.parse(raw.toString()) as Frame);
			} catch {
				// ignore
			}
		});

		ws.send(
			JSON.stringify({
				type: "hello",
				timestamp: Date.now(),
				payload: {
					token: process.env["BRIDGE_AUTH_TOKEN"] ?? "gentle-dot-bridge-secret",
					protocol: 1,
					capabilities: ["message_send"],
					connectorType: "telegram",
					connectorId: "mirror-test",
					metadata: {},
				},
			}),
		);
		await waitFor(() => connectorFrames.some((f) => f.type === "ready"));

		ws.send(
			JSON.stringify({ type: "send", timestamp: Date.now(), payload: { text: "hola", requestId: "mirror-1" } }),
		);

		await waitFor(() => connectorFrames.some((f) => f.type === "message_done"), 120_000);

		const connectorDeltas = connectorFrames.filter((f) => f.type === "message_delta");
		expect(connectorDeltas.length).toBeGreaterThan(0);

		await waitFor(() => appFrames.some((f) => f.type === "message_done"), 30_000);
		const appDeltas = appFrames.filter((f) => f.type === "message_delta");
		const appDone = appFrames.find((f) => f.type === "message_done");

		// The whole point: the window sees the same text, delta by delta.
		expect(appDeltas.length).toBe(connectorDeltas.length);
		expect(appDeltas.map((f) => f.payload?.["delta"])).toEqual(connectorDeltas.map((f) => f.payload?.["delta"]));
		expect(appDeltas[0]?.payload?.["messageId"]).toBe(connectorDeltas[0]?.payload?.["messageId"]);
		expect(appDone?.payload?.["connectorId"]).toBe("mirror-test");

		ws.close();
		app.destroy();
	}, 180_000);
});

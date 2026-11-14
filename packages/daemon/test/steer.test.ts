/**
 * T3: a message sent while a run is active must steer that run instead of being dropped or
 * starting a second one. The daemon already sets streamingBehavior, but nothing proved it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { bootDaemon, BRIDGE_KEY } from "./harness.ts";
import { tempDir, waitFor } from "./helpers.ts";

vi.setConfig({ testTimeout: 180_000 });

type Frame = Record<string, unknown> & { type: string };

const prompts = (file: string): { message?: string; streamingBehavior?: string }[] => {
	try {
		return readFileSync(file, "utf8")
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { message?: string; streamingBehavior?: string });
	} catch {
		return [];
	}
};

describe("a prompt during a run steers it (T3)", () => {
	it("sends the second message with streamingBehavior steer", async () => {
		const promptsFile = join(tempDir(), "prompts.jsonl");
		const booted = await bootDaemon({ env: { FAKE_AGENT_PROMPTS_FILE: promptsFile } });
		const frames: Frame[] = [];

		const ws = new WebSocket(`ws://127.0.0.1:${booted.port}/ws`);
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

		// ask:select leaves the run open until the question is answered: a real busy run.
		ws.send(JSON.stringify({ type: "send", text: "ask:select" }));
		await waitFor(() => frames.some((f) => f.type === "ask"), 120_000);

		ws.send(JSON.stringify({ type: "send", text: "y ademas segui" }));

		await waitFor(() => prompts(promptsFile).length >= 2, 120_000);
		const [, second] = prompts(promptsFile);
		expect(second?.message).toBe("y ademas segui");
		expect(second?.streamingBehavior).toBe("steer");

		ws.close();
		await booted.stop();
	});
});

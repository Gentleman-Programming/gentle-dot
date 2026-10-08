// @real-agent: starts the real `gentle-shell` and calls the configured model.
// Opt-in with GENTLE_DOT_REAL_AGENT=1 (`pnpm test:real`) so ordinary runs cost nothing.
import { execFileSync } from "node:child_process";
import type { ServerMessage } from "@gentle-dot/protocol";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type DotDaemon, startDaemon } from "../src/daemon.ts";
import { HIDDEN_NAMES } from "../src/white-label.ts";
import { tempDir, waitFor } from "./helpers.ts";

function hasGentleShell(): boolean {
	try {
		execFileSync("which", ["gentle-shell"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const enabled = process.env.GENTLE_DOT_REAL_AGENT === "1" && hasGentleShell();

describe.skipIf(!enabled)("@real-agent gentle-shell", () => {
	let daemon: DotDaemon | undefined;
	afterAll(async () => {
		await daemon?.close();
	});

	it("starts gentle-shell in RPC mode with the Gentle extensions loaded", { timeout: 120_000 }, async () => {
		const dataDir = tempDir();
		daemon = await startDaemon({
			port: 0,
			host: "127.0.0.1",
			dataDir,
			workspace: dataDir,
			uiDir: dataDir,
			agentCommand: "gentle-shell",
		});
		expect(daemon.supervisor.state).toBe("ready");
		const response = await daemon.supervisor.request({ type: "get_commands" });
		const names = (response.data as { commands: { name: string }[] }).commands.map((c) => c.name);
		expect(names.some((name) => name.startsWith("gentle:"))).toBe(true);
	});

	it("answers as Gentle Dot without internal names", { timeout: 300_000 }, async () => {
		if (!daemon) throw new Error("daemon not started");
		const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
		const messages: ServerMessage[] = [];
		ws.on("message", (data) => messages.push(JSON.parse(String(data)) as ServerMessage));
		await new Promise((resolve) => ws.on("open", resolve));
		ws.send(JSON.stringify({ type: "hello", token: daemon.token, protocol: 1 }));
		await waitFor(() => messages.some((m) => m.type === "ready"));
		ws.send(JSON.stringify({ type: "send", text: "Who are you? Answer in one or two sentences." }));
		await waitFor(() => messages.some((m) => m.type === "agent_state" && m.state === "thinking"), 30_000);
		await waitFor(() => messages.some((m) => m.type === "agent_state" && m.state === "idle"), 280_000);
		const answer = messages
			.flatMap((m) => (m.type === "message_done" ? [m.text] : []))
			.filter(Boolean)
			.at(-1);
		console.log(`identity answer: ${answer}`);
		expect(answer).toMatch(/Gentle Dot/);
		const shown = JSON.stringify(messages);
		for (const name of HIDDEN_NAMES) expect(shown).not.toMatch(name);
		ws.close();
	});
});

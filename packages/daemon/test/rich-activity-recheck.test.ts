import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { redactPreview } from "../src/activity-preview.ts";
import { DotBridge } from "../src/bridge.ts";
import { historyFromMessages } from "../src/conversations.ts";
import { startDaemon } from "../src/daemon.ts";
import type { AgentSupervisor, SupervisorEvent } from "../src/supervisor.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

function liveAndHistory(args: unknown, text: string, secrets: string[] = []) {
	let emit: (event: SupervisorEvent) => void = () => {};
	const supervisor = {
		state: "stopped",
		launched: false,
		busy: false,
		onEvent: (listener: (event: SupervisorEvent) => void) => {
			emit = listener;
			return () => {};
		},
	} as unknown as AgentSupervisor;
	const bridge = new DotBridge(supervisor, { dataDir: "/unused", previewSecrets: () => secrets });
	const sent: ServerPayload[] = [];
	bridge.attach({ send: (payload) => sent.push(payload) });
	emit({ type: "tool_execution_start", toolCallId: "a", toolName: "bash", args });
	emit({
		type: "tool_execution_end",
		toolCallId: "a",
		toolName: "bash",
		isError: false,
		result: { content: [{ type: "text", text }] },
	});
	const history = historyFromMessages(
		[
			{ role: "assistant", content: [{ type: "toolCall", id: "a", name: "bash", arguments: args }] },
			{ role: "toolResult", toolCallId: "a", content: [{ type: "text", text }] },
		],
		secrets,
	);
	const live = sent.flatMap((p) => (p.type === "activity" ? [p.activity] : []));
	expect(live).toHaveLength(2);
	expect(live[1]).toEqual(history[0]?.activities[0]);
	return [...live, ...(history[0]?.activities ?? [])];
}

describe("S13.5 exact verifier recheck", () => {
	it("masks the exact login email inside command JSON and result text", () => {
		const text = '{"subject":"Your login","body":"Your code is 123456"}';
		const activities = liveAndHistory({ command: text }, text);
		for (const activity of activities) {
			expect(JSON.stringify(activity)).not.toContain("123456");
			expect(activity.detail).toContain("Your login");
			expect(activity.detail).toContain("Your code is [REDACTED]");
			if (activity.status !== "running") expect(activity.output).toContain("Your code is [REDACTED]");
		}
	});

	it("masks known secrets used as property names, live and in history", () => {
		const args = { cache: { "own-daemon-token-opaque": "active" } };
		const text = '{"own-daemon-token-opaque":"active"}';
		for (const activity of liveAndHistory(args, text, ["own-daemon-token-opaque"])) {
			expect(JSON.stringify(activity)).not.toContain("own-daemon-token-opaque");
			expect(activity.detail).toBe('{"cache":{"[REDACTED]":"active"}}');
			if (activity.output) expect(activity.output).toBe('{"[REDACTED]":"active"}');
		}
	});

	it.each(["-".repeat(204800), "a-".repeat(102400)])("bounds adversarial input in a child: %#", (input) => {
		const module = new URL("../src/activity-preview.ts", import.meta.url).href;
		const expression = input.startsWith("a") ? '"a-".repeat(102400)' : '"-".repeat(204800)';
		const script = `import { redactPreview } from ${JSON.stringify(module)}; redactPreview(${expression}, 2000);`;
		const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			timeout: 3000,
			encoding: "utf8",
		});
		expect(child.error, child.stderr).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
	});

	it.each(["-".repeat(65536), "a-".repeat(32768)])("scans 64 KB under 200 ms: %#", (input) => {
		const start = performance.now();
		redactPreview(input, 2000);
		expect(performance.now() - start).toBeLessThan(200);
	});

	it("never emits the unscanned suffix, even with an unlimited display cap", () => {
		// One token across the scan-window edge: none of it is emitted.
		const prefix = "x".repeat(65536);
		expect(redactPreview(`${prefix}opaque-unscanned-secret`, Number.POSITIVE_INFINITY)).toBe("[TRUNCATED]");
		// Text scanned before the last delimiter is kept; the token cut by the edge is dropped.
		const words = `${"word ".repeat(13107)}opaque-unscanned-secret`;
		const shown = redactPreview(words, Number.POSITIVE_INFINITY);
		expect(shown.endsWith(" [TRUNCATED]")).toBe(true);
		expect(shown).not.toContain("opaque");
		expect(shown.length).toBeGreaterThan(65000);
	});

	it.each([{ capabilities: "reasoning" }, { capabilities: ["reasoning", 1] }, { capabilities: null }])(
		"ignores malformed hello capabilities: $capabilities",
		async ({ capabilities }) => {
			const dataDir = mkdtempSync(join(tmpdir(), "gentle-dot-recheck-"));
			const daemon = await startDaemon({
				host: "127.0.0.1",
				port: 0,
				dataDir,
				workspace: dataDir,
				uiDir: dataDir,
				agentCommand: process.execPath,
				agentArgs: [FAKE_AGENT],
			});
			const sockets: WebSocket[] = [];
			const connect = async (token: string) => {
				const ws = new WebSocket(`ws://127.0.0.1:${daemon.port}/ws`);
				sockets.push(ws);
				const sent: ServerPayload[] = [];
				const closed = new Promise<number>((resolve) => ws.on("close", resolve));
				ws.on("message", (data) => sent.push(JSON.parse(String(data)) as ServerPayload));
				await new Promise<void>((resolve, reject) => {
					ws.on("open", resolve);
					ws.on("error", reject);
				});
				ws.send(JSON.stringify({ type: "hello", token, protocol: 1, capabilities }));
				return { ws, sent, closed };
			};
			try {
				const client = await connect(daemon.token);
				const outcome = await Promise.race([
					waitFor(() => client.sent.find((p) => p.type === "ready")),
					client.closed,
				]);
				expect(outcome).toMatchObject({ type: "ready" });
				client.ws.send(JSON.stringify({ type: "send", text: `rich:${daemon.token}` }));
				const done = await waitFor(() => client.sent.find((p) => p.type === "message_done"));
				expect(done).not.toHaveProperty("reasoning");
				expect(client.sent.some((p) => p.type === "reasoning_delta")).toBe(false);
				const rejected = await connect("wrong-token");
				expect(await rejected.closed).toBe(4401);
				expect(rejected.sent).toEqual([]);
			} finally {
				for (const ws of sockets) ws.terminate();
				await daemon.close();
				rmSync(dataDir, { recursive: true, force: true });
			}
		},
	);
});

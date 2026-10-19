import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { ConnectorManager } from "../src/connectors.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor, tempDir, waitFor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

async function setup(env: NodeJS.ProcessEnv) {
	const { supervisor, dataDir } = fakeSupervisor({ env: { ...process.env, ...env } });
	supervisors.push(supervisor);
	const logs: string[] = [];
	const bridge = new DotBridge(supervisor, {
		dataDir,
		log: (line) => logs.push(line),
		stopTimeoutMs: 300,
		features: { conversations: true },
	});
	const received: ServerPayload[] = [];
	const client = { send: (payload: ServerPayload) => received.push(payload) };
	bridge.attach(client);
	await supervisor.start();
	return { bridge, client, received, logs };
}

describe("stopping before a switch", () => {
	it("still switches after a bounded wait when the agent ignores the stop, and clears the stop mark", async () => {
		const { bridge, client, received, logs } = await setup({ FAKE_AGENT_IGNORE_ABORT: "1" });
		await bridge.handle(client, { type: "send", text: "hang" });
		await waitFor(() => bridge.agentState === "thinking");
		const started = Date.now();
		await bridge.handle(client, { type: "new_conversation" });
		expect(Date.now() - started).toBeLessThan(3000);
		expect(logs.some((line) => line.includes("did not stop"))).toBe(true);
		const history = received.findIndex((p) => p.type === "history");
		const stopped = received.findIndex((p) => p.type === "message_done" && p.stopped === true);
		expect(stopped).toBeGreaterThanOrEqual(0);
		expect(stopped).toBeLessThan(history);
		expect(received.filter((p) => p.type === "error" || p.type === "toast")).toEqual([]);
		await waitFor(() => bridge.agentState === "idle");

		// The mark is gone: a real failure afterwards is an error, not a stop.
		await bridge.handle(client, { type: "send", text: "fail" });
		const failed = await waitFor(() =>
			received.find(
				(p): p is Extract<ServerPayload, { type: "message_done" }> =>
					p.type === "message_done" && p.error !== undefined,
			),
		);
		expect(failed.stopped).toBeUndefined();
	});
});

describe("a connector change while the agent is starting", () => {
	it("replaces the attempt without reporting it as a failure", async () => {
		const argsFile = join(tempDir(), "argv.json");
		const attemptsFile = join(tempDir(), "attempts.json");
		const { supervisor, dataDir } = fakeSupervisor({
			env: {
				...process.env,
				FAKE_AGENT_ARGS_FILE: argsFile,
				FAKE_AGENT_ATTEMPTS_FILE: attemptsFile,
				FAKE_AGENT_STALL_START_AT: "1",
			},
		});
		supervisors.push(supervisor);
		const logs: string[] = [];
		// The bridge installs its own callbacks; `onChanged` is the connectors' way in, as in production.
		const connectors = {
			onChanged: (): void => {},
			drafts: () => [],
			list: () => [],
			imagesSupported: () => undefined,
		} as unknown as ConnectorManager;
		const bridge = new DotBridge(supervisor, {
			dataDir,
			log: (line) => logs.push(line),
			stopTimeoutMs: 300,
			features: { conversations: true },
			connectors,
		});
		const received: ServerPayload[] = [];
		bridge.attach({ send: (payload: ServerPayload) => received.push(payload) });
		const starting = supervisor.start();
		// The child has to be up (and stalled) before the connector change lands on it.
		await waitFor(() => existsSync(argsFile));
		// A change that needs a restart lands while the first attempt is still starting.
		connectors.onChanged(true);
		await starting;
		await waitFor(() => supervisor.state === "ready");
		expect(logs.join("\n")).not.toMatch(/agent restart failed/);
		expect(received.some((p) => p.type === "error" || p.type === "toast")).toBe(false);
		expect(Number(readFileSync(attemptsFile, "utf8"))).toBe(2);
	});
});

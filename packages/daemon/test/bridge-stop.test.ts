import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor, waitFor } from "./helpers.ts";

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

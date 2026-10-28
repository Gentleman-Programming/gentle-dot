import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

function setup() {
	const { supervisor, dataDir } = fakeSupervisor();
	supervisors.push(supervisor);
	const bridge = new DotBridge(supervisor, { dataDir, log: () => {}, features: { conversations: true } });
	const received: ServerPayload[] = [];
	bridge.attach({ send: (payload: ServerPayload) => received.push(payload) });
	return { supervisor, bridge, received };
}

describe("agent state at startup (S2)", () => {
	it("reports starting before the engine was asked to start, not an error", () => {
		const { bridge, received } = setup();
		expect(bridge.agentState).toBe("starting");
		expect(received.find((p) => p.type === "ready")).toMatchObject({ agentState: "starting" });
	});

	it("still reports an error once the engine stopped", async () => {
		const { supervisor, bridge, received } = setup();
		await supervisor.start();
		expect(bridge.agentState).toBe("idle");
		await supervisor.stop();
		expect(bridge.agentState).toBe("error");
		expect(received.filter((p) => p.type === "agent_state").at(-1)).toMatchObject({ state: "error" });
	});
});

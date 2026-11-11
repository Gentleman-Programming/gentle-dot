import type { ServerPayload } from "@gentle-dot/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { DotBridge } from "../src/bridge.ts";
import type { AgentSupervisor } from "../src/supervisor.ts";
import { fakeSupervisor } from "./helpers.ts";

const supervisors: AgentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((s) => s.stop()));
});

/**
 * The panel asks for history as soon as it connects, which on a cold start is while the agent is
 * still provisioning companion packages — minutes, measured at 3m39s. That request used to wait for
 * readiness with a 60s budget and then fail with "the agent did not start in time", and nothing was
 * gained by it: the panel asks again when the `ready` event arrives (`packages/ui/src/client.ts`).
 * So the request answers from the conversation on disk while the agent is starting.
 */
describe("history while the agent is starting", () => {
	it("answers instead of waiting for readiness, and the panel can ask again", async () => {
		const { supervisor, dataDir } = fakeSupervisor({
			env: { ...process.env, FAKE_AGENT_START_DELAY_MS: "20000" },
		});
		supervisors.push(supervisor);
		const bridge = new DotBridge(supervisor, {
			dataDir,
			log: () => {},
			features: { conversations: true },
		});
		const received: ServerPayload[] = [];
		const client = { send: (payload: ServerPayload) => received.push(payload) };
		bridge.attach(client);
		// Started, not awaited: the agent is deliberately still in its handshake. The stop in
		// `afterEach` cuts that handshake, so the rejection is expected here and swallowed.
		void supervisor.start().catch(() => {});
		const started = Date.now();
		await bridge.handle(client, { type: "get_history" });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(received.some((payload) => payload.type === "history")).toBe(true);
	});
});

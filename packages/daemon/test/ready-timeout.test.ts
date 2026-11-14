// The engine's readiness timeout is configurable (GENTLE_DOT_ENGINE_READY_TIMEOUT_MS): a new agent
// home provisions the gentle-ai companion packages on its first start, which takes minutes, and a
// fixed short timeout kills the engine mid-provisioning so the work never completes and the daemon
// restarts forever. The default stays at 30s, and anything unusable falls back to it.
import { describe, expect, it } from "vitest";
import { readyTimeoutMs } from "../src/gentle-shell-spawner.ts";

describe("readyTimeoutMs", () => {
	it("defaults to 30 seconds when the variable is unset", () => {
		expect(readyTimeoutMs({})).toBe(30_000);
	});

	it("uses the configured value", () => {
		expect(readyTimeoutMs({ GENTLE_DOT_ENGINE_READY_TIMEOUT_MS: "900000" })).toBe(900_000);
	});

	it("falls back to the default for an unusable value", () => {
		for (const raw of ["", "   ", "abc", "0", "-5", "Infinity"]) {
			expect(readyTimeoutMs({ GENTLE_DOT_ENGINE_READY_TIMEOUT_MS: raw })).toBe(30_000);
		}
	});
});

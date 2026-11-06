import { describe, expect, it } from "vitest";
import { requireAuthToken } from "../src/ws-server.ts";

/**
 * The WebSocket server authenticates windows and bridges with one shared key.
 * It must fail closed: a built-in default would let any local process on the
 * machine authenticate with a secret published in the source (S25.8).
 */
describe("requireAuthToken", () => {
	it("throws instead of falling back to a built-in shared secret", () => {
		expect(() => requireAuthToken({})).toThrow(/BRIDGE_AUTH_TOKEN/);
	});

	it("treats an empty variable as missing", () => {
		expect(() => requireAuthToken({ BRIDGE_AUTH_TOKEN: "" })).toThrow(/BRIDGE_AUTH_TOKEN/);
	});

	it("answers the key the daemon generated", () => {
		expect(requireAuthToken({ BRIDGE_AUTH_TOKEN: "key-from-dataDir-token" })).toBe("key-from-dataDir-token");
	});
});

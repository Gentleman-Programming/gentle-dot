import { afterEach, describe, expect, it, vi } from "vitest";
import { newRequestId } from "../src/components/types.ts";

/**
 * `crypto.randomUUID` is secure-context only. A phone opening the page over
 * `http://<LAN-ip>` is not a secure context, and every send needs a request id.
 */
describe("newRequestId", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("uses crypto.randomUUID when the context provides it", () => {
		expect(newRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("still returns an id in an insecure context without crypto.randomUUID", () => {
		const withoutUuid = { getRandomValues: crypto.getRandomValues.bind(crypto) };
		vi.stubGlobal("crypto", withoutUuid);
		const id = newRequestId();
		expect(typeof id).toBe("string");
		expect(id.length).toBeGreaterThan(0);
		// Two calls must not collide: the daemon drops a repeated requestId silently.
		expect(id).not.toBe(newRequestId());
	});
});

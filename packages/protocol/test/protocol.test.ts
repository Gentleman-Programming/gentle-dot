import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../src/index.ts";

describe("protocol", () => {
	it("exposes version 1", () => {
		expect(PROTOCOL_VERSION).toBe(1);
	});
});

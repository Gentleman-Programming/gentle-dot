import { describe, it, expect } from "vitest";
import { MCP_TYPESCRIPT_PREAMBLE } from "@earendil-works/pi-codemode";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = join(fileURLToPath(import.meta.url), "..", "..");

function getLockfileVersion(): string {
	const lockfilePath = join(__dirname, "..", "..", "pnpm-lock.yaml");
	const content = readFileSync(lockfilePath, "utf-8");
	// Find the pi-codemode version in the lockfile
	const match = content.match(/@earendil-works\+pi-codemode@1\.0\.4/);
	if (match) return "1.0.4";
	// Also check for specifier version
	const specifierMatch = content.match(/specifier: 1\.0\.4/);
	if (specifierMatch) return "1.0.4";
	return "unknown";
}

describe("pi-codemode pin 1.0.4", () => {
	it("imports MCP_TYPESCRIPT_PREAMBLE from packaged dependency", () => {
		expect(MCP_TYPESCRIPT_PREAMBLE).toBeDefined();
		expect(typeof MCP_TYPESCRIPT_PREAMBLE).toBe("string");
		expect(MCP_TYPESCRIPT_PREAMBLE.length).toBeGreaterThan(0);
	});

	it("MCP_TYPESCRIPT_PREAMBLE contains expected preamble content", () => {
		expect(MCP_TYPESCRIPT_PREAMBLE).toContain("type Role");
		expect(MCP_TYPESCRIPT_PREAMBLE).toContain("CallToolResult");
	});

	it("verifies pi-codemode version is 1.0.4 via lockfile", () => {
		expect(getLockfileVersion()).toBe("1.0.4");
	});
});
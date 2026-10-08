import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

describe("loadConfig", () => {
	it("uses local-only defaults", () => {
		const dataDir = tempDir();
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: dataDir });
		expect(config).toMatchObject({
			port: 4317,
			host: "127.0.0.1",
			dataDir,
			agentCommand: "gentle-shell",
			agentArgs: [],
		});
	});

	it("reads config.json and lets environment variables win", () => {
		const dataDir = tempDir();
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: 5000, workspace: dataDir }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir })).toMatchObject({ port: 5000, workspace: dataDir });
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_PORT: "6000" }).port).toBe(6000);
	});

	it("rejects an invalid port and a malformed argument list", () => {
		const dataDir = tempDir();
		expect(() => loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_PORT: "abc" })).toThrow(
			"Invalid port",
		);
		expect(() => loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_ARGS: '{"a":1}' })).toThrow(
			"GENTLE_DOT_AGENT_ARGS must be a JSON array of strings",
		);
	});
});

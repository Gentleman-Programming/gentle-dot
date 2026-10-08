import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

describe("loadConfig", () => {
	it("uses local-only defaults and the bundled Gentle Shell with the assistant's own home", () => {
		const dataDir = tempDir();
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: dataDir });
		expect(config).toMatchObject({
			port: 4317,
			host: "127.0.0.1",
			dataDir,
			agentCommand: process.execPath,
			agentHome: join(dataDir, "agent"),
			// Never the user's home: the engine reads project settings from its workspace.
			workspace: join(dataDir, "workspace"),
		});
		expect(config.agentArgs).toHaveLength(1);
		expect(config.agentArgs[0]).toMatch(/node_modules\/gentle-pi\/bin\/gentle-shell\.mjs$/);
		expect(existsSync(config.agentArgs[0] ?? "")).toBe(true);
	});

	it("keeps the assistant's own home for an explicit gentle-shell binary, and honors an override", () => {
		const dataDir = tempDir();
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_BIN: "gentle-shell" })).toMatchObject({
			agentCommand: "gentle-shell",
			agentArgs: [],
			agentHome: join(dataDir, "agent"),
		});
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_HOME: "/h" }).agentHome).toBe("/h");
	});

	it("runs a custom agent script without the Gentle Shell home", () => {
		const dataDir = tempDir();
		const config = loadConfig({
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_AGENT_BIN: "node",
			GENTLE_DOT_AGENT_ARGS: '["fake.ts"]',
		});
		expect(config).toMatchObject({ agentCommand: "node", agentArgs: ["fake.ts"] });
		expect(config.agentHome).toBeUndefined();
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

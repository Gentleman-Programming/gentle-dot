import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { agentSpawnEnv, bundledGentleShell, loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

describe("packaged agent spawn environment", () => {
	const runtime = join(process.cwd(), "packaged-runtime");
	const script = join(runtime, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	const env = {
		GENTLE_DOT_RUNTIME: runtime,
		GENTLE_SHELL_NO_AUTO_SETUP: "0",
		GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "0",
	};

	it("disables both automatic setup gates for the Windows bundled default without mutating its input", () => {
		expect(agentSpawnEnv(process.execPath, [script, "--home", "/agent"], env, "win32")).toEqual({
			...env,
			GENTLE_SHELL_NO_AUTO_SETUP: "1",
			GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
		});
		expect(env.GENTLE_SHELL_NO_AUTO_SETUP).toBe("0");
		expect(env.GENTLE_PI_SKIP_GENTLE_AI_INSTALL).toBe("0");
	});

	it("matches the repository-local launcher's early-return gates, not just its notices", () => {
		// Read source only: never import or execute the launcher or installer.
		const launcherPath = bundledGentleShell({});
		const launcher = readFileSync(launcherPath, "utf8");
		expect(launcher).toContain('const AUTO_SETUP_OPT_OUT_ENV = "GENTLE_SHELL_NO_AUTO_SETUP";');
		expect(launcher).toMatch(
			/async function maybeAutoProvisionHome\([^\n]+\) \{\s*if \(process\.env\[AUTO_SETUP_OPT_OUT_ENV\] === "1"\) return undefined;/,
		);
		expect(launcher).toContain('const SKIP_GENTLE_AI_INSTALL_ENV = "GENTLE_PI_SKIP_GENTLE_AI_INSTALL";');
		expect(launcher).toMatch(
			/function ensurePackageLocalGentleAi\([^\n]+\) \{\s*if \(existsSync\(binaryPath\)\) return \{ ok: true \};\s*if \(process\.env\[SKIP_GENTLE_AI_INSTALL_ENV\] === "1"\) \{\s*return \{/,
		);
		const installer = readFileSync(
			join(launcherPath, "..", "..", "scripts", "install-gentle-ai.mjs"),
			"utf8",
		);
		expect(installer).toMatch(/if \(process\.env\.GENTLE_PI_SKIP_GENTLE_AI_INSTALL === "1"\) \{/);
	});

	it.each(["linux", "darwin"] as const)(
		"preserves prior %s bundled startup and operator gate values",
		(platform) => {
			expect(agentSpawnEnv(process.execPath, [script], env, platform)).toEqual(env);
		},
	);

	it("preserves Windows source and explicit launch choices", () => {
		const cases = [
			{ command: process.execPath, args: [script], env: { ...env, GENTLE_DOT_RUNTIME: "" } },
			{ command: "custom-node", args: [script], env },
			{ command: process.execPath, args: ["external-shell.mjs"], env },
			...[
				{ GENTLE_DOT_AGENT_SCRIPT: script },
				{ GENTLE_DOT_AGENT_BIN: process.execPath },
				{ GENTLE_DOT_AGENT_ARGS: "[]" },
			].map((override) => ({ command: process.execPath, args: [script], env: { ...env, ...override } })),
		];
		for (const choice of cases)
			expect(agentSpawnEnv(choice.command, choice.args, choice.env, "win32")).toEqual(choice.env);
	});
});

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
		expect(config.preferredFolder).toBeUndefined();
		expect(config.agentArgs).toHaveLength(1);
		expect(config.agentArgs[0]?.endsWith(join("node_modules", "gentle-pi", "bin", "gentle-shell.mjs"))).toBe(
			true,
		);
		expect(existsSync(config.agentArgs[0] ?? "")).toBe(true);
	});

	it("keeps the assistant's own home for an explicit gentle-shell binary, and honors an override", () => {
		const dataDir = tempDir();
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_BIN: "gentle-shell" })).toMatchObject({
			agentCommand: "gentle-shell",
			agentArgs: [],
			agentHome: join(dataDir, "agent"),
		});
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_HOME: "/h" }).agentHome).toBe(
			resolve("/h"),
		);
	});

	it("runs an explicit Gentle Shell script with Node and keeps its separate home", () => {
		const dataDir = tempDir();
		const script = String.raw`C:\Users\test user\.pnpm\gentle-shell.mjs`;
		const env = { GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_SCRIPT: script };
		expect(loadConfig(env)).toMatchObject({
			agentCommand: process.execPath,
			agentArgs: [script],
			agentHome: join(dataDir, "agent"),
			workspace: join(dataDir, "workspace"),
		});
		const home = join(dataDir, "separate-home");
		expect(
			loadConfig({ ...env, GENTLE_DOT_AGENT_BIN: "custom-node", GENTLE_DOT_AGENT_HOME: home }),
		).toMatchObject({ agentCommand: "custom-node", agentArgs: [script], agentHome: home });
		// Empty selection preserves the existing bundled default.
		expect(loadConfig({ ...env, GENTLE_DOT_AGENT_SCRIPT: "" })).toEqual(
			loadConfig({ GENTLE_DOT_DATA_DIR: dataDir }),
		);
	});

	it("runs a custom agent script without the Gentle Shell home", () => {
		const dataDir = tempDir();
		const config = loadConfig({
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_AGENT_BIN: "node",
			GENTLE_DOT_AGENT_ARGS: '["fake.ts"]',
			GENTLE_DOT_AGENT_SCRIPT: "ignored-gentle-shell.mjs",
		});
		expect(config).toMatchObject({ agentCommand: "node", agentArgs: ["fake.ts"] });
		expect(config.agentHome).toBeUndefined();
	});

	it("reads config.json and lets environment variables win", () => {
		const dataDir = tempDir();
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: 5000, workspace: "/projects" }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir })).toMatchObject({
			port: 5000,
			preferredFolder: resolve("/projects"),
		});
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_PORT: "6000" }).port).toBe(6000);
	});

	it("keeps the engine in its own workspace and treats a custom one as the user's preferred folder", () => {
		const dataDir = tempDir();
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_WORKSPACE: "/work/repo" });
		// The workspace holds the memory project setting, so the engine always works there.
		expect(config).toMatchObject({
			workspace: join(dataDir, "workspace"),
			preferredFolder: resolve("/work/repo"),
		});
		const same = loadConfig({
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_WORKSPACE: join(dataDir, "workspace"),
		});
		expect(same.preferredFolder).toBeUndefined();
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

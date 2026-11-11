import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, toNamespacedPath } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentSpawnEnv, bundledGentleShell, loadConfig } from "../src/config.ts";
import { runtimeDir } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";

const fixtures: string[] = [];
afterEach(() => {
	for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function engineFixture() {
	const root = tempDir();
	fixtures.push(root);
	const runtime = join(root, "runtime with spaces; reserved # %");
	const entry = join(runtime, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(entry, 'process.stdout.write("engine fixture ok\\n");\n');
	return { root, runtime, entry };
}

function runEngine(config: ReturnType<typeof loadConfig>) {
	const result = spawnSync(config.agentCommand, config.agentArgs, {
		encoding: "utf8", timeout: 5000, cwd: config.dataDir,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).toBe(0);
	expect(result.stdout).toBe("engine fixture ok\n");
	expect(result.stderr).toBe("");
}

describe("bundled engine entry representation", () => {
	it("executes the ordinary default through the public configuration unchanged", () => {
		const { root, runtime, entry } = engineFixture();
		const env = { GENTLE_DOT_RUNTIME: runtime, GENTLE_DOT_DATA_DIR: root };
		const config = loadConfig(env);
		expect(config.agentCommand).toBe(process.execPath);
		expect(config.agentArgs).toEqual([entry]);
		expect(bundledGentleShell(env)).toBe(entry);
		runEngine(config);
	});

	it.skipIf(process.platform !== "win32")("executes one identical entry from a verbatim runtime without changing the OS root", () => {
		const { root, runtime, entry } = engineFixture();
		const env = { GENTLE_DOT_RUNTIME: toNamespacedPath(runtime), GENTLE_DOT_DATA_DIR: root };
		const before = { ...env };
		const config = loadConfig(env);
		expect(config.agentCommand).toBe(process.execPath);
		expect(config.agentArgs).toHaveLength(1);
		expect(realpathSync.native(config.agentArgs[0]!)).toBe(realpathSync.native(entry));
		expect(bundledGentleShell(env)).toBe(config.agentArgs[0]);
		expect(agentSpawnEnv(config.agentCommand, config.agentArgs, env).GENTLE_SHELL_NO_AUTO_SETUP).toBe("1");
		expect(runtimeDir(env)).toBe(env.GENTLE_DOT_RUNTIME);
		expect(env).toEqual(before);
		// Include native failure streams in the RED receipt, not just an exit-code mismatch.
		const result = spawnSync(config.agentCommand, config.agentArgs, { encoding: "utf8", timeout: 5000 });
		expect({ exit: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error }).toEqual({
			exit: 0, stdout: "engine fixture ok\n", stderr: "", error: undefined,
		});
	});

	it.skipIf(process.platform !== "win32")("preserves custom BIN and ARGS even with an unusable verbatim runtime", () => {
		const { root, runtime } = engineFixture();
		const args = [toNamespacedPath(join(runtime, "custom script.mjs")), "a;b"];
		const env = { GENTLE_DOT_DATA_DIR: root, GENTLE_DOT_RUNTIME: toNamespacedPath(runtime + ".") };
		expect(loadConfig({ ...env, GENTLE_DOT_AGENT_BIN: "custom.exe" })).toMatchObject({
			agentCommand: "custom.exe", agentArgs: [], agentHome: join(root, "agent"),
		});
		for (const bin of [undefined, "custom.exe"]) {
			expect(loadConfig({ ...env, GENTLE_DOT_AGENT_BIN: bin, GENTLE_DOT_AGENT_ARGS: JSON.stringify(args) })).toMatchObject({
				agentCommand: bin ?? process.execPath, agentArgs: args, agentHome: undefined,
			});
		}
	});

	it.skipIf(process.platform !== "win32")("rejects a trailing-dot alias and missing ordinary representation without executing or writing", () => {
		const { root, runtime, entry } = engineFixture();
		const dotted = toNamespacedPath(runtime + ".");
		const dottedEntry = join(dotted, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
		mkdirSync(dirname(dottedEntry), { recursive: true });
		const wrongScript = 'process.stdout.write("wrong script\\n");\n';
		writeFileSync(dottedEntry, wrongScript);
		const unpaired = toNamespacedPath(join(root, "no ordinary alias."));
		const unpairedEntry = join(unpaired, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
		mkdirSync(dirname(unpairedEntry), { recursive: true });
		writeFileSync(unpairedEntry, wrongScript);
		expect(realpathSync.native(dottedEntry)).not.toBe(realpathSync.native(entry));
		expect(existsSync(join(root, "no ordinary alias"))).toBe(false);
		const original = readFileSync(entry, "utf8");
		const before = readdirSync(root, { recursive: true });
		for (const runtimeRoot of [dotted, unpaired]) {
			const env = { GENTLE_DOT_DATA_DIR: root, GENTLE_DOT_RUNTIME: runtimeRoot };
			const message = `The bundled assistant engine has no equivalent Node entry path: ${join(runtimeRoot, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs")}`;
			expect(() => loadConfig(env)).toThrow(message);
			expect(() => bundledGentleShell(env)).toThrow(message);
		}
		expect(readFileSync(entry, "utf8")).toBe(original);
		expect(readFileSync(dottedEntry, "utf8")).toBe(wrongScript);
		expect(readFileSync(unpairedEntry, "utf8")).toBe(wrongScript);
		expect(readdirSync(root, { recursive: true })).toEqual(before);
	});
});

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
		expect(config.agentArgs[0]?.replaceAll("\\", "/")).toMatch(
			/node_modules\/gentle-pi\/bin\/gentle-shell\.mjs$/,
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
		const explicitHome = join(dataDir, "h");
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_AGENT_HOME: explicitHome }).agentHome).toBe(
			explicitHome,
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
		const projects = join(dataDir, "projects");
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ port: 5000, workspace: projects }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir })).toMatchObject({
			port: 5000,
			preferredFolder: projects,
		});
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_PORT: "6000" }).port).toBe(6000);
	});

	it("keeps the engine in its own workspace and treats a custom one as the user's preferred folder", () => {
		const dataDir = tempDir();
		const preferredFolder = join(dataDir, "work", "repo");
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_WORKSPACE: preferredFolder });
		// The workspace holds the memory project setting, so the engine always works there.
		expect(config).toMatchObject({ workspace: join(dataDir, "workspace"), preferredFolder });
		const same = loadConfig({
			GENTLE_DOT_DATA_DIR: dataDir,
			GENTLE_DOT_WORKSPACE: join(dataDir, "workspace"),
		});
		expect(same.preferredFolder).toBeUndefined();
	});

	it("reads the memory mode, absent meaning the user's shared Engram", () => {
		const dataDir = tempDir();
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir }).memory).toBe("shared");
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ memory: "private" }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir }).memory).toBe("private");
	});

	it("lets GENTLE_DOT_ENGRAM win over the file, as GENTLE_DOT_PORT does for port", () => {
		const dataDir = tempDir();
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ memory: "shared" }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_ENGRAM: "private" }).memory).toBe("private");
		writeFileSync(join(dataDir, "config.json"), JSON.stringify({ memory: "private" }));
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_ENGRAM: "shared" }).memory).toBe("shared");
	});

	it("refuses an unknown memory value and leaves the file alone", () => {
		const dataDir = tempDir();
		const file = join(dataDir, "config.json");
		const written = JSON.stringify({ memory: "secret", port: 5000 });
		writeFileSync(file, written);
		expect(() => loadConfig({ GENTLE_DOT_DATA_DIR: dataDir })).toThrow(
			"Invalid memory in config.json: secret",
		);
		expect(readFileSync(file, "utf8")).toBe(written);
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

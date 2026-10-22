import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { isolatedAgentEnv } from "../src/isolation.ts";
import { resolveEngramBin } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const WINDOWS = process.platform === "win32";
const ENGRAM = WINDOWS ? "engram.exe" : "engram";
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

function touch(path: string, content = "", mode = 0o644): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}

/** An installed runtime folder (S29.5) with the engine files the daemon looks for. */
function fakeRuntime(): string {
	const runtime = tempDir();
	const modules = join(runtime, "daemon", "node_modules");
	touch(join(modules, "gentle-pi", "bin", "gentle-shell.mjs"));
	touch(join(modules, ENGINE_CLI));
	mkdirSync(join(runtime, "bin"), { recursive: true });
	touch(join(runtime, "bin", ENGRAM), "", 0o755);
	return runtime;
}

/** A login shell that answers `command -v engram` with `answer`, or fails when it is undefined. */
function fakeShell(answer: string | undefined): string {
	const body = answer === undefined ? "exit 1" : `echo "Welcome"\necho "${answer}"`;
	return touch(join(tempDir(), "shell"), `#!/bin/sh\n${body}\n`, 0o755);
}

describe("installed runtime (GENTLE_DOT_RUNTIME)", () => {
	it("serves the runtime's web UI, and GENTLE_DOT_UI_DIR still wins", () => {
		const runtime = fakeRuntime();
		const dataDir = tempDir();
		const uiDir = tempDir();
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime }).uiDir).toBe(
			join(runtime, "ui"),
		);
		expect(
			loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime, GENTLE_DOT_UI_DIR: uiDir })
				.uiDir,
		).toBe(uiDir);
	});

	it("runs the launcher and the engine's command line from the runtime's node_modules", () => {
		const runtime = fakeRuntime();
		const modules = join(runtime, "daemon", "node_modules");
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: tempDir(), GENTLE_DOT_RUNTIME: runtime });
		expect(config.agentCommand).toBe(process.execPath);
		expect(config.agentArgs).toEqual([join(modules, "gentle-pi", "bin", "gentle-shell.mjs")]);
		expect(bundledMcpCli({ GENTLE_DOT_RUNTIME: runtime })).toEqual({
			command: process.execPath,
			args: [join(modules, ENGINE_CLI)],
		});
	});

	it("never falls back to the build machine's engine when the runtime lacks it", () => {
		const runtime = tempDir();
		expect(() => loadConfig({ GENTLE_DOT_DATA_DIR: tempDir(), GENTLE_DOT_RUNTIME: runtime })).toThrow(
			join(runtime, "daemon", "node_modules"),
		);
		expect(() => bundledMcpCli({ GENTLE_DOT_RUNTIME: runtime })).toThrow("assistant engine is missing");
	});

	it("puts the runtime's `pi` first on the engine's PATH, never the pnpm one", () => {
		const runtime = fakeRuntime();
		const base = {
			PATH: [join(tempDir(), "one"), join(tempDir(), "two")].join(delimiter),
			HOME: tempDir(),
			GENTLE_DOT_RUNTIME: runtime,
			ENGRAM_BIN: touch(join(tempDir(), ENGRAM), "", 0o755),
		};
		const env = isolatedAgentEnv(base, tempDir());
		expect(env.PATH).toBe([join(runtime, "bin"), base.PATH].join(delimiter));
		const again = isolatedAgentEnv({ ...base, PATH: env.PATH }, tempDir());
		expect(again.PATH).toBe(env.PATH);
	});

	it("passes the user's ENGRAM_BIN to the engine and keeps the global memory", () => {
		const realHome = tempDir();
		const engram = touch(join(tempDir(), ENGRAM), "", 0o755);
		const env = isolatedAgentEnv(
			{
				PATH: "",
				HOME: realHome,
				USERPROFILE: realHome,
				GENTLE_DOT_RUNTIME: fakeRuntime(),
				ENGRAM_BIN: engram,
			},
			tempDir(),
		);
		expect(env).toMatchObject({ ENGRAM_BIN: engram, ENGRAM_DATA_DIR: join(realHome, ".engram") });
	});

	it("finds the user's Engram through native discovery before the bundled one", () => {
		const runtime = fakeRuntime();
		const userEngram = touch(join(tempDir(), ENGRAM), "", 0o755);
		const env = isolatedAgentEnv(
			{
				PATH: WINDOWS ? dirname(userEngram) : "/bin",
				HOME: tempDir(),
				GENTLE_DOT_RUNTIME: runtime,
				SHELL: fakeShell(userEngram),
			},
			tempDir(),
		);
		expect(env.ENGRAM_BIN).toBe(userEngram);
	});
});

describe("resolveEngramBin", () => {
	it("prefers ENGRAM_BIN, then the login PATH, then the known folders, then the runtime's own", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const known = tempDir();
		const loginEngram = touch(join(tempDir(), ENGRAM), "", 0o755);
		const failing = fakeShell(undefined);
		const options = { home, knownDirs: [join(home, "missing"), known] };
		const override = touch(join(tempDir(), ENGRAM), "", 0o755);
		expect(resolveEngramBin({ ENGRAM_BIN: override, SHELL: failing }, runtime, options)).toBe(override);
		expect(
			resolveEngramBin(
				{ PATH: WINDOWS ? dirname(loginEngram) : "", SHELL: fakeShell(loginEngram) },
				runtime,
				options,
			),
		).toBe(loginEngram);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(join(runtime, "bin", ENGRAM));
		const knownEngram = touch(join(WINDOWS ? join(home, "go", "bin") : known, ENGRAM), "", 0o755);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(knownEngram);
		// A shell answer does not bypass executable discovery on either host.
		expect(resolveEngramBin({ SHELL: fakeShell("/nowhere/engram") }, runtime, options)).toBe(knownEngram);
		if (WINDOWS)
			expect(() => resolveEngramBin({ ENGRAM_BIN: "/x/engram" }, runtime, options)).toThrow(
				"absolute Windows .exe",
			);
	});

	it("looks in ~/go/bin, Homebrew, /usr/local/bin and ~/.local/bin by default", () => {
		const home = tempDir();
		const userEngram = touch(join(home, "go", "bin", ENGRAM), "", 0o755);
		expect(resolveEngramBin({ SHELL: fakeShell(undefined) }, fakeRuntime(), { home })).toBe(userEngram);
	});
});

describe("source checkout (no GENTLE_DOT_RUNTIME)", () => {
	it("keeps the workspace UI, the pnpm engine, the pnpm `pi`, and no ENGRAM_BIN", () => {
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: tempDir() });
		expect(config.uiDir).toBe(join(PACKAGE, "..", "ui", "dist", "app"));
		expect(config.agentArgs).toEqual([join(PACKAGE, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs")]);
		expect(bundledMcpCli({}).args).toEqual([join(PACKAGE, "node_modules", ENGINE_CLI)]);
		const path = [join(tempDir(), "one"), join(tempDir(), "two")].join(delimiter);
		const env = isolatedAgentEnv({ PATH: path, HOME: tempDir() }, tempDir());
		expect(env.PATH).toBe([join(PACKAGE, "node_modules", ".bin"), path].join(delimiter));
		expect(env.ENGRAM_BIN).toBeUndefined();
	});
});

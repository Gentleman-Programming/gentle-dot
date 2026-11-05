import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { isolatedAgentEnv } from "../src/isolation.ts";
import { resolveEngramBin } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";
import { itWithPosixShell } from "./support/windows.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
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
		expect(loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime }).uiDir).toBe(
			join(runtime, "ui"),
		);
		expect(
			loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime, GENTLE_DOT_UI_DIR: "/ui" })
				.uiDir,
		).toBe(resolve("/ui"));
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
			PATH: ["/usr/bin", "/bin"].join(delimiter),
			HOME: tempDir(),
			GENTLE_DOT_RUNTIME: runtime,
			ENGRAM_BIN: "/x/engram",
		};
		const env = isolatedAgentEnv(base, tempDir());
		expect(env.PATH).toBe([join(runtime, "bin"), "/usr/bin", "/bin"].join(delimiter));
		const again = isolatedAgentEnv({ ...base, PATH: env.PATH }, tempDir());
		expect(again.PATH).toBe(env.PATH);
	});

	it("passes the user's ENGRAM_BIN to the engine and keeps the global memory", () => {
		const realHome = tempDir();
		const env = isolatedAgentEnv(
			{ PATH: "/bin", HOME: realHome, GENTLE_DOT_RUNTIME: fakeRuntime(), ENGRAM_BIN: "/x/engram" },
			tempDir(),
		);
		expect(env).toMatchObject({ ENGRAM_BIN: "/x/engram", ENGRAM_DATA_DIR: join(realHome, ".engram") });
	});

	itWithPosixShell("finds the user's Engram through the login shell before the bundled one", () => {
		const runtime = fakeRuntime();
		const userEngram = touch(join(tempDir(), "engram"), "", 0o755);
		const env = isolatedAgentEnv(
			{ PATH: "/bin", HOME: tempDir(), GENTLE_DOT_RUNTIME: runtime, SHELL: fakeShell(userEngram) },
			tempDir(),
		);
		expect(env.ENGRAM_BIN).toBe(userEngram);
	});
});

describe("resolveEngramBin", () => {
	it("finds the Windows executable without requiring POSIX executable permissions or a login shell", () => {
		const home = tempDir();
		const loginEngram = touch(join(tempDir(), "engram"), "", 0o755);
		const windowsEngram = touch(join(home, "go", "bin", "engram.exe"));
		expect(
			resolveEngramBin({ USERPROFILE: home, SHELL: fakeShell(loginEngram) }, fakeRuntime(), {
				platform: "win32",
			}),
		).toBe(windowsEngram);
	});

	it("finds the Windows user installation and keeps ENGRAM_BIN precedence", () => {
		const home = tempDir();
		const windowsEngram = touch(join(home, "AppData", "Local", "engram", "bin", "engram.exe"));
		const runtime = fakeRuntime();
		const options = { home, platform: "win32" as const };
		expect(resolveEngramBin({}, runtime, options)).toBe(windowsEngram);
		expect(resolveEngramBin({ ENGRAM_BIN: "/explicit/engram.exe" }, runtime, options)).toBe(
			"/explicit/engram.exe",
		);
	});

	it("falls back to bundled engram.exe on Windows, ignoring a login shell and non-file candidates", () => {
		const home = tempDir();
		mkdirSync(join(home, "go", "bin", "engram.exe"), { recursive: true });
		const loginEngram = touch(join(tempDir(), "engram"), "", 0o755);
		const runtime = fakeRuntime();
		expect(resolveEngramBin({ SHELL: fakeShell(loginEngram) }, runtime, { home, platform: "win32" })).toBe(
			join(runtime, "bin", "engram.exe"),
		);
	});

	itWithPosixShell(
		"prefers ENGRAM_BIN, then the login PATH, then the known folders, then the runtime's own",
		() => {
			const runtime = fakeRuntime();
			const home = tempDir();
			const known = tempDir();
			const loginEngram = touch(join(tempDir(), "engram"), "", 0o755);
			const failing = fakeShell(undefined);
			const options = { home, knownDirs: [join(home, "missing"), known] };
			expect(resolveEngramBin({ ENGRAM_BIN: "/x/engram", SHELL: failing }, runtime, options)).toBe(
				"/x/engram",
			);
			expect(resolveEngramBin({ SHELL: fakeShell(loginEngram) }, runtime, options)).toBe(loginEngram);
			expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(join(runtime, "bin", "engram"));
			const knownEngram = touch(join(known, "engram"), "", 0o755);
			expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(knownEngram);
			// A login shell answer that is not an executable file is ignored.
			expect(resolveEngramBin({ SHELL: fakeShell("/nowhere/engram") }, runtime, options)).toBe(knownEngram);
		},
	);

	it("looks in ~/go/bin, Homebrew, /usr/local/bin and ~/.local/bin by default", () => {
		const home = tempDir();
		const userEngram = touch(
			join(home, "go", "bin", process.platform === "win32" ? "engram.exe" : "engram"),
			"",
			0o755,
		);
		expect(resolveEngramBin({ SHELL: fakeShell(undefined) }, fakeRuntime(), { home })).toBe(userEngram);
	});
});

describe("source checkout (no GENTLE_DOT_RUNTIME)", () => {
	it("keeps the workspace UI, the pnpm engine, the pnpm `pi`, and no ENGRAM_BIN", () => {
		const config = loadConfig({ GENTLE_DOT_DATA_DIR: tempDir() });
		expect(config.uiDir).toBe(join(PACKAGE, "..", "ui", "dist", "app"));
		expect(config.agentArgs).toEqual([join(PACKAGE, "node_modules", "gentle-pi", "bin", "gentle-shell.mjs")]);
		expect(bundledMcpCli({}).args).toEqual([join(PACKAGE, "node_modules", ENGINE_CLI)]);
		const env = isolatedAgentEnv({ PATH: ["/usr/bin", "/bin"].join(delimiter), HOME: tempDir() }, tempDir());
		expect(env.PATH).toBe([join(PACKAGE, "node_modules", ".bin"), "/usr/bin", "/bin"].join(delimiter));
		expect(env.ENGRAM_BIN).toBeUndefined();
	});
});

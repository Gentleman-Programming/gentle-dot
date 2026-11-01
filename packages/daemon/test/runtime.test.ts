import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { isolatedAgentEnv } from "../src/isolation.ts";
import { engramBinaryName, refusalGuard, resolveEngramBin, runtimeDir } from "../src/runtime.ts";
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
		const override = join(dataDir, "ui");
		expect(
			loadConfig({ GENTLE_DOT_DATA_DIR: dataDir, GENTLE_DOT_RUNTIME: runtime, GENTLE_DOT_UI_DIR: override })
				.uiDir,
		).toBe(override);
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
		// Windows has no login shell and no `command -v`, so there is no probe to consult and the
		// runtime's own copy is used (L22, option (a)); the injected-platform test below pins that.
		if (process.platform === "win32") {
			expect(env.ENGRAM_BIN).toBe(join(runtime, "bin", "engram.exe"));
			return;
		}
		expect(env.ENGRAM_BIN).toBe(userEngram);
	});
});

describe("runtimeDir", () => {
	// Tauri hands the runtime root over canonicalized, and on Windows that is the verbatim form
	// (`\\?\C:\…`). Node's module resolver cannot take it: handed to `spawn` as the engine's
	// entry it collapses to a bare drive (`C:`) and dies with EISDIR, which is what an installed
	// copy did (W30). Win32 needs the prefix; Node does not.
	it.runIf(process.platform === "win32")("drops the verbatim prefix Windows canonical paths carry", () => {
		expect(runtimeDir({ GENTLE_DOT_RUNTIME: "\\\\?\\C:\\Users\\me\\Gentle Dot\\runtime" })).toBe(
			"C:\\Users\\me\\Gentle Dot\\runtime",
		);
	});

	it.runIf(process.platform === "win32")("turns a verbatim UNC root back into a UNC path", () => {
		expect(runtimeDir({ GENTLE_DOT_RUNTIME: "\\\\?\\UNC\\server\\share\\runtime" })).toBe(
			"\\\\server\\share\\runtime",
		);
	});

	it("leaves an ordinary root alone, and reports no runtime without one", () => {
		const root = join(process.cwd(), "runtime-stub");
		expect(runtimeDir({ GENTLE_DOT_RUNTIME: root })).toBe(root);
		expect(runtimeDir({})).toBeUndefined();
	});
});

describe("resolveEngramBin", () => {
	const hostBinary = engramBinaryName(process.platform);

	it("prefers ENGRAM_BIN, then the known folders, then the runtime's own", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const known = tempDir();
		const failing = fakeShell(undefined);
		const options = { home, knownDirs: [join(home, "missing"), known] };
		expect(resolveEngramBin({ ENGRAM_BIN: "/x/engram", SHELL: failing }, runtime, options)).toBe("/x/engram");
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(join(runtime, "bin", hostBinary));
		const knownEngram = touch(join(known, hostBinary), "", 0o755);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(knownEngram);
		// A login shell answer that is not an executable file is ignored.
		expect(resolveEngramBin({ SHELL: fakeShell("/nowhere/engram") }, runtime, options)).toBe(knownEngram);
	});

	// This one spawns a real login shell, so it can only run where one exists. The Windows
	// contract it would otherwise cover is asserted by the injected-platform test below.
	it.skipIf(process.platform === "win32")(
		"prefers the Engram the user's login shell finds, before the known folders",
		() => {
			const runtime = fakeRuntime();
			const home = tempDir();
			const known = tempDir();
			const loginEngram = touch(join(tempDir(), "engram"), "", 0o755);
			const options = { home, knownDirs: [join(home, "missing"), known] };
			expect(resolveEngramBin({ SHELL: fakeShell(loginEngram) }, runtime, options)).toBe(loginEngram);
		},
	);

	it("never asks a login shell on Windows, and looks for engram.exe there", () => {
		const runtime = fakeRuntime();
		const home = tempDir();
		const bare = tempDir();
		const wouldAnswer = touch(join(tempDir(), "engram"), "", 0o755);
		touch(join(bare, "engram"), "", 0o755);
		const options = { home, knownDirs: [bare], platform: "win32" as const };
		// A shell that would answer is never consulted, and a bare `engram` is not the file
		// Windows resolves, so with nothing to find the runtime's own copy is the answer.
		expect(resolveEngramBin({ SHELL: fakeShell(wouldAnswer) }, runtime, options)).toBe(
			join(runtime, "bin", "engram.exe"),
		);
		const winEngram = touch(join(bare, "engram.exe"), "", 0o755);
		expect(resolveEngramBin({ SHELL: fakeShell(wouldAnswer) }, runtime, options)).toBe(winEngram);
	});

	it("looks in ~/go/bin, Homebrew, /usr/local/bin and ~/.local/bin by default", () => {
		const home = tempDir();
		const userEngram = touch(join(home, "go", "bin", hostBinary), "", 0o755);
		expect(resolveEngramBin({ SHELL: fakeShell(undefined) }, fakeRuntime(), { home })).toBe(userEngram);
	});

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
});

describe("refusalGuard", () => {
	// The POSIX guard ships as a `#!/bin/sh` script. On Windows that file exists and still cannot
	// be started, so the provider used to fail with "could not be found" instead of reporting that
	// memory was off. The runtime's own guard takes its place, and the refusal becomes a refusal.
	it("replaces an ENGRAM_BIN that exists but this platform cannot start", () => {
		const runtime = fakeRuntime();
		const inherited = touch(join(tempDir(), "engram-guard"), "#!/bin/sh\nexit 78\n", 0o755);
		const guard = touch(join(runtime, "bin", "engram-guard.exe"), "");
		expect(refusalGuard({ ENGRAM_BIN: inherited }, runtime, { platform: "win32" })).toBe(guard);
	});

	it("keeps an ENGRAM_BIN this platform can start, and adds nothing without one", () => {
		const runtime = fakeRuntime();
		const exe = touch(join(tempDir(), "engram.exe"), "");
		touch(join(runtime, "bin", "engram-guard.exe"), "");
		expect(refusalGuard({ ENGRAM_BIN: exe }, runtime, { platform: "win32" })).toBeUndefined();
		expect(refusalGuard({}, runtime, { platform: "win32" })).toBeUndefined();
	});

	// A path that is not there is a different problem, and the provider's own message names it
	// better than a refusal would: substituting here would hide a typo behind "memory disabled".
	it("leaves an ENGRAM_BIN that does not exist for the provider to report", () => {
		const runtime = fakeRuntime();
		touch(join(runtime, "bin", "engram-guard.exe"), "");
		expect(
			refusalGuard({ ENGRAM_BIN: join(tempDir(), "missing", "engram.exe") }, runtime, { platform: "win32" }),
		).toBeUndefined();
	});

	// POSIX starts a shebang script, so there is nothing to replace: this is the contract that must
	// not change for macOS and Linux.
	it("leaves an executable script alone on POSIX", () => {
		const runtime = fakeRuntime();
		const inherited = touch(join(tempDir(), "engram"), "#!/bin/sh\nexit 78\n", 0o755);
		touch(join(runtime, "bin", "engram-guard"), "");
		expect(refusalGuard({ ENGRAM_BIN: inherited }, runtime, { platform: "linux" })).toBeUndefined();
	});

	it("adds nothing when the runtime ships no guard (a source checkout)", () => {
		const runtime = fakeRuntime();
		const inherited = touch(join(tempDir(), "engram-guard"), "#!/bin/sh\nexit 78\n", 0o755);
		expect(refusalGuard({ ENGRAM_BIN: inherited }, runtime, { platform: "win32" })).toBeUndefined();
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

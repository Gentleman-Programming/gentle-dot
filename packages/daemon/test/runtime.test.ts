import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { bundledMcpCli } from "../src/connectors.ts";
import { isolatedAgentEnv } from "../src/isolation.ts";
import { engramBinaryName, refusalGuard, resolveEngramBin, runtimeDir } from "../src/runtime.ts";
import { tempDir } from "./helpers.ts";
import { hasPosixModes } from "./support/posix-modes.ts";

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

	it.skipIf(process.platform !== "win32")("bridges both bundled Node entries without changing the native runtime root", () => {
		const runtime = toNamespacedPath(fakeRuntime());
		const env = { GENTLE_DOT_DATA_DIR: tempDir(), GENTLE_DOT_RUNTIME: runtime };
		const engine = loadConfig(env).agentArgs[0]!;
		const mcp = bundledMcpCli(env);
		expect(runtimeDir(env)).toBe(runtime);
		expect(engine.startsWith("\\\\?\\")).toBe(false);
		expect(mcp.command).toBe(process.execPath);
		expect(mcp.args).toHaveLength(1);
		expect(mcp.args[0]!.startsWith("\\\\?\\")).toBe(false);
		expect(realpathSync.native(mcp.args[0]!)).toBe(realpathSync.native(join(runtime, "daemon", "node_modules", ENGINE_CLI)));
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

describe("runtimeDir", () => {
	// Tauri hands the runtime root over canonicalized, and on Windows that is the verbatim form
	// (`\\?\C:\…`). Node's module resolver cannot take it: handed to `spawn` as the engine's
	// entry it collapses to a bare drive (`C:`) and dies with EISDIR, which is what an installed
	// copy did (W30). Win32 needs the prefix; Node does not.
	it.runIf(process.platform === "win32")("preserves the verbatim Windows runtime identity", () => {
		expect(runtimeDir({ GENTLE_DOT_RUNTIME: "\\\\?\\C:\\Users\\me\\Gentle Dot\\runtime" })).toBe(
			"\\\\?\\C:\\Users\\me\\Gentle Dot\\runtime",
		);
	});

	it.runIf(process.platform === "win32")("preserves a verbatim UNC runtime identity", () => {
		expect(runtimeDir({ GENTLE_DOT_RUNTIME: "\\\\?\\UNC\\server\\share\\runtime" })).toBe(
			"\\\\?\\UNC\\server\\share\\runtime",
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
		const knownEngram = touch(join(known, ENGRAM), "", 0o755);
		expect(resolveEngramBin({ SHELL: failing }, runtime, options)).toBe(knownEngram);
		// A shell answer does not bypass executable discovery on either host.
		expect(resolveEngramBin({ SHELL: fakeShell("/nowhere/engram") }, runtime, options)).toBe(knownEngram);
		if (WINDOWS)
			expect(() => resolveEngramBin({ ENGRAM_BIN: "/x/engram" }, runtime, options)).toThrow(
				"absolute Windows .exe",
			);
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
		const explicit = touch(join(tempDir(), "engram.exe"));
		expect(resolveEngramBin({ ENGRAM_BIN: explicit }, runtime, options)).toBe(explicit);
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

	// On main a non-executable ENGRAM_BIN reaches the provider, which names it; swapping it for the
	// guard on POSIX hid the user's own mistake behind "memory disabled".
	it("never substitutes the guard for an ENGRAM_BIN that exists but is not executable on POSIX", () => {
		const runtime = fakeRuntime();
		const inherited = touch(join(tempDir(), "engram"), "", 0o644);
		touch(join(runtime, "bin", "engram-guard"), "");
		for (const platform of ["linux", "darwin"] as const) {
			expect(
				refusalGuard({ ENGRAM_BIN: inherited }, runtime, { platform, startable: () => false }),
			).toBeUndefined();
		}
	});

	it.skipIf(!hasPosixModes())(
		"passes a non-executable ENGRAM_BIN to the engine unchanged and says so in the log",
		() => {
			const runtime = fakeRuntime();
			touch(join(runtime, "bin", "engram-guard"), "#!/bin/sh\nexit 78\n", 0o755);
			const inherited = touch(join(tempDir(), "engram"), "", 0o644);
			const lines: string[] = [];
			const env = isolatedAgentEnv(
				{ PATH: "/bin", HOME: tempDir(), GENTLE_DOT_RUNTIME: runtime, ENGRAM_BIN: inherited },
				tempDir(),
				undefined,
				(line) => lines.push(line),
				{ platform: "linux" },
			);
			expect(env.ENGRAM_BIN).toBe(inherited);
			expect(lines).toEqual([
				`ENGRAM_BIN (${inherited}) exists but cannot be started here; it is passed to the engine unchanged and Engram will report it`,
			]);
		},
	);

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
		const path = [join(tempDir(), "one"), join(tempDir(), "two")].join(delimiter);
		const env = isolatedAgentEnv({ PATH: path, HOME: tempDir() }, tempDir());
		expect(env.PATH).toBe([join(PACKAGE, "node_modules", ".bin"), path].join(delimiter));
		expect(env.ENGRAM_BIN).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { daemonSourceRevision, installerEnv, pnpmInvocation, windowsBuildGo } from "../lib.mjs";

describe("Windows staging install", () => {
	it("admits only explicitly provisioned Go and adds only its directory to installer PATH", () => {
		const source = {
			SystemRoot: "C:\\Windows",
			GENTLE_DOT_BUILD_GO: "C:\\Program Files\\Go\\bin\\go.exe",
			PATH: "C:\\private-tools",
			SECRET: "omit",
		};
		expect(windowsBuildGo(source, () => true)).toBe(source.GENTLE_DOT_BUILD_GO);
		const usage =
			"GENTLE_DOT_BUILD_GO must be the full path of the real go.exe in GOROOT\\bin (not a Scoop or Chocolatey shim), such as C:\\Program Files\\Go\\bin\\go.exe.";
		expect(() => windowsBuildGo({}, () => true)).toThrow(usage);
		expect(() => windowsBuildGo(source, () => false)).toThrow(
			"GENTLE_DOT_BUILD_GO names C:\\Program Files\\Go\\bin\\go.exe, which is not an existing file.",
		);
		for (const value of ["go.exe", "C:\\tools;other\\go.exe", "C:\\tools\\other.exe"]) {
			expect(() => windowsBuildGo({ GENTLE_DOT_BUILD_GO: value }, () => true)).toThrow(usage);
		}
		const env = installerEnv("C:\\stage", "C:\\cache", "win-x64", source, source.GENTLE_DOT_BUILD_GO);
		expect(env.PATH).toBe(
			"C:\\stage\\node\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Go\\bin",
		);
		expect(env.SECRET).toBeUndefined();
		expect(env.GENTLE_DOT_BUILD_GO).toBeUndefined();
		expect(source.PATH).toBe("C:\\private-tools");
	});

	it("isolates Windows installer homes, preserving only system and temporary paths", () => {
		const source = {
			Path: "C:\\untrusted",
			SystemRoot: "C:\\Windows",
			TEMP: "C:\\Temp",
			SECRET: "omit",
			GITHUB_TOKEN: "omit",
			NPM_TOKEN: "omit",
		};
		const before = { ...source };
		for (const target of ["win-x64", "win-arm64"]) {
			const env = installerEnv("C:\\stage & space", "C:\\cache", target, source);
			expect(env.PATH).toBe("C:\\stage & space\\node\\bin;C:\\Windows\\System32;C:\\Windows");
			expect(env).toMatchObject({
				HOME: "C:\\cache\\npm-home",
				USERPROFILE: "C:\\cache\\npm-home",
				LOCALAPPDATA: "C:\\cache\\npm-home\\AppData\\Local",
				APPDATA: "C:\\cache\\npm-home\\AppData\\Roaming",
				SystemRoot: "C:\\Windows",
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				TEMP: "C:\\Temp",
				TMP: "C:\\Temp",
				npm_config_userconfig: "C:\\cache\\npmrc",
				npm_config_cache: "C:\\cache\\npm-cache",
			});
			// Postinstall scripts must not inherit credentials from the build machine.
			expect(env.SECRET).toBeUndefined();
			expect(env.GITHUB_TOKEN).toBeUndefined();
			expect(env.NPM_TOKEN).toBeUndefined();
			expect(env.Path).toBeUndefined();
			expect(Object.keys(env).sort()).toEqual(
				[
					"APPDATA",
					"ComSpec",
					"HOME",
					"LOCALAPPDATA",
					"PATH",
					"SystemRoot",
					"TEMP",
					"TMP",
					"USERPROFILE",
					"npm_config_cache",
					"npm_config_registry",
					"npm_config_update_notifier",
					"npm_config_userconfig",
				].sort(),
			);
		}
		expect(source).toEqual(before);
		expect(installerEnv("C:\\stage", "C:\\cache", "win-x64", { SYSTEMROOT: "C:\\Windows" }).TEMP).toBe(
			"C:\\cache\\npm-home\\Temp",
		);
		expect(() => installerEnv("C:\\stage", "C:\\cache", "win-x64", {})).toThrow(/SystemRoot/);
	});

	it("keeps the POSIX whitelist as it was", () => {
		expect(installerEnv("/stage", "/cache", "linux-x64", { GITHUB_TOKEN: "omit" })).toEqual({
			HOME: "/cache/npm-home",
			PATH: "/stage/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			TMPDIR: "/tmp",
			npm_config_userconfig: "/cache/npmrc",
			npm_config_cache: "/cache/npm-cache",
			npm_config_registry: "https://registry.npmjs.org/",
			npm_config_update_notifier: "false",
		});
		expect(installerEnv("/stage", "/cache", "darwin-arm64", { TMPDIR: "/var/tmp/x" }).TMPDIR).toBe(
			"/var/tmp/x",
		);
	});
});

describe("pnpm invocation", () => {
	const args = ["--filter", "@gentle-dot/ui", "build"];

	it("runs pnpm's own JavaScript entry through Node on Windows, never a .cmd shim", () => {
		expect(
			pnpmInvocation(args, "win32", { npm_execpath: "C:\\tools & space\\pnpm.cjs" }, "C:\\Node\\node.exe"),
		).toEqual({ command: "C:\\Node\\node.exe", args: ["C:\\tools & space\\pnpm.cjs", ...args] });
	});

	it("refuses to guess when Windows staging was not started through pnpm", () => {
		expect(() => pnpmInvocation(args, "win32", { npm_execpath: "pnpm.cmd" })).toThrow(/pnpm/);
		expect(() => pnpmInvocation(args, "win32", {})).toThrow(/npm_execpath/);
	});

	it("keeps the plain pnpm command elsewhere", () => {
		expect(pnpmInvocation(args, "linux", {})).toEqual({ command: "pnpm", args });
		expect(pnpmInvocation(args, "darwin", {})).toEqual({ command: "pnpm", args });
	});
});

describe("daemon source revision", () => {
	const noGit = () => {
		throw new Error("must not invoke git for a snapshot");
	};

	it("labels a Windows tree without .git as unversioned, and refuses that label in CI", () => {
		expect(daemonSourceRevision("C:\\snapshot", "win32", () => false, noGit, "")).toBe(
			"snapshot-unversioned",
		);
		for (const ci of ["true", "1"])
			expect(() => daemonSourceRevision("C:\\snapshot", "win32", () => false, noGit, ci)).toThrow(
				"CI must stage from a Git checkout: C:\\snapshot has no .git, so the runtime would have no daemon commit.",
			);
	});

	it("keeps the Git revision and the dirty marker wherever .git exists", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			const calls: unknown[] = [];
			const git = (command: string, args: string[], options: unknown) => {
				calls.push([command, args, options]);
				return args[0] === "rev-parse" ? "abc123\n" : " M packages/daemon/src/cli.ts\n";
			};
			expect(daemonSourceRevision("/repo", platform, () => true, git, "true")).toBe("abc123-dirty");
			expect(calls).toEqual([
				["git", ["rev-parse", "HEAD"], { cwd: "/repo", encoding: "utf8" }],
				["git", ["status", "--porcelain", "--", "packages"], { cwd: "/repo", encoding: "utf8" }],
			]);
			const clean = (_command: string, args: string[]) => (args[0] === "rev-parse" ? "abc123\n" : "");
			expect(daemonSourceRevision("/repo", platform, () => true, clean, "")).toBe("abc123");
		}
	});

	it("keeps the Git revision on POSIX even without .git, as the stager did before", () => {
		const git = (_command: string, args: string[]) => (args[0] === "rev-parse" ? "def456\n" : "");
		expect(daemonSourceRevision("/repo", "linux", () => false, git, "")).toBe("def456");
	});
});

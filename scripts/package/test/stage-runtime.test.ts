import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	daemonSourceRevision,
	engramArchiveName,
	installerEnv,
	pnpmInvocation,
	WINDOWS_RUNTIME_FILES,
	windowsBuildGo,
} from "../lib.mjs";

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

describe("Windows Engram archive", () => {
	const line = (name: string) => `${"a".repeat(64)}  ${name}`;

	it("takes the one archive format the release checksum list names, ZIP or tar.gz", () => {
		for (const target of ["win-x64", "win-arm64"]) {
			const arch = target === "win-x64" ? "amd64" : "arm64";
			for (const extension of ["zip", "tar.gz"]) {
				const name = `engram_3.2.1_windows_${arch}.${extension}`;
				expect(engramArchiveName("3.2.1", target, `${line(name)}\n`)).toBe(name);
			}
		}
	});

	it("refuses a checksum list with none or both formats", () => {
		const usage = /exactly one supported archive in the release checksum list/;
		expect(() => engramArchiveName("3.2.1", "win-x64", "")).toThrow(usage);
		expect(() => engramArchiveName("3.2.1", "win-x64", line("engram_3.2.1_linux_amd64.tar.gz"))).toThrow(
			usage,
		);
		const both = ["zip", "tar.gz"].map((ext) => line(`engram_3.2.1_windows_amd64.${ext}`)).join("\n");
		expect(() => engramArchiveName("3.2.1", "win-x64", both)).toThrow(usage);
	});

	it("leaves the other targets on their tar.gz, whatever the list says", () => {
		expect(engramArchiveName("3.2.1", "linux-x64", "")).toBe("engram_3.2.1_linux_amd64.tar.gz");
		expect(engramArchiveName("3.2.1", "darwin-arm64", line("engram_3.2.1_darwin_arm64.zip"))).toBe(
			"engram_3.2.1_darwin_arm64.tar.gz",
		);
	});
});

// `WINDOWS_RUNTIME_FILES` is a constant: nothing else stops a stage from dropping a file it lists.
// Each listed path names the stage functions that produce it and the statement in each that does,
// read from their source the way windows-layout.test.ts reads launch.rs (the stager runs `main()`
// on import, so it cannot be imported here).
describe("Windows runtime files against the stages that build them", () => {
	const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
	const sources = {
		stager: read("../stage-runtime.mjs"),
		lib: read("../lib.mjs"),
		daemonBuild: read("../../../packages/daemon/src/runtime-build.ts"),
	};
	type Source = keyof typeof sources;

	/** The text of a top-level `function name(...) { ... }`, up to its closing brace at column 0. */
	function functionBody(source: string, name: string): string {
		const start = new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m").exec(source);
		if (!start) throw new Error(`no top-level function ${name}`);
		const end = source.indexOf("\n}\n", start.index);
		return source.slice(start.index, end < 0 ? undefined : end);
	}

	/** A stage function, and the statement in it that puts the file in the runtime. */
	const PRODUCERS: Record<string, [Source, string, string][]> = {
		"node/bin/node.exe": [
			["stager", "stageNode", "layoutWindowsNode("],
			["lib", "layoutWindowsNode", 'join(node, "bin", "node.exe")'],
		],
		"daemon/cli.mjs": [
			["stager", "main", '"build:runtime"'],
			["daemonBuild", "buildRuntime", 'join(daemon, "cli.mjs")'],
		],
		"daemon/package.json": [["daemonBuild", "buildRuntime", 'join(daemon, "package.json")']],
		"daemon/native/windows-stop.node": [
			["daemonBuild", "buildRuntime", 'join(daemon, "native", "windows-stop.node")'],
		],
		"daemon/node_modules/gentle-pi/package.json": [
			["stager", "main", "installDaemonModules("],
			["stager", "installDaemonModules", '"install"'],
		],
		"bin/engram.exe": [
			["stager", "main", "stageEngram("],
			["stager", "stageEngram", 'join(out, "bin", binaryName)'],
		],
		"bin/pi.cmd": [["daemonBuild", "buildRuntime", 'join(outDir, "bin", "pi.cmd")']],
		"ui/index.html": [["stager", "main", 'join(out, "ui")']],
	};

	/** What keeps a path from being produced: the producers it lacks, or the statements that are gone. */
	function unproduced(files: readonly string[], producers = PRODUCERS): string[] {
		return files.flatMap((file) => {
			const stages = producers[file];
			if (!stages) return [`${file}: no stage function is named for it`];
			return stages
				.filter(([source, fn, marker]) => !functionBody(sources[source], fn).includes(marker))
				.map(([, fn, marker]) => `${file}: ${fn} no longer has ${marker}`);
		});
	}

	it("names a producing stage for every listed file, and every statement is still there", () => {
		expect(unproduced(WINDOWS_RUNTIME_FILES)).toEqual([]);
		expect(Object.keys(PRODUCERS).sort()).toEqual([...WINDOWS_RUNTIME_FILES].sort());
	});

	it("notices a listed file no stage produces, and a stage that stopped producing one", () => {
		expect(unproduced(["bin/new-tool.exe"])).toEqual(["bin/new-tool.exe: no stage function is named for it"]);
		expect(
			unproduced(["bin/pi.cmd"], { "bin/pi.cmd": [["daemonBuild", "buildRuntime", "not-written.cmd"]] }),
		).toEqual(["bin/pi.cmd: buildRuntime no longer has not-written.cmd"]);
	});

	it("builds the daemon's gentle-pi dependency and the web UI's index.html into the places staged", () => {
		const daemon = JSON.parse(read("../../../packages/daemon/package.json"));
		expect(Object.keys(daemon.dependencies)).toContain("gentle-pi");
		expect(read("../../../packages/ui/vite.config.ts")).toContain('outDir: "dist/app"');
		expect(sources.stager).toContain('join(REPO, "packages", "ui", "dist", "app")');
		expect(read("../../../packages/ui/index.html")).toContain("<html");
	});
});

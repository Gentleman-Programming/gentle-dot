import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertHostTarget,
	buildManifest,
	checksumFor,
	daemonSourceRevision,
	engramArchiveName,
	engramReleaseVersion,
	gentleAiIntegritySummary,
	hostTarget,
	installerEnv,
	nodeArchiveName,
	nodeExtractionPlan,
	nodeVersion,
	npmWrapper,
	parseArgs,
	pnpmInvocation,
	renameWhenReleased,
	symlinksIn,
	treeSize,
	verifyChecksum,
	versionFromReleaseUrl,
	windowsBuildGo,
} from "../lib.mjs";

describe("parseArgs", () => {
	it("reads the target, the output folder, and an Engram version, ignoring pnpm's --", () => {
		expect(
			parseArgs(["--", "--target", "linux-x64", "--out", "/tmp/r", "--engram-version", "3.2.1"]),
		).toEqual({ target: "linux-x64", out: "/tmp/r", engramVersion: "3.2.1" });
	});

	it("refuses a missing or unknown target, unknown flags, and a flag without a value", () => {
		expect(() => parseArgs(["--out", "/tmp/r"])).toThrow(/Missing --target/);
		expect(() => parseArgs(["--target", "windows-arm64"])).toThrow(/Unknown target windows-arm64/);
		expect(() => parseArgs(["--target", "linux-x64", "--force", "1"])).toThrow(/Unexpected argument --force/);
		expect(() => parseArgs(["--target", "--out", "/tmp/r"])).toThrow(/Unexpected argument --target/);
		expect(() => parseArgs(["--target", "linux-x64", "--engram-version", "latest"])).toThrow(/x\.y\.z/);
	});
});

describe("host target", () => {
	it("maps Node's platform and arch to a target", () => {
		expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
		expect(hostTarget("linux", "x64")).toBe("linux-x64");
		expect(hostTarget("darwin", "x64")).toBeUndefined();
		expect(hostTarget("win32", "x64")).toBe("windows-x64");
		expect(parseArgs(["--target", "windows-x64"]).target).toBe("windows-x64");
		expect(() => assertHostTarget("windows-x64", "linux-x64")).toThrow(/Cannot stage/);
	});

	it("refuses to stage another platform's runtime, naming the way out", () => {
		expect(() => assertHostTarget("darwin-arm64", "darwin-arm64")).not.toThrow();
		expect(() => assertHostTarget("linux-arm64", "darwin-arm64")).toThrow(
			/Cannot stage linux-arm64 on darwin-arm64.*inside a container/,
		);
	});
});

describe("versions and asset names", () => {
	it("uses an exact .nvmrc, else the pinned release of the same major", () => {
		expect(nodeVersion("24.9.0\n")).toBe("24.9.0");
		expect(nodeVersion("v24", "24.14.1")).toBe("24.14.1");
		expect(() => nodeVersion("22", "24.14.1")).toThrow(/Node 22/);
	});

	it("names the official archives", () => {
		expect(nodeArchiveName("24.14.1", "linux-x64")).toBe("node-v24.14.1-linux-x64.tar.gz");
		expect(engramArchiveName("3.2.1", "linux-x64")).toBe("engram_3.2.1_linux_amd64.tar.gz");
		expect(engramArchiveName("3.2.1", "darwin-arm64")).toBe("engram_3.2.1_darwin_arm64.tar.gz");
	});

	it("takes a release version from `engram version`, not a development build", () => {
		expect(engramReleaseVersion("engram 3.2.1\n")).toBe("3.2.1");
		expect(engramReleaseVersion("engram v3.1.0")).toBe("3.1.0");
		expect(engramReleaseVersion("engram 3.0.0-20261007205017-8e525e767d69")).toBeUndefined();
		expect(engramReleaseVersion("")).toBeUndefined();
	});

	it("reads the version of a release URL", () => {
		expect(versionFromReleaseUrl("https://github.com/o/engram/releases/tag/v3.2.1")).toBe("3.2.1");
		expect(() => versionFromReleaseUrl("https://github.com/o/engram/releases")).toThrow(/Not a release URL/);
	});
});

describe("checksums", () => {
	const hello = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
	const listing = `${"a".repeat(64)}  node-v24.14.1-linux-x64.tar.gz\n${hello}  hello.txt\n${"b".repeat(64)} *bin.zip\n`;

	it("finds a file's entry in SHASUMS256 / checksums.txt listings", () => {
		expect(checksumFor(listing, "hello.txt")).toBe(hello);
		expect(checksumFor(listing, "bin.zip")).toBe("b".repeat(64));
		expect(() => checksumFor(listing, "node-v24.14.1-linux-x64.tar")).toThrow(/no entry/);
	});

	it("accepts a matching file and rejects a tampered one", async () => {
		const dir = mkdtempSync(join(tmpdir(), "stage-runtime-"));
		const file = join(dir, "hello.txt");
		writeFileSync(file, "hello");
		await expect(verifyChecksum(file, hello)).resolves.toBeUndefined();
		writeFileSync(file, "hellO");
		await expect(verifyChecksum(file, hello)).rejects.toThrow(/Checksum mismatch/);
	});
});

describe("Windows staging downloads", () => {
	it("extracts the official Node ZIP and normalizes its layout without changing Unix", () => {
		expect(nodeArchiveName("24.14.1", "windows-x64")).toBe("node-v24.14.1-win-x64.zip");
		expect(nodeExtractionPlan("24.14.1", "windows-x64")).toEqual({
			flag: "-xf",
			members: [
				"node-v24.14.1-win-x64/node.exe",
				"node-v24.14.1-win-x64/node_modules/npm",
				"node-v24.14.1-win-x64/LICENSE",
			],
			moves: [
				["node.exe", "bin/node.exe"],
				["node_modules", "lib/node_modules"],
			],
		});
		expect(nodeExtractionPlan("24.14.1", "linux-x64")).toEqual({
			flag: "-xzf",
			members: [
				"node-v24.14.1-linux-x64/bin/node",
				"node-v24.14.1-linux-x64/lib/node_modules/npm",
				"node-v24.14.1-linux-x64/LICENSE",
			],
			moves: [],
		});
	});

	describe("renaming a folder Windows briefly holds after extraction", () => {
		const locked = (code: string) =>
			Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
		// A clock the fake sleep advances, so the deadline is exercised without waiting.
		const clock = () => {
			const state = { now: 0, slept: [] as number[] };
			return {
				state,
				now: () => state.now,
				sleep: (ms: number) => {
					state.slept.push(ms);
					state.now += ms;
				},
			};
		};

		it("retries a lock error until the folder is released", () => {
			const { state, now, sleep } = clock();
			const calls: string[][] = [];
			const rename = (from: string, to: string) => {
				calls.push([from, to]);
				if (calls.length <= 2) throw locked(calls.length === 1 ? "EPERM" : "EBUSY");
			};
			renameWhenReleased("node/node_modules", "node/lib/node_modules", { rename, sleep, now });
			expect(calls).toEqual(Array(3).fill(["node/node_modules", "node/lib/node_modules"]));
			expect(state.slept).toEqual([500, 500]);
		});

		it("gives up with the original error once the lock outlasts the limit", () => {
			const { state, now, sleep } = clock();
			let attempts = 0;
			const rename = () => {
				attempts += 1;
				throw locked("EACCES");
			};
			expect(() => renameWhenReleased("a", "b", { rename, sleep, now, timeoutMs: 2_000 })).toThrow(
				"EACCES: operation not permitted, rename",
			);
			expect(attempts).toBe(5);
			expect(state.now).toBe(2_000);
		});

		it("does not retry other errors", () => {
			const { state, now, sleep } = clock();
			const rename = () => {
				throw Object.assign(new Error("ENOENT: no such file or directory, rename"), { code: "ENOENT" });
			};
			expect(() => renameWhenReleased("a", "b", { rename, sleep, now })).toThrow("ENOENT");
			expect(state.slept).toEqual([]);
		});
	});

	it("requires checksum-list evidence for the Windows Engram archive format", () => {
		expect(() => engramArchiveName("3.2.1", "windows-x64")).toThrow(/checksum/);
		for (const extension of ["zip", "tar.gz"]) {
			const name = `engram_3.2.1_windows_amd64.${extension}`;
			expect(engramArchiveName("3.2.1", "windows-x64", `${"a".repeat(64)}  ${name}\n`)).toBe(name);
		}
		expect(() => engramArchiveName("3.2.1", "windows-x64", "")).toThrow(/checksum/);
		const ambiguous = ["zip", "tar.gz"]
			.map((ext) => `${"b".repeat(64)}  engram_3.2.1_windows_amd64.${ext}`)
			.join("\n");
		expect(() => engramArchiveName("3.2.1", "windows-x64", ambiguous)).toThrow(/exactly one/);
	});

	it("writes a Windows npm.cmd for the bundled npm and keeps the Unix script", () => {
		expect(npmWrapper("npm-cli.js", "win32")).toContain(
			'"%~dp0node.exe" "%~dp0..\\lib\\node_modules\\npm\\bin\\npm-cli.js" %*',
		);
		expect(npmWrapper("npm-cli.js")).toContain('exec "$bin/node"');
	});
});

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
		const env = installerEnv("C:\\stage", "C:\\cache", "windows-x64", source, source.GENTLE_DOT_BUILD_GO);
		expect(env.PATH).toBe(
			"C:\\stage\\node\\bin;C:\\Windows\\System32;C:\\Windows;C:\\Program Files\\Go\\bin",
		);
		expect(env.SECRET).toBeUndefined();
		expect(env.GENTLE_DOT_BUILD_GO).toBeUndefined();
		expect(source.PATH).toBe("C:\\private-tools");
	});

	it("reports source-build module integrity separately from downloaded archive integrity", () => {
		expect(
			gentleAiIntegritySummary({
				version: "4.0.0",
				method: "go-sumdb-source-build",
				package: "example/cmd/tool",
				tag: "v4.0.0",
				moduleChecksum: "h1:synthetic",
				binarySha256: "abc",
				goVersion: "go1.25.10",
			}),
		).toBe(
			"gentle-ai 4.0.0 via go-sumdb-source-build example/cmd/tool@v4.0.0 (module checksum h1:synthetic; binary sha256 abc; Go go1.25.10)",
		);
		expect(gentleAiIntegritySummary({ version: "4.0.0", asset: "unix.tar.gz", assetSha256: "def" })).toBe(
			"gentle-ai 4.0.0 from unix.tar.gz (sha256 def)",
		);
	});

	it("isolates Windows installer homes, preserving only system and temporary paths", () => {
		const source = { Path: "C:\\untrusted", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", SECRET: "omit" };
		const before = { ...source };
		const env = installerEnv("C:\\stage & space", "C:\\cache", "windows-x64", source);
		expect(env.PATH).toBe("C:\\stage & space\\node\\bin;C:\\Windows\\System32;C:\\Windows");
		expect(env).toMatchObject({
			HOME: "C:\\cache\\npm-home",
			USERPROFILE: "C:\\cache\\npm-home",
			LOCALAPPDATA: "C:\\cache\\npm-home\\AppData\\Local",
			APPDATA: "C:\\cache\\npm-home\\AppData\\Roaming",
			SystemRoot: "C:\\Windows",
			TEMP: "C:\\Temp",
			TMP: "C:\\Temp",
		});
		expect(env.SECRET).toBeUndefined();
		expect(source).toEqual(before);
		expect(installerEnv("/stage", "/cache", "linux-x64", {})).toEqual({
			HOME: "/cache/npm-home",
			PATH: "/stage/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
			TMPDIR: "/tmp",
			npm_config_userconfig: "/cache/npmrc",
			npm_config_cache: "/cache/npm-cache",
			npm_config_registry: "https://registry.npmjs.org/",
			npm_config_update_notifier: "false",
		});
		expect(installerEnv("C:\\stage", "C:\\cache", "windows-x64", { SYSTEMROOT: "C:\\Windows" }).TEMP).toBe(
			"C:\\cache\\npm-home\\Temp",
		);
		expect(() => installerEnv("C:\\stage", "C:\\cache", "windows-x64", {})).toThrow(/SystemRoot/);
	});

	it("invokes pnpm through Node, not a Windows command shell or .cmd spawn", () => {
		const args = ["--out", "C:\\space & %PATH%"];
		expect(
			pnpmInvocation(args, "win32", { npm_execpath: "C:\\tools & space\\pnpm.cjs" }, "C:\\Node\\node.exe"),
		).toEqual({ command: "C:\\Node\\node.exe", args: ["C:\\tools & space\\pnpm.cjs", ...args] });
		expect(() => pnpmInvocation(args, "win32", { npm_execpath: "pnpm.cmd" })).toThrow(/pnpm/);
		expect(pnpmInvocation(args, "linux", {})).toEqual({ command: "pnpm", args });
	});
	it("labels Windows snapshots honestly while retaining Git revision and dirty detection", () => {
		const noGit = () => {
			throw new Error("must not invoke git for a snapshot");
		};
		// A local copy without .git is labeled; CI (any value of CI) refuses to lose the commit.
		expect(daemonSourceRevision("C:\\snapshot", "win32", () => false, noGit, "")).toBe(
			"snapshot-unversioned",
		);
		for (const ci of ["true", "1"])
			expect(() => daemonSourceRevision("C:\\snapshot", "win32", () => false, noGit, ci)).toThrow(
				"CI must stage from a Git checkout: C:\\snapshot has no .git, so the runtime would have no daemon commit.",
			);
		for (const platform of ["linux", "darwin", "win32"]) {
			const calls: unknown[] = [];
			const git = (command, args, options) => {
				calls.push([command, args, options]);
				return args[0] === "rev-parse" ? "abc123\n" : " M packages/daemon/src/cli.ts\n";
			};
			expect(daemonSourceRevision("/repo", platform, () => true, git, "true")).toBe("abc123-dirty");
			expect(calls).toEqual([
				["git", ["rev-parse", "HEAD"], { cwd: "/repo", encoding: "utf8" }],
				["git", ["status", "--porcelain", "--", "packages"], { cwd: "/repo", encoding: "utf8" }],
			]);
			expect(
				daemonSourceRevision(
					"/repo",
					platform,
					() => true,
					(_cmd, args) => (args[0] === "rev-parse" ? "abc123\n" : ""),
				),
			).toBe("abc123");
		}
		expect(() => daemonSourceRevision("/repo", "linux", () => false, noGit)).toThrow();
	});
});

describe("tree and manifest", () => {
	it("sizes a tree without following links, and lists the links", () => {
		const dir = mkdtempSync(join(tmpdir(), "stage-runtime-"));
		writeFileSync(join(dir, "a"), "12345");
		symlinkSync("a", join(dir, "link"));
		expect(treeSize(dir)).toBe(5 + 1);
		expect(symlinksIn(dir)).toEqual(["link"]);
	});

	it("records the versions, the commit, and the size", () => {
		const manifest = buildManifest({
			target: "darwin-arm64",
			versions: { node: "24.14.1", engram: "3.2.1", gentlePi: "4.0.0" },
			daemonCommit: "abc123",
			sizeBytes: 3 * 1024 * 1024,
			stagedAt: "2026-10-09T00:00:00.000Z",
		});
		expect(manifest).toMatchObject({ name: "gentle-dot-runtime", size: "3.0 MB", daemonCommit: "abc123" });
		expect(() =>
			buildManifest({
				target: "darwin-arm64",
				versions: { node: "24.14.1" },
				daemonCommit: "x",
				sizeBytes: 0,
			}),
		).toThrow(/engram/);
	});
});

// Dependency-free integration preservation checks. No native build, installation,
// provider, credential-store access, or filesystem fixture is executed here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lockedDependencies, lockedEnginePackages, runtimeWindowsStopArtifact } from "../../../packages/daemon/src/runtime-build.ts";
import { resolveWindowsEngram, windowsUserHome } from "../../../packages/daemon/src/windows-runtime.ts";
import { runtimeDir } from "../../../packages/daemon/src/runtime.ts";
import { agentSpawnEnv } from "../../../packages/daemon/src/config.ts";
import { assertCreatedBySelf } from "../../../packages/daemon/src/private-file.ts";
import { installerEnv, npmWrapper, parseArgs, RUNTIME_HASH_SAMPLE, WINDOWS_RUNTIME_FILES } from "../lib.mjs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");

test("the inherited exact engine tuple and sibling overrides remain aligned", () => {
	const manifest = JSON.parse(read("../../../packages/daemon/package.json"));
	const direct = lockedDependencies();
	for (const name of ["pi-ai", "pi-coding-agent", "pi-mcp", "pi-tui"]) {
		assert.equal(direct[`@earendil-works/${name}`], "1.5.0");
		assert.equal(manifest.dependencies[`@earendil-works/${name}`], "1.5.0");
	}
	assert.equal(direct["gentle-pi"], "4.7.0");
	assert.deepEqual(lockedEnginePackages(direct), {
		"@earendil-works/pi-agent-core": "1.5.0",
		"@earendil-works/pi-codemode": "1.5.0",
		"@earendil-works/pi-schema": "1.5.0",
		"@earendil-works/pi-telemetry": "1.5.0",
	});
	assert.throws(() => lockedEnginePackages({}, "packages:\n  '@earendil-works/pi-codemode@1.4.0':\n  '@earendil-works/pi-codemode@1.5.0':\n"),
		{ message: "The lockfile holds two versions of @earendil-works/pi-codemode." });
	assert.deepEqual(lockedDependencies("importers:\n  packages/daemon:\n    dependencies:\n      ws:\n        version: 8.22.0(peer@1)\n      '@gentle-dot/protocol':\n        version: link:../protocol\n"), { ws: "8.22.0" });
});

test("Windows discovery retains strict overrides and admits inherited known-directory injection", () => {
	const home = "C:\\synthetic-profile";
	assert.equal(windowsUserHome({ HOME: "D:\\shell-home", UserProfile: home }), home);
	const known = "C:\\known\\engram.exe";
	const seen = [];
	assert.equal(resolveWindowsEngram({ PATH: "relative;C:\\first" }, "C:\\runtime", {
		home, knownDirs: ["C:\\known"], isFile: (path) => { seen.push(path); return path === known; },
	}), known);
	assert.deepEqual(seen, ["C:\\first\\engram.exe", known]);
	for (const explicit of ["relative.exe", "C:\\missing.exe", "C:\\script.cmd"]) {
		assert.throws(() => resolveWindowsEngram({ ENGRAM_BIN: explicit }, "C:\\runtime", { isFile: () => false }),
			{ message: "ENGRAM_BIN must name an existing, readable absolute Windows .exe file." });
	}
	assert.equal(resolveWindowsEngram({ ENGRAM_BIN: known }, "C:\\runtime", { isFile: (path) => path === known }), known);
});

test("public runtime identity and packaged provisioning gates preserve caller state", () => {
	const runtime = join(process.cwd(), "synthetic-runtime");
	assert.equal(runtimeDir({ GENTLE_DOT_RUNTIME: runtime }), runtime);
	if (process.platform === "win32") {
		const verbatim = "\\\\?\\C:\\synthetic-runtime.";
		assert.equal(runtimeDir({ GENTLE_DOT_RUNTIME: verbatim }), verbatim);
	}
	const script = join(runtime, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs");
	const env = { GENTLE_DOT_RUNTIME: runtime, GENTLE_SHELL_NO_AUTO_SETUP: "0" };
	assert.deepEqual(agentSpawnEnv(process.execPath, [script], env, "win32"), {
		...env, GENTLE_SHELL_NO_AUTO_SETUP: "1", GENTLE_PI_SKIP_GENTLE_AI_INSTALL: "1",
	});
	assert.equal(env.GENTLE_SHELL_NO_AUTO_SETUP, "0");
	for (const platform of ["darwin", "linux"])
		assert.equal(agentSpawnEnv(process.execPath, [script], env, platform), env);
	assert.equal(agentSpawnEnv("custom.exe", [script], env, "win32"), env);
	assert.throws(() => assertCreatedBySelf("synthetic", 2, 1),
		{ message: "synthetic was created as uid 2, not the daemon's 1." });
});

test("runtime staging refuses a missing native addon without starting a build", () => {
	let probes = 0;
	assert.equal(runtimeWindowsStopArtifact("linux", "synthetic", () => { probes++; return false; }), undefined);
	assert.equal(probes, 0);
	assert.throws(() => runtimeWindowsStopArtifact("win32", "synthetic", () => false),
		{ message: "Windows stop addon is missing. Run build:windows-stop with existing Node headers and node.lib first." });
	assert.equal(runtimeWindowsStopArtifact("win32", "synthetic", () => true), "synthetic");
});

test("producer commands, native required files and payload hashes agree structurally", () => {
	const root = read("../../../package.json");
	assert.equal([...root.matchAll(/"package:windows"\s*:/g)].length, 1);
	const { scripts } = JSON.parse(root);
	assert.equal(scripts["package:windows"], "powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/package.ps1");
	assert.equal(scripts["package:windows:payload"], "node scripts/package/package-windows.mjs");
	const launch = read("../../../apps/desktop/src-tauri/src/daemon/launch.rs");
	const list = /for relative in \[([^\]]+)\]/.exec(launch)?.[1];
	assert.ok(list);
	assert.deepEqual([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort(), [...WINDOWS_RUNTIME_FILES].sort());
	for (const file of ["node/node.exe", "bin/pi.exe", "bin/private-storage.exe", "daemon/native/windows-stop.node"])
		assert.ok(RUNTIME_HASH_SAMPLE.includes(file), file);
	const cargo = read("../../../apps/desktop/src-tauri/Cargo.toml");
	assert.equal([...cargo.matchAll(/\[target\.'cfg\(windows\)'\.dependencies\]/g)].length, 1);
	assert.ok(cargo.includes('"Win32_Security_Credentials"'));
	const stores = read("../../../apps/desktop/src-tauri/src/secure_store/mod.rs");
	const dispatch = stores.slice(stores.indexOf("pub fn connector_store()"), stores.indexOf("/// Accepts 1"));
	assert.ok(dispatch.includes("Box::new(windows::CredentialStore)"));
	assert.ok(!dispatch.includes("WindowsDpapiStore::new"));
});

test("Windows installer isolation uses native Node while POSIX behavior remains unchanged", () => {
	const source = { SystemRoot: "C:\\Windows", TOKEN: "synthetic-omit", PATH: "C:\\untrusted" };
	const env = installerEnv("C:\\stage", "C:\\cache", "win-x64", source);
	assert.equal(env.PATH, "C:\\stage\\node;C:\\Windows\\System32;C:\\Windows");
	assert.equal(env.TOKEN, undefined);
	assert.equal(env.HOME, "C:\\cache\\npm-home");
	assert.equal(source.PATH, "C:\\untrusted");
	assert.equal(installerEnv("/stage", "/cache", "linux-x64", {}).PATH, "/stage/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
	assert.equal(npmWrapper("npm-cli.js", "win32"), '@echo off\r\n"%~dp0node.exe" "%~dp0lib\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n');
	assert.equal(parseArgs(["--target", "darwin-x64"]).target, "darwin-x64");
	assert.equal(parseArgs(["--target", "windows-x64"]).target, "win-x64");
});

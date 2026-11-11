import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { lockedDependencies, lockedEnginePackages, piCmdWrapper, piWrapper } from "../src/runtime-build.ts";
import { tempDir } from "./helpers.ts";
import { directoryLinkType, symlinkDirectory } from "./support/fixture-capabilities.ts";
import { WINDOWS_STOP_ADDON } from "./support/windows.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(PACKAGE, "scripts", "build-runtime.ts");
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

let out: string;

// The real build stages the Windows stop addon, built with MSVC (build:windows-stop), and rightly
// refuses without it. A local Windows checkout that never ran build:windows-stop has none, so the
// build tests skip there; CI builds the addon first, so a missing one fails the build instead.
const skipBuild =
	process.platform === "win32" &&
	!process.env.CI &&
	!existsSync(join(PACKAGE, "native", "windows-stop.node"));
if (skipBuild) console.info(`Windows-only test skip: ${WINDOWS_STOP_ADDON}`);

beforeAll(() => {
	if (skipBuild) return;
	const root = tempDir();
	out = process.platform === "win32" ? join(root, "runtime Ω &") : root;
	const build = spawnSync(process.execPath, [BUILD, "--out", out], { encoding: "utf8" });
	// Go's explicit retention mode reports its scratch paths, not build diagnostics.
	const stderr = process.env.GOFLAGS?.split(/\s+/).includes("-work")
		? build.stderr.replace(/^WORK=[^\r\n]+\r?\n/gm, "")
		: build.stderr;
	expect(stderr).toBe("");
	expect(build.stdout).toBe("");
	expect(build.status).toBe(0);
}, 60_000);

/**
 * Puts `PACKAGE/node_modules` beside the output's `cli.mjs` so the self-check resolves the engine.
 * One directory link does not port: on a plain Windows install `symlinkSync` needs the symlink
 * privilege, and a **junction** to this pnpm layout does not resolve either — Node cannot follow a
 * dependency that is itself a symlink when it is reached through a junction (measured on Windows
 * 11, Node 24). Windows therefore gets a real folder holding one junction per dependency, each
 * pointing at the dependency's real path, so nothing under the output is a symlink to follow.
 */
function linkNodeModules(out: string): void {
	const link = join(out, "daemon", "node_modules");
	const source = join(PACKAGE, "node_modules");
	if (process.platform !== "win32") {
		symlinkDirectory(source, link);
		return;
	}
	mkdirSync(link, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		if (entry.name === ".bin") continue;
		const from = join(source, entry.name);
		if (entry.name.startsWith("@")) {
			mkdirSync(join(link, entry.name));
			for (const sub of readdirSync(from)) {
				const real = realpathSync(join(from, sub));
				if (statSync(real).isDirectory()) symlinkSync(real, join(link, entry.name, sub), directoryLinkType());
			}
		} else {
			const real = realpathSync(from);
			if (statSync(real).isDirectory()) symlinkSync(real, join(link, entry.name), directoryLinkType());
		}
	}
}

function listFiles(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	);
}

describe("piWrapper", () => {
	it("emits a relocatable Windows cmd wrapper without relying on sh or ambient Node", () => {
		expect(piCmdWrapper("@earendil-works/pi-coding-agent/dist/bundle/cli.js")).toBe(
			'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%~dp0..\\node\\bin\\node.exe" "%~dp0..\\daemon\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\nexit /b %errorlevel%\r\n',
		);
	});

	it("preserves the Unix shell wrapper for Linux and macOS", () => {
		const wrapper = piWrapper("@earendil-works/pi-coding-agent/dist/bundle/cli.js");
		expect(wrapper).toContain("#!/bin/sh\n");
		expect(wrapper).toContain('exec "$runtime/node/bin/node"');
		expect(wrapper).toContain('"$@"');
	});
});

describe.skipIf(skipBuild)("build:runtime", () => {
	it("emits the daemon part of the runtime layout, without node_modules", () => {
		const windows = process.platform === "win32";
		expect(listFiles(out).sort()).toEqual([
			...(windows ? ["bin/pi.exe", "bin/private-storage.exe"] : ["bin/pi"]),
			"daemon/cli.mjs", "daemon/extensions/approval-guard.ts",
			"daemon/extensions/screenshot-context.ts", "daemon/identity.md",
			...(windows ? ["daemon/native/windows-stop.node"] : []), "daemon/package.json",
		].sort());
		expect(readFileSync(join(out, "daemon", "identity.md"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "identity.md"), "utf8"),
		);
		expect(readFileSync(join(out, "daemon", "extensions", "approval-guard.ts"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "extensions", "approval-guard.ts"), "utf8"),
		);
	});

	it("bundles the protocol and leaves the engine and ws external", () => {
		const bundle = readFileSync(join(out, "daemon", "cli.mjs"), "utf8");
		expect(bundle.startsWith("#!/usr/bin/env node\n")).toBe(true);
		expect(bundle).not.toContain("@gentle-dot/protocol");
		expect(bundle).toMatch(/from "ws"/);
		expect(bundle).toContain('import("@earendil-works/pi-coding-agent")');
		// The production addon stays external and resolves beside the staged entry,
		// not relative to the source checkout; Unix's file layout remains unchanged.
		expect(bundle).toContain("./native/windows-stop.node");
		expect(bundle).not.toContain("NAPI_MODULE");
	});

	it("lists the external dependencies with the lockfile's exact versions", () => {
		const manifest = JSON.parse(readFileSync(join(out, "daemon", "package.json"), "utf8"));
		expect(manifest).toMatchObject({ private: true, type: "module" });
		expect(manifest.dependencies).toEqual({
			"@earendil-works/pi-ai": "1.5.0",
			"@earendil-works/pi-coding-agent": "1.5.0",
			"@earendil-works/pi-mcp": "1.5.0",
			"@earendil-works/pi-tui": "1.5.0",
			"gentle-pi": "4.7.0",
			jiti: "2.7.0",
			ws: "8.22.0",
		});
	});

	it("pins SDK-compatible transitive codemode through npm overrides", () => {
		const manifest = JSON.parse(readFileSync(join(out, "daemon", "package.json"), "utf8"));
		const source = JSON.parse(readFileSync(join(PACKAGE, "package.json"), "utf8"));
		const codemode = "@earendil-works/pi-codemode";
		expect(manifest.dependencies[codemode]).toBeUndefined();
		expect(source.dependencies[codemode]).toBeUndefined();
		expect(lockedDependencies()[codemode]).toBeUndefined();
		expect(manifest.overrides[codemode]).toBe("1.5.0");
	});

	it("selects workspace codemode matching the upgraded SDK's locked sibling", () => {
		// The old 1.0 declarations-subpath assertion belongs to the superseded SDK.
		// Resolve the upgraded package's public entry without executing SDK/providers.
		const sdk = realpathSync(join(PACKAGE, "node_modules", "@earendil-works", "pi-coding-agent"));
		const require = createRequire(join(sdk, "package.json"));
		let directory = dirname(require.resolve("@earendil-works/pi-codemode"));
		while (!existsSync(join(directory, "package.json"))) {
			const parent = dirname(directory);
			if (parent === directory) throw new Error("codemode package manifest unavailable");
			directory = parent;
		}
		const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
		expect(manifest.name).toBe("@earendil-works/pi-codemode");
		expect(manifest.version).toBe(lockedEnginePackages(lockedDependencies())[manifest.name]);
	});

	it("keeps lockedDependencies compatible with direct-only fixtures and peer suffixes", () => {
		expect(lockedDependencies([
			"importers:",
			"  packages/daemon:",
			"    dependencies:",
			"      'old-engine':",
			"        specifier: ^2.0.0",
			"        version: 2.1.0(peer@3.0.0)",
			"      '@gentle-dot/protocol':",
			"        specifier: workspace:*",
			"        version: link:../protocol",
			"    devDependencies:",
			"      test-only:",
			"        version: 4.0.0",
			"  packages/other:",
			"    dependencies:",
			"      unrelated:",
			"        version: 5.0.0",
		].join("\n"))).toEqual({ "old-engine": "2.1.0" });
	});

	// The engine asks for its siblings with `^` ranges; a fresh install would take newer ones
	// that no longer match it (pi-codemode 1.4.0 broke pi-coding-agent 1.0.4).
	// The manifest is this suite's boundary: proving npm honours `overrides` needs a real
	// install from the registry, which the packaging step does (scripts/package/stage-runtime.mjs
	// installs from this manifest, then scripts/package/smoke-runtime.mjs starts the engine).
	it("pins the engine's own packages to the lockfile's versions", () => {
		const manifest = JSON.parse(readFileSync(join(out, "daemon", "package.json"), "utf8"));
		expect(manifest.overrides).toEqual({
			"@earendil-works/pi-agent-core": "1.5.0",
			"@earendil-works/pi-codemode": "1.5.0",
			"@earendil-works/pi-schema": "1.5.0",
			"@earendil-works/pi-telemetry": "1.5.0",
		});
	});

	it("reads the engine packages from a lockfile, without the direct dependencies", () => {
		const lockfile = [
			"importers:",
			"  '@earendil-works/pi-tui@9.9.9':",
			"packages:",
			"  '@earendil-works/pi-coding-agent@1.4.0':",
			"  '@earendil-works/pi-ai@1.4.0':",
			"  ws@8.22.0:",
			"snapshots:",
			"  '@earendil-works/pi-codemode@2.0.0':",
			"packages:",
			"  '@earendil-works/pi-agent-core@1.4.0':",
			"  '@earendil-works/pi-agent-core@1.4.0(ws@8.22.0)':",
			"  '@earendil-works/pi-agent-core@1.4.0(undici@8.11.2)(ws@8.22.0)':",
		].join("\n");
		expect(lockedEnginePackages({ "@earendil-works/pi-coding-agent": "1.4.0" }, lockfile)).toEqual({
			"@earendil-works/pi-ai": "1.4.0",
			"@earendil-works/pi-agent-core": "1.4.0",
		});
	});

	it("refuses a lockfile holding two versions of one engine package", () => {
		const lockfile = [
			"packages:",
			"  '@earendil-works/pi-codemode@1.4.0':",
			"  '@earendil-works/pi-codemode@1.5.0(ws@8.22.0)':",
		].join("\n");
		expect(() => lockedEnginePackages({}, lockfile)).toThrow(
			"The lockfile holds two versions of @earendil-works/pi-codemode.",
		);
		// Two versions of a direct dependency are pnpm's business, not an override's.
		expect(lockedEnginePackages({ "@earendil-works/pi-codemode": "1.4.0" }, lockfile)).toEqual({});
	});

	it("runs its self-check from the output with the engine resolved inside it", () => {
		linkNodeModules(out);
		const engramBin = join(tempDir(), process.platform === "win32" ? "engram.exe" : "engram");
		writeFileSync(engramBin, "fixture executable");
		const check = spawnSync(process.execPath, [join(out, "daemon", "cli.mjs"), "--self-check"], {
			encoding: "utf8",
			env: {
				PATH: [join(tempDir(), "bin"), join(tempDir(), "system")].join(delimiter),
				HOME: tempDir(),
				GENTLE_DOT_DATA_DIR: tempDir(),
				GENTLE_DOT_RUNTIME: out,
				ENGRAM_BIN: engramBin,
			},
		});
		expect(check.stderr).toBe("");
		expect(check.status).toBe(0);
		const report = JSON.parse(check.stdout);
		const real = realpathSync(out);
		expect(report).toMatchObject({
			ok: true,
			runtime: out,
			uiDir: join(out, "ui"),
			gentleShell: join(out, "daemon", "node_modules", "gentle-pi", "bin", "gentle-shell.mjs"),
			engineCli: join(out, "daemon", "node_modules", ENGINE_CLI),
			engramBin,
		});
		expect(realpathSync(report.approvalGuard)).toBe(join(real, "daemon", "extensions", "approval-guard.ts"));
		expect(realpathSync(report.identity)).toBe(join(real, "daemon", "identity.md"));
	});

	if (process.platform === "win32") {
		it("runs the native launcher with literal argv and stdio from a relocated runtime", () => {
			const moved = join(tempDir(), "runtime Ω &");
			const movedBin = join(moved, "bin", "pi.exe");
			const movedNode = join(moved, "node", "node.exe");
			const engine = join(moved, "daemon", "node_modules", ENGINE_CLI);
			mkdirSync(dirname(movedBin), { recursive: true });
			mkdirSync(dirname(movedNode), { recursive: true });
			mkdirSync(dirname(engine), { recursive: true });
			copyFileSync(join(out, "bin", "pi.exe"), movedBin);
			copyFileSync(process.execPath, movedNode);
			writeFileSync(
				engine,
				[
					"let input = '';",
					"process.stdin.setEncoding('utf8');",
					"for await (const chunk of process.stdin) input += chunk;",
					"process.stdout.write(JSON.stringify({ engine: process.argv[1], args: process.argv.slice(2), input }));",
					"process.stderr.write('fixture stderr');",
					"process.exitCode = Number(process.argv.find((arg) => arg.startsWith('--fixture-exit='))?.split('=')[1] ?? 0);",
				].join("\n"),
			);
			const marker = join(tempDir(), "launcher-must-not-create.txt");
			const args = [
				"",
				"two words Ω 世界",
				'quote " inside',
				"%PATH%",
				"!TEMP!",
				"&",
				"|",
				"^",
				"(parentheses)",
				"<",
				">",
				`& echo injected > ${marker}`,
				"--fixture-exit=23",
			];
			const input = "stdin Ω fixture";
			const run = spawnSync(movedBin, args, {
				encoding: "utf8",
				input,
				timeout: 15_000,
				windowsHide: true,
			});
			expect(run.error).toBeUndefined();
			expect(run.status).toBe(23);
			expect(run.stdout).toBe(JSON.stringify({ engine, args, input }));
			expect(run.stderr).toBe("fixture stderr");
			expect(existsSync(marker)).toBe(false);

			const successArgs = args.map((arg) => (arg === "--fixture-exit=23" ? "--fixture-exit=0" : arg));
			const success = spawnSync(movedBin, successArgs, {
				encoding: "utf8",
				input,
				timeout: 15_000,
				windowsHide: true,
			});
			expect(success.error).toBeUndefined();
			expect(success.status).toBe(0);
			expect(success.stdout).toBe(JSON.stringify({ engine, args: successArgs, input }));
			expect(success.stderr).toBe("fixture stderr");

			const missingNodeBin = join(tempDir(), "missing-node-runtime Ω &", "bin", "pi.exe");
			mkdirSync(dirname(missingNodeBin), { recursive: true });
			copyFileSync(join(out, "bin", "pi.exe"), missingNodeBin);
			const failed = spawnSync(missingNodeBin, [], {
				encoding: "utf8",
				timeout: 15_000,
				windowsHide: true,
			});
			expect(failed.error).toBeUndefined();
			expect(failed.status).toBe(1);
			expect(failed.stdout).toBe("");
			expect(failed.stderr).toMatch(/^pi launcher: start runtime Node:/);
		});
	} else {
		it("emits a `pi` wrapper that runs the runtime's node and engine wherever the runtime is", () => {
			expect(statSync(join(out, "bin", "pi")).mode & 0o111).toBe(0o111);
			const moved = tempDir();
			mkdirSync(join(moved, "bin"));

			mkdirSync(join(moved, "node", "bin"), { recursive: true });
			copyFileSync(join(out, "bin", "pi"), join(moved, "bin", "pi"));
			writeFileSync(join(moved, "node", "bin", "node"), '#!/bin/sh\nprintf "%s\\n" "$0" "$@"\n', {
				mode: 0o755,
			});
			const linked = join(tempDir(), "pi");
			symlinkSync(join(moved, "bin", "pi"), linked);
			const real = realpathSync(moved);
			for (const entry of [join(moved, "bin", "pi"), linked]) {
				const run = spawnSync(entry, ["--version", "a b"], { encoding: "utf8" });
				expect(run.status).toBe(0);
				expect(run.stdout.split("\n")).toEqual([
					join(real, "node", "bin", "node"),
					join(real, "daemon", "node_modules", ENGINE_CLI),
					"--version",
					"a b",
					"",
				]);
			}
			expect(existsSync(join(PACKAGE, "node_modules", ENGINE_CLI))).toBe(true);
		});
	}
});

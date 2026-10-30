#!/usr/bin/env node
// Package an already staged native Windows x64 runtime. No staging, installs, or launch checks.
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWindowsHost, parseWindowsArgs, WINDOWS_USAGE, windowsPackagePlan } from "./windows-lib.mjs";

function isKind(path, kind) {
	try {
		return statSync(path)[kind]();
	} catch {
		return false;
	}
}

function main() {
	const options = parseWindowsArgs(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${WINDOWS_USAGE}\n`);
		return;
	}
	// Admit the native host before reading staged files or invoking any build tools.
	assertWindowsHost(process.platform, process.arch);
	const repo = fileURLToPath(new URL("../..", import.meta.url));
	const runtime = resolve(
		process.env.INIT_CWD ?? process.cwd(),
		options.runtime ?? resolve(repo, "build/runtime/windows-x64"),
	);
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(resolve(runtime, "MANIFEST.json"), "utf8"));
	} catch {
		throw new Error(
			`Missing or invalid MANIFEST.json in ${runtime}; stage the Windows runtime explicitly first.`,
		);
	}
	const plan = windowsPackagePlan({
		repo,
		runtime,
		platform: process.platform,
		arch: process.arch,
		node: process.execPath,
		manifest,
		isFile: (path) => isKind(path, "isFile"),
		isDirectory: (path) => isKind(path, "isDirectory"),
	});
	// Run the repository's installed CLI via Node, never pnpm.cmd through execFile/spawn.
	process.stdout.write(
		`Using ${runtime}; tauri build --bundles nsis (no staging; the installer adds WebView2 when missing).\n`,
	);
	const result = spawnSync(plan.program, plan.args, {
		cwd: plan.cwd,
		env: { ...process.env, ...plan.env },
		stdio: "inherit",
	});
	if (result.error || result.status !== 0)
		throw new Error(
			`Windows package build failed (${result.error?.message ?? `exit ${result.status}, signal ${result.signal ?? "none"}`}).`,
		);
	process.stdout.write(
		"NSIS build finished; installer/installed runtime has not been exercised by this command.\n",
	);
}

try {
	main();
} catch (error) {
	process.stderr.write(`package-windows: ${error.message}\n`);
	process.exitCode = 1;
}

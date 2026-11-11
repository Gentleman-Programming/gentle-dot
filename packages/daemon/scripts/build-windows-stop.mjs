#!/usr/bin/env node
// Explicit production addon build. Uses existing inputs only; never installs or downloads.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
	"usage: build-windows-stop --compiler <absolute cl.exe> --headers <Node include/node> --node-lib <node.lib>\nRun in an existing MSVC/Windows SDK developer environment (INCLUDE and LIB). No inputs are downloaded.\n";
const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help")) {
	process.stdout.write(usage);
} else {
	if (process.platform !== "win32") throw new Error("Windows stop addon must be built on Windows");
	const values = new Map();
	for (let index = 0; index < args.length; index += 2) {
		const flag = args[index];
		const value = args[index + 1];
		if (!["--compiler", "--headers", "--node-lib"].includes(flag) || !value || values.has(flag)) {
			throw new Error(usage);
		}
		values.set(flag, value);
	}
	const compiler = values.get("--compiler");
	const headers = values.get("--headers");
	const nodeLib = values.get("--node-lib");
	if (
		![compiler, headers, nodeLib].every(
			(path) => typeof path === "string" && isAbsolute(path) && existsSync(path),
		) ||
		!existsSync(join(headers, "node_api.h")) ||
		!process.env.INCLUDE ||
		!process.env.LIB
	) {
		throw new Error(usage);
	}
	const native = fileURLToPath(new URL("../native/", import.meta.url));
	const source = join(native, "windows-stop.cc");
	const channelSource = join(native, "windows-app-channel.cc");
	const channelObject = join(native, "windows-app-channel.obj");
	const streamSource = join(native, "windows-app-channel-stream.cc");
	const streamObject = join(native, "windows-app-channel-stream.obj");
	const napiSource = join(native, "windows-app-channel-napi.cc");
	const napiObject = join(native, "windows-app-channel-napi.obj");
	if (
		![
			source,
			channelSource,
			streamSource,
			napiSource,
			join(native, "windows-app-channel.h"),
			join(native, "windows-app-channel-stream.h"),
			join(native, "windows-app-channel-napi.h"),
		].every(existsSync)
	) {
		throw new Error("Production Windows native source is missing");
	}
	mkdirSync(dirname(source), { recursive: true });
	// A failed link must never leave the previous artifact behind: the addon test
	// asserts only that this file exists, so a stale binary would pass as a build.
	const artifact = join(native, "windows-stop.node");
	for (const stale of [
		artifact,
		join(native, "windows-stop.lib"),
		join(native, "windows-stop.pdb"),
		channelObject,
		streamObject,
		napiObject,
		join(native, "windows-stop.obj"),
	]) {
		rmSync(stale, { force: true });
	}
	// Separate translation-unit invocation: /Fo must not name one file for two sources.
	// Host libuv imports resolve through node.lib below; never link a separate libuv.
	const channelResult = spawnSync(
		compiler,
		[
			"/nologo",
			"/c",
			"/EHsc",
			"/std:c++17",
			"/O2",
			"/MD",
			`/I${headers}`,
			channelSource,
			`/Fo${channelObject}`,
		],
		{ cwd: native, stdio: "inherit", shell: false },
	);
	if (channelResult.error) throw new Error("Windows channel compiler could not be started");
	if (channelResult.status !== 0) {
		process.exit(channelResult.status ?? 1);
	}
	const streamResult = spawnSync(
		compiler,
		[
			"/nologo",
			"/c",
			"/EHsc",
			"/std:c++17",
			"/O2",
			"/MD",
			`/I${headers}`,
			streamSource,
			`/Fo${streamObject}`,
		],
		{ cwd: native, stdio: "inherit", shell: false },
	);
	if (streamResult.error) throw new Error("Windows channel stream compiler could not be started");
	if (streamResult.status !== 0) {
		process.exit(streamResult.status ?? 1);
	}
	const napiResult = spawnSync(
		compiler,
		[
			"/nologo",
			"/c",
			"/EHsc",
			"/std:c++17",
			"/O2",
			"/MD",
			"/DNAPI_VERSION=8",
			`/I${headers}`,
			napiSource,
			`/Fo${napiObject}`,
		],
		{ cwd: native, stdio: "inherit", shell: false },
	);
	if (napiResult.error) throw new Error("Windows channel Node-API compiler could not be started");
	if (napiResult.status !== 0) {
		process.exit(napiResult.status ?? 1);
	}
	const result = spawnSync(
		compiler,
		[
			"/nologo",
			"/LD",
			"/EHsc",
			"/std:c++17",
			"/O2",
			"/MD",
			"/DNAPI_VERSION=8",
			"/DNODE_GYP_MODULE_NAME=windows_stop",
			`/I${headers}`,
			source,
			channelObject,
			streamObject,
			napiObject,
			`/Fo${join(native, "windows-stop.obj")}`,
			"/link",
			"/INCREMENTAL:NO",
			`/OUT:${artifact}`,
			`/IMPLIB:${join(native, "windows-stop.lib")}`,
			`/PDB:${join(native, "windows-stop.pdb")}`,
			nodeLib,
			"kernel32.lib",
			"advapi32.lib",
		],
		{ cwd: native, stdio: "inherit", shell: false },
	);
	if (result.error) throw new Error("Windows stop compiler could not be started");
	process.exitCode = result.status ?? 1;
	if (result.status === 0 && !existsSync(artifact)) {
		throw new Error(`Windows stop link reported success but produced no ${artifact}`);
	}
}

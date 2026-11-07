import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
	adaptGentleShell,
	applyWindowsConsole,
	planWindowsConsole,
	preflightWindowsConsole,
} from "../windows-console.mjs";

// Read the declared package's source, never import its effectful CLI/postinstall.
const packageRoot = fileURLToPath(
	new URL("../../../packages/daemon/node_modules/gentle-pi/", import.meta.url),
);
const source = readFileSync(join(packageRoot, "bin/gentle-shell.mjs"), "utf8");
const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

test("4.6 Windows Pi launch hides the child without changing argv, env or shell policy", () => {
	assert.equal(metadata.version, "4.6.0");
	const adapted = adaptGentleShell(source, metadata, "win32");
	const line = adapted
		.split("\n")
		.find((line) => line.includes("child = spawn(launchPlan.command") && line.includes('stdio: "inherit"'));
	const launchPlan = { command: "node.exe", args: ["pi.mjs", "a b", "wow!", "%literal%"], shell: false };
	const childEnv = { SYNTHETIC: "only" };
	let call;
	vm.runInNewContext(line, {
		process: { platform: "win32" },
		launchPlan,
		childEnv,
		spawn: (...args) => {
			call = args;
		},
	});
	assert.equal(call[0], launchPlan.command);
	assert.equal(call[1], launchPlan.args);
	assert.equal(call[2].env, childEnv);
	assert.equal(call[2].shell, false);
	assert.equal(call[2].stdio, "inherit");
	assert.equal(call[2].windowsHide, true);
});

const helpers = ["runtime/gentle-shell-launcher.mjs", "runtime/gentle-shell-startup-flow.mjs"];
function stagedCopy() {
	const runtime = mkdtempSync(join(tmpdir(), "console-source-"));
	const root = join(runtime, "daemon", "node_modules", "gentle-pi");
	for (const name of ["package.json", "bin/gentle-shell.mjs", ...helpers]) {
		const destination = join(root, name);
		mkdirSync(join(destination, ".."), { recursive: true });
		writeFileSync(destination, readFileSync(join(packageRoot, name)));
	}
	writeFileSync(
		join(runtime, "MANIFEST.json"),
		JSON.stringify({ name: "gentle-dot-runtime", target: "windows-x64", extra: "retained" }),
	);
	return { runtime, root };
}

test("4.6 adaptation changes only five child options and is exactly idempotent", () => {
	const adapted = adaptGentleShell(source, metadata, "win32");
	assert.notEqual(adapted, source);
	assert.equal(adaptGentleShell(adapted, metadata, "win32"), adapted);
	assert.equal(
		adapted
			.replaceAll(', ...(process.platform === "win32" ? { windowsHide: true } : {})', "")
			.replace('\n\t\t...(process.platform === "win32" ? { windowsHide: true } : {}),', ""),
		source,
	);
	for (const platform of ["linux", "darwin"]) {
		assert.equal(adaptGentleShell(source, metadata, platform), source);
		assert.equal(adaptGentleShell("unknown", {}, platform), "unknown");
		assert.equal(applyWindowsConsole("absent", { platform }), undefined);
		assert.equal(preflightWindowsConsole({ platform, packageRoot: "absent" }), undefined);
	}
});

test("4.6 setup forwards signals and cleans handlers with the upstream lifecycle unchanged", async () => {
	const adapted = adaptGentleShell(source, metadata, "win32");
	const glue = adapted.slice(adapted.indexOf("function spawnAndWait("), adapted.indexOf("// Renders `ms`"));
	const process = Object.assign(new EventEmitter(), { platform: "win32" });
	const child = new EventEmitter();
	const killed = [];
	child.kill = (signal) => killed.push(signal);
	let call;
	const env = { SYNTHETIC: "only" };
	const context = vm.createContext({
		process,
		spawn: (...args) => {
			call = args;
			return child;
		},
		planSpawn: ({ command, args }) => ({ command, args, shell: false }),
		signalExitCode: () => 130,
		setTimeout: () => {
			throw Error("unexpected timer");
		},
		clearTimeout: () => {},
	});
	vm.runInContext(glue, context);
	const args = ["a b", "wow!", "%literal%"];
	const done = context.spawnAndWait("node.exe", args, env, "inherit");
	assert.equal(call[0], "node.exe");
	assert.equal(call[1], args);
	assert.equal(call[2].env, env);
	assert.equal(call[2].windowsHide, true);
	assert.equal(call[2].shell, false);
	process.emit("SIGINT");
	child.emit("exit", null, "SIGINT");
	const result = await done;
	assert.equal(result.interrupted, true);
	assert.equal(result.exitCode, 130);
	assert.deepEqual(killed, ["SIGINT"]);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(process.listenerCount(signal), 0);
});

test("4.6 installer, relaunch and version probe preserve options while hiding Windows children", () => {
	const adapted = adaptGentleShell(source, metadata, "win32");
	const env = { SYNTHETIC: "only" };
	for (const platform of ["win32", "linux"]) {
		const calls = [];
		const context = {
			process: { platform, execPath: "node.exe", env },
			stdio: "inherit",
			installerPath: "inert-installer.mjs",
			next: { command: "node.exe", args: ["shell.mjs", "a b"], env },
			bundledEnv: env,
			versionProbePlan: { command: "node.exe", args: ["pi.mjs", "--version"], shell: false },
			spawn: (...args) => {
				calls.push(args);
			},
			spawnSync: (...args) => {
				calls.push(args);
			},
		};
		for (const needle of ["const result = spawnSync(process.execPath", "const child = spawn(next.command"]) {
			vm.runInNewContext(
				adapted.split("\n").find((line) => line.includes(needle)),
				context,
			);
		}
		const begin = adapted.indexOf("const versionProbe = spawnSync(");
		vm.runInNewContext(adapted.slice(begin, adapted.indexOf("\n\t});", begin) + 5), context);
		assert.equal(calls.length, 3);
		for (const call of calls) assert.equal(call[2].windowsHide, platform === "win32" ? true : undefined);
		assert.equal(calls[0][1][0], context.installerPath);
		assert.equal(calls[1][1], context.next.args);
		assert.equal(calls[1][2].env, env);
		assert.equal(calls[2][1], context.versionProbePlan.args);
		assert.equal(calls[2][2].env, env);
		assert.equal(calls[2][2].timeout, 15000);
		assert.equal(calls[2][2].encoding, "utf8");
	}
});

test("4.6 admission rejects unknown versions, source bytes and partial adaptations", () => {
	for (const version of ["4.0.0", "4.3.0", "4.6.1", "5.0.0"])
		assert.throws(
			() => adaptGentleShell(source, { ...metadata, version }, "win32"),
			/requires gentle-pi 4.6.0/,
		);
	assert.throws(() => adaptGentleShell(source, { ...metadata, name: "other" }, "win32"), /requires/);
	for (const bytes of [
		source + "\n",
		source.replaceAll("\n", "\r\n"),
		"unknown",
		source.replace("{ stdio }", "{ stdio, windowsHide: true }"),
	])
		assert.throws(() => adaptGentleShell(bytes, metadata, "win32"), /Unknown gentle-shell source SHA-256/);
});

test("4.6 staged adaptation admits helpers and manifest before writes, leaves them unchanged", () => {
	const { runtime, root } = stagedCopy();
	const manifest = readFileSync(join(runtime, "MANIFEST.json"), "utf8");
	preflightWindowsConsole({ platform: "win32", packageRoot: root });
	for (const value of [undefined, {}, { name: "gentle-dot-runtime", target: "win-x64" }])
		assert.throws(
			() => planWindowsConsole({ source, metadata, manifest: value, requireManifest: true }),
			/existing windows-x64/,
		);
	const result = applyWindowsConsole(runtime, { platform: "win32", requireManifest: true });
	assert.equal(result.gentlePi, "4.6.0");
	assert.equal(
		readFileSync(join(root, "bin/gentle-shell.mjs"), "utf8"),
		adaptGentleShell(source, metadata, "win32"),
	);
	assert.deepEqual(applyWindowsConsole(runtime, { platform: "win32", requireManifest: true }), result);
	assert.equal(readFileSync(join(runtime, "MANIFEST.json"), "utf8"), manifest);
	for (const name of helpers)
		assert.equal(readFileSync(join(root, name), "utf8"), readFileSync(join(packageRoot, name), "utf8"));
});

test("4.6 changed helpers or malformed metadata refuse before touching staged source", () => {
	const { runtime, root } = stagedCopy();
	writeFileSync(join(root, helpers[0]), "unknown helper");
	assert.throws(() => preflightWindowsConsole({ platform: "win32", packageRoot: root }), /helper SHA-256/);
	assert.throws(() => applyWindowsConsole(runtime, { platform: "win32" }), /helper SHA-256/);
	assert.equal(readFileSync(join(root, "bin/gentle-shell.mjs"), "utf8"), source);
	writeFileSync(join(root, "package.json"), "not JSON");
	assert.throws(() => preflightWindowsConsole({ platform: "win32", packageRoot: root }), /Cannot parse/);
	assert.equal(readFileSync(join(root, "bin/gentle-shell.mjs"), "utf8"), source);
});

test("stager awaits local source admission before output replacement or downloads", () => {
	const stager = readFileSync(new URL("../stage-runtime.mjs", import.meta.url), "utf8");
	const preflight = stager.indexOf("await compatibility.preflightWindowsConsole()");
	assert.ok(preflight > stager.indexOf('await import("./windows-console.mjs")'));
	assert.ok(preflight < stager.indexOf("prepareOut(out);"));
	assert.ok(preflight < stager.indexOf("await stageNode(out, target)"));
});

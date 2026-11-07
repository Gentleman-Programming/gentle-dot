import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { RUNTIME_HASH_SAMPLE } from "../lib.mjs";
import { runWindowsCli } from "../windows-runtime-policy.mjs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
// Inert orchestration only: no build, staging, extraction or Windows process.
test("staging has no extra legacy-Git refusal and retains normal preparation", () => {
	const source = read("../stage-runtime.mjs");
	const main = source.slice(source.indexOf("async function main()"));
	assert.doesNotMatch(
		source,
		/assertNoLegacyWindowsGit|windows-runtime-policy|windows-git\.mjs|MINGIT_ASSETS|verifiedGitArchive|stageWindowsGit|gitArchive/,
	);
	assert.ok(main.indexOf("mkdirSync(CACHE") < main.indexOf("prepareOut(out);"));
	assert.equal((main.match(/writeFileSync\(join\(out, "MANIFEST.json"\)/g) ?? []).length, 1);
});

function packaging(overrides = {}) {
	const repo = resolve("synthetic-repo");
	const runtime = join(repo, "build/runtime/windows-x64");
	const calls = [];
	const output = { stdout: "", stderr: "" };
	const files = [
		...RUNTIME_HASH_SAMPLE,
		"daemon/package.json",
		"ui/index.html",
		"daemon/node_modules/gentle-pi/.gentle-ai/v4.3.0/gentle-ai.exe",
	];
	const io = {
		repo,
		cwd: repo,
		node: "synthetic-node",
		platform: "win32",
		arch: "x64",
		env: {},
		stdout: (text) => {
			output.stdout += text;
		},
		stderr: (text) => {
			output.stderr += text;
		},
		exists: () => true,
		isFile: () => true,
		isDirectory: () => true,
		readJson: (path) =>
			path.endsWith("tauri.conf.json")
				? { productName: "Gentle Dot", version: "0.1.0" }
				: { name: "gentle-dot-runtime", target: "windows-x64" },
		spawn: (command, args) => {
			calls.push(["spawn", command, args]);
			return { status: 0 };
		},
		applyConsole: (path, options) => {
			calls.push(["console", path, options]);
			return { changed: false };
		},
		filesIn: () => files,
		directoriesIn: () => [],
		size: () => 2 * 1024 * 1024,
		treeSize: () => 3 * 1024 * 1024,
		sha256File: async (path) => {
			calls.push(["hash", path]);
			return "same-bytes";
		},
		makeScratch: () => join(repo, "scratch"),
		mkdir: () => {},
		removeScratch: (path) => calls.push(["cleanup", path]),
		...overrides,
	};
	return { calls, output, runtime, run: (args) => runWindowsCli(args, io) };
}

test("packaging retains manifest, console, fresh-stage and payload checks without bundled Git", async () => {
	const source = read("../windows-runtime-policy.mjs");
	assert.doesNotMatch(
		source,
		/assertNoLegacyWindowsGit|prepareWindowsRuntime|windows-git\.mjs|validateWindowsGit/,
	);
	assert.match(source, /payloadDifferences\(stagedFiles, io\.filesIn\(extracted\)\)/);
	assert.match(
		source,
		/const sample = \[\.\.\.RUNTIME_HASH_SAMPLE, \.\.\.stagedFiles.filter\(isGentleAiBinary\)\]/,
	);
	assert.ok(RUNTIME_HASH_SAMPLE.includes("node/bin/node.exe"));
	assert.ok(RUNTIME_HASH_SAMPLE.includes("daemon/native/windows-stop.node"));
	assert.ok(!RUNTIME_HASH_SAMPLE.some((path) => /(^|\/)git\//i.test(path)));
	const reuse = packaging();
	assert.equal(await reuse.run(["--skip-stage", "--check"]), 0, reuse.output.stderr);
	assert.equal(reuse.output.stderr, "");
	assert.deepEqual(reuse.calls[0], ["console", reuse.runtime, { requireManifest: true }]);
	assert.equal(reuse.calls.filter(([kind]) => kind === "hash").length, (RUNTIME_HASH_SAMPLE.length + 1) * 4);
	assert.equal(reuse.calls.at(-1)[0], "cleanup");
	const missing = packaging({ exists: () => false });
	assert.equal(await missing.run(["--skip-stage"]), 1);
	assert.match(missing.output.stderr, /--skip-stage needs a staged runtime/);
	assert.deepEqual(missing.calls, []);
	const fresh = packaging();
	assert.equal(await fresh.run([]), 0, fresh.output.stderr);
	assert.deepEqual(fresh.calls[0], [
		"spawn",
		"synthetic-node",
		[
			join(resolve("synthetic-repo"), "scripts/package/stage-runtime.mjs"),
			"--target",
			"windows-x64",
			"--out",
			fresh.runtime,
		],
	]);
	const failed = packaging({ spawn: () => ({ status: 7 }) });
	assert.equal(await failed.run([]), 1);
	assert.match(failed.output.stderr, /stager|stage-runtime\.mjs.*failed \(exit 7\)/);
	assert.deepEqual(failed.calls, []);
	const addon = packaging({ isFile: (path) => !path.endsWith("windows-stop.node") });
	assert.equal(await addon.run(["--skip-stage"]), 1);
	assert.match(addon.output.stderr, /Missing staged artifact daemon\/native\/windows-stop.node/);
	assert.deepEqual(addon.calls, []);
	const changed = packaging({
		sha256File: async (path) => (path.includes("scratch") ? "changed" : "original"),
	});
	assert.equal(await changed.run(["--skip-stage", "--check"]), 1);
	assert.match(changed.output.stderr, /changed on its way in/);
	assert.equal(changed.calls.at(-1)[0], "cleanup");
	let listings = 0;
	const incomplete = packaging({ filesIn: () => (++listings === 1 ? RUNTIME_HASH_SAMPLE : []) });
	assert.equal(await incomplete.run(["--skip-stage", "--check"]), 1);
	assert.match(incomplete.output.stderr, /staged files are absent/);
	assert.equal(incomplete.calls.at(-1)[0], "cleanup");
});

test("Windows fallback contains only runtime bin/Node, retaining explicit script paths and POSIX paths", () => {
	const source = read("../../../apps/desktop/src-tauri/src/daemon/launch.rs");
	const body = source.slice(source.indexOf("pub fn launch_spec("), source.indexOf("pub fn runtime_dir("));
	assert.ok(body.includes('dir.join("node/bin/node.exe")'));
	assert.ok(body.includes('dir.join("node/bin").display()'));
	assert.doesNotMatch(body, /join\("git"\)|join\("cmd"\)/);
	assert.ok(body.includes('dir.join("daemon/cli.mjs")'));
	assert.ok(body.includes('format!("{root}/bin:{root}/node/bin:/usr/bin:/bin:/usr/sbin:/sbin")'));
	assert.ok(body.includes('env!("GENTLE_DOT_BUILD_PATH")'));
	assert.ok(body.includes('pick("GENTLE_DOT_NODE", node)'));
	assert.ok(body.includes('pick("GENTLE_DOT_DAEMON_SCRIPT", script)'));
	const windows = read("../../../apps/desktop/src-tauri/src/daemon/windows.rs");
	assert.ok(windows.includes("fn environment(spec: &LaunchSpec)"));
	assert.ok(windows.includes("for (key, value) in &spec.envs"));
	assert.ok(windows.includes("block.extend(value)"));
});

test("all native launch branches retain inherited PATH before runtime fallback", () => {
	const source = read("../../../apps/desktop/src-tauri/src/daemon/launch.rs");
	const body = source.slice(source.indexOf("pub fn launch_spec("), source.indexOf("pub fn runtime_dir("));
	assert.ok(body.includes("let separator = if cfg!(windows) { ';' } else { ':' };"));
	assert.ok(body.includes('runtime_path(env("PATH"), &path, separator)'));
	assert.ok(body.includes('runtime_path(env("PATH"), env!("GENTLE_DOT_BUILD_PATH"), separator)'));
});

test("native PATH merge does not normalize inherited entries or introduce an empty prefix", () => {
	const source = read("../../../apps/desktop/src-tauri/src/daemon/launch.rs");
	const start = source.indexOf("fn runtime_path(");
	assert.ok(start >= 0);
	const helper = source.slice(start, source.indexOf("\n}\n", start) + 3);
	assert.ok(helper.includes("match inherited.filter(|path| !path.is_empty())"));
	assert.ok(helper.includes("Some(path) if fallback.is_empty() => path"));
	assert.ok(helper.includes('Some(path) => format!("{path}{separator}{fallback}")'));
	assert.ok(helper.includes("None => fallback.to_string()"));
	assert.equal(/split|trim|dedup|to_lowercase|set_var/.test(helper), false);
});

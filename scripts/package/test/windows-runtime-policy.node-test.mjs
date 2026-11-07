import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RUNTIME_HASH_SAMPLE, windowsInstallerNames } from "../lib.mjs";
import { runWindowsCli } from "../windows-runtime-policy.mjs";

const repo = resolve("synthetic-checkout");
const stage = join(repo, "build/runtime/windows-x64");
const manifest = { name: "gentle-dot-runtime", target: "windows-x64" };
const product = { productName: "Gentle Dot", version: "0.1.0" };
const names = windowsInstallerNames(product.productName, product.version);

function fixture(overrides = {}) {
	const calls = [],
		mutations = [],
		output = { stdout: "", stderr: "" };
	const files = [
		...RUNTIME_HASH_SAMPLE,
		"daemon/package.json",
		"ui/index.html",
		"daemon/node_modules/gentle-pi/.gentle-ai/v4.2.0/gentle-ai.exe",
	];
	const io = {
		platform: "win32",
		arch: "x64",
		repo,
		cwd: repo,
		node: process.execPath,
		env: { SYNTHETIC: "only" },
		stdout: (text) => {
			output.stdout += text;
		},
		stderr: (text) => {
			output.stderr += text;
		},
		readJson: (path) => {
			calls.push(["read", path]);
			return path.endsWith("tauri.conf.json") ? product : manifest;
		},
		isFile: (path) => {
			calls.push(["file", path]);
			return true;
		},
		isDirectory: (path) => {
			calls.push(["directory", path]);
			return true;
		},
		exists: (path) => {
			calls.push(["exists", path]);
			return true;
		},
		spawn: (program, args, options) => {
			mutations.push(["spawn", program, args, options]);
			return { status: 0, stdout: "", stderr: "" };
		},
		applyConsole: (runtime, options) => {
			mutations.push(["console", runtime, options]);
			return { changed: false, sha256: "synthetic" };
		},
		filesIn: () => files,
		directoriesIn: () => [],
		size: () => 2 * 1024 * 1024,
		treeSize: () => 3 * 1024 * 1024,
		sha256File: async (path) => {
			calls.push(["hash", path]);
			return "synthetic-identical-bytes";
		},
		makeScratch: () => {
			mutations.push(["scratch"]);
			return join(repo, "scratch");
		},
		mkdir: (path) => {
			mutations.push(["mkdir", path]);
		},
		removeScratch: (path) => {
			mutations.push(["cleanup", path]);
		},
		...overrides,
	};
	return { io, calls, mutations, output, run: (args) => runWindowsCli(args, io) };
}
const spawns = (h) => h.mutations.filter((call) => call[0] === "spawn");
const build = (h) => spawns(h).find((call) => call[2].includes("build"));

test("default CLI stages canonical Windows runtime then builds and validates both NSIS and MSI", async () => {
	const h = fixture();
	assert.equal(await h.run([]), 0, h.output.stderr);
	assert.equal(h.output.stderr, "");
	assert.equal(spawns(h).length, 2);
	assert.deepEqual(spawns(h)[0].slice(1, 3), [
		process.execPath,
		[join(repo, "scripts/package/stage-runtime.mjs"), "--target", "windows-x64", "--out", stage],
	]);
	assert.equal(build(h)[2][3], "nsis,msi");
	assert.equal(build(h)[3].env.CI, "true");
	assert.equal(build(h)[3].env.GENTLE_DOT_WINDOWS_PACKAGED_REQUIRED, "1");
	assert.match(h.output.stdout, /tauri build --bundles nsis,msi/);
	assert.match(h.output.stdout, /NSIS: .*Gentle Dot_0\.1\.0_x64-setup\.exe/);
	assert.match(h.output.stdout, /MSI: .*Gentle Dot_0\.1\.0_x64_en-US\.msi/);
	assert.ok(!h.mutations.some((call) => call[0] === "scratch"));
});

test("--skip-stage reuses canonical stage, applies exact console gate, builds both installers", async () => {
	const h = fixture();
	assert.equal(await h.run(["--skip-stage"]), 0, h.output.stderr);
	assert.equal(h.output.stderr, "");
	assert.equal(spawns(h).length, 1);
	assert.equal(build(h)[2][3], "nsis,msi");
	assert.deepEqual(h.mutations[0], ["console", stage, { requireManifest: true }]);
	assert.match(h.output.stdout, /Using the staged runtime in /);
});

test("--check stages/builds both, administratively extracts and hashes both payloads, then cleans scratch", async () => {
	const h = fixture();
	assert.equal(await h.run(["--check"]), 0, h.output.stderr);
	assert.equal(h.output.stderr, "");
	assert.ok(spawns(h).some((call) => call[1] === "7z" && call[2][0] === "x"));
	assert.ok(spawns(h).some((call) => call[1] === "msiexec" && call[2][0] === "/a"));
	assert.equal(h.calls.filter((call) => call[0] === "hash").length, (RUNTIME_HASH_SAMPLE.length + 1) * 4);
	assert.equal(h.mutations.at(-1)[0], "cleanup");
	assert.match(h.output.stdout, /NSIS: all .* hashes match/);
	assert.match(h.output.stdout, /MSI: all .* hashes match/);
	assert.match(h.output.stdout, /Payload check: ok \(both extractions were removed; nothing was installed\)/);
});

test("--skip-stage --check composes without a staging call", async () => {
	const h = fixture();
	assert.equal(await h.run(["--", "--skip-stage", "--check"]), 0, h.output.stderr);
	assert.ok(!spawns(h).some((call) => call[2].includes("--target")));
	assert.equal(build(h)[2][3], "nsis,msi");
	assert.ok(spawns(h).some((call) => call[1] === "msiexec"));
});

test("prior --runtime route keeps explicit-stage NSIS-only arguments, output and no installer probing", async () => {
	const h = fixture({
		size: () => {
			throw Error("must not probe upstream installer output");
		},
	});
	assert.equal(await h.run(["--runtime", "selected stage"]), 0, h.output.stderr);
	assert.equal(h.output.stderr, "");
	assert.equal(spawns(h).length, 1);
	assert.equal(build(h)[2][3], "nsis");
	assert.equal(build(h)[3].env.CI, undefined);
	assert.equal(JSON.parse(build(h)[2][5]).bundle.resources[resolve(repo, "selected stage")], "runtime");
	assert.match(h.output.stdout, /Using .*selected stage; tauri build --bundles nsis \(no staging;/);
	assert.match(h.output.stdout, /NSIS build finished; installer\/installed runtime has not been exercised/);
});

test("--runtime accepts redundant --skip-stage and checks only its NSIS output when --check is requested", async () => {
	const h = fixture();
	assert.equal(await h.run(["--runtime", "selected", "--skip-stage", "--check"]), 0, h.output.stderr);
	assert.equal(h.output.stderr, "");
	assert.equal(build(h)[2][3], "nsis");
	assert.ok(!spawns(h).some((call) => call[2].includes("--target") || call[1] === "msiexec"));
	assert.ok(spawns(h).some((call) => call[1] === "7z" && call[2][0] === "x"));
	assert.equal(h.mutations.at(-1)[0], "cleanup");
});

test("help exposes both routes without reading or mutating state", async () => {
	const h = fixture();
	assert.equal(await h.run(["--help"]), 0);
	assert.equal(h.output.stderr, "");
	for (const flag of ["--runtime", "--skip-stage", "--check", "NSIS", "MSI"])
		assert.ok(h.output.stdout.includes(flag));
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.mutations, []);
});

for (const args of [
	["--unknown"],
	["--runtime"],
	["--runtime", ""],
	["--runtime", "--check"],
	["--runtime", "a", "--runtime", "b"],
	["--help", "--check"],
]) {
	test(`reject ${JSON.stringify(args)} without touching state/counters`, async () => {
		const h = fixture();
		assert.equal(await h.run(args), 1);
		assert.equal(h.output.stdout, "");
		assert.match(h.output.stderr, /^package-windows: /);
		assert.match(h.output.stderr, /usage: package-windows/);
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.mutations, []);
	});
}

test("unsupported host fails before any reads or mutations", async () => {
	const h = fixture({ platform: "linux" });
	assert.equal(await h.run([]), 1);
	assert.equal(h.output.stdout, "");
	assert.match(h.output.stderr, /native Windows x64/);
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.mutations, []);
});

test("missing --skip-stage manifest retains prior error and does not adapt/build", async () => {
	const h = fixture({ exists: () => false });
	assert.equal(await h.run(["--skip-stage"]), 1);
	assert.equal(h.output.stdout, "");
	assert.equal(
		h.output.stderr,
		`package-windows: --skip-stage needs a staged runtime in ${stage}; run without it once.\n`,
	);
	assert.deepEqual(h.mutations, []);
});

test("mandatory addon absence prevents console adaptation and bundling on both reused-stage routes", async () => {
	for (const args of [["--skip-stage"], ["--runtime", stage]]) {
		const h = fixture({ isFile: (path) => !path.endsWith("windows-stop.node") });
		assert.equal(await h.run(args), 1);
		assert.equal(h.output.stdout, "");
		assert.match(h.output.stderr, /Missing staged artifact daemon\/native\/windows-stop.node/);
		assert.deepEqual(h.mutations, []);
	}
});

test("console refusal never reaches bundler", async () => {
	const h = fixture({
		applyConsole: () => {
			throw Error("Unknown gentle-shell source SHA-256: synthetic");
		},
	});
	assert.equal(await h.run(["--skip-stage"]), 1);
	assert.equal(h.output.stdout, "");
	assert.match(h.output.stderr, /Unknown gentle-shell source SHA-256/);
	assert.deepEqual(h.mutations, []);
});

test("asynchronous console admission finishes before bundling", async () => {
	let admitted = false;
	const h = fixture({
		applyConsole: async () => {
			await Promise.resolve();
			admitted = true;
			return { changed: false };
		},
	});
	const spawn = h.io.spawn;
	h.io.spawn = (...args) => {
		assert.equal(admitted, true, "bundling must wait for console admission");
		return spawn(...args);
	};
	assert.equal(await h.run(["--skip-stage"]), 0, h.output.stderr);
});

test("asynchronous console refusal prevents bundling and is reported by the CLI boundary", async () => {
	const h = fixture({
		applyConsole: async () => {
			throw Error("synthetic console refusal");
		},
	});
	assert.equal(await h.run(["--skip-stage"]), 1);
	assert.match(h.output.stderr, /synthetic console refusal/);
	assert.equal(build(h), undefined);
});

test("missing/small installers retain prior errors", async () => {
	const missing = fixture({ exists: (path) => !path.endsWith(names.msi) });
	assert.equal(await missing.run(["--skip-stage"]), 1);
	assert.match(missing.output.stderr, /Tauri left no MSI installer/);
	const small = fixture({ size: () => 10 });
	assert.equal(await small.run(["--skip-stage"]), 1);
	assert.equal(
		small.output.stderr,
		"package-windows: NSIS is 10 bytes: that is no installer with a payload.\n",
	);
});

test("failed staging stops before all runtime reads/adaptation/bundler calls", async () => {
	let attempts = 0;
	const h = fixture({
		spawn: () => {
			attempts++;
			return { status: 7 };
		},
	});
	assert.equal(await h.run([]), 1);
	assert.equal(attempts, 1);
	assert.match(h.output.stderr, /stage-runtime\.mjs.*failed \(exit 7\)/);
	assert.deepEqual(h.calls, []);
	assert.deepEqual(h.mutations, []);
});

test("invalid legacy product metadata stops before the bundler as in the prior CLI", async () => {
	const h = fixture({
		readJson: (path) => {
			if (path.endsWith("tauri.conf.json")) throw Error("synthetic invalid product metadata");
			return manifest;
		},
	});
	assert.equal(await h.run(["--skip-stage"]), 1);
	assert.match(h.output.stderr, /synthetic invalid product metadata/);
	assert.equal(build(h), undefined);
	assert.ok(!h.output.stdout.includes("tauri build --bundles"));
});

test("executable help and malformed arguments report real exit/stdout/stderr without native actions", () => {
	const cli = fileURLToPath(new URL("../package-windows.mjs", import.meta.url));
	const env = Object.fromEntries(
		["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"].map((key) => [key, process.env[key]]),
	);
	const help = spawnSync(process.execPath, [cli, "--help"], { env, encoding: "utf8", timeout: 5000 });
	assert.equal(help.status, 0, help.stderr);
	assert.equal(help.stderr, "");
	assert.match(help.stdout, /--skip-stage.*--check.*--runtime/);
	const bad = spawnSync(process.execPath, [cli, "--unknown"], { env, encoding: "utf8", timeout: 5000 });
	assert.equal(bad.status, 1);
	assert.equal(bad.stdout, "");
	assert.match(bad.stderr, /^package-windows: Unexpected argument --unknown\./);
});

test("payload mismatch and extractor failures propagate and still clean scratch", async () => {
	for (const kind of ["files", "extra", "hash", "extractor"]) {
		const h = fixture();
		if (kind === "files") h.io.filesIn = (path) => (path === stage ? RUNTIME_HASH_SAMPLE : []);
		if (kind === "extra")
			h.io.filesIn = (path) =>
				path === stage ? RUNTIME_HASH_SAMPLE : [...RUNTIME_HASH_SAMPLE, "unexpected"];
		if (kind === "hash") h.io.sha256File = async (path) => (path.startsWith(stage) ? "a" : "b");
		if (kind === "extractor") {
			const spawn = h.io.spawn;
			h.io.spawn = (program, args, options) =>
				args[0] === "x" ? { status: 8 } : spawn(program, args, options);
		}
		assert.equal(await h.run(["--skip-stage", "--check"]), 1);
		assert.match(
			h.output.stderr,
			kind === "files"
				? /staged files are absent/
				: kind === "extra"
					? /files the staged runtime does not/
					: kind === "hash"
						? /changed on its way in/
						: /failed \(exit 8\)/,
		);
		assert.equal(h.mutations.at(-1)[0], "cleanup");
		assert.ok(!h.output.stdout.includes("Payload check: ok"));
	}
});

test("unavailable extractors, MSI failures and absent extracted runtime fail closed and clean scratch", async () => {
	for (const kind of ["sevenzip", "msi", "runtime"]) {
		const h = fixture();
		const spawn = h.io.spawn;
		h.io.spawn = (program, args, options) =>
			(kind === "sevenzip" && args[0] === "i") || (kind === "msi" && program === "msiexec")
				? { status: 9 }
				: spawn(program, args, options);
		if (kind === "runtime") h.io.exists = (path) => !path.endsWith(join("runtime", "MANIFEST.json"));
		assert.equal(await h.run(["--skip-stage", "--check"]), 1);
		assert.match(
			h.output.stderr,
			kind === "sevenzip"
				? /none was found/
				: kind === "msi"
					? /msiexec \/a failed \(exit 9\)/
					: /NSIS installer carries no runtime/,
		);
		assert.equal(h.mutations.at(-1)[0], "cleanup");
	}
});

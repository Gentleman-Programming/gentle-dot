import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, toNamespacedPath } from "node:path";
import { type TestContext, test } from "node:test";

// Explicit opt-in without changing the inherited environment. This filename is
// deliberately outside Vitest's *.test.ts selection. No launcher is executed:
// each child only asks the installed Node to syntax-check the existing file.
const testName = "installed Windows engine launcher accepts the canonical runtime root";
const ordinaryName = "installed Windows engine ordinary resolver preserves launcher and manifest identity";
const optedIn = [testName, ordinaryName, "installed Windows engine"].some((pattern) =>
	process.execArgv.includes(`--test-name-pattern=${pattern}`),
);
const options = {
	skip:
		process.platform !== "win32"
			? "requires the actual Windows installation; not Windows evidence"
			: !optedIn
				? "requires an explicit installed Windows engine --test-name-pattern"
				: false,
};

test(testName, options, (t) => checkInstalledLauncher(t, true));
test(ordinaryName, options, (t) => checkInstalledLauncher(t, false));

async function checkInstalledLauncher(t: TestContext, canonical: boolean) {
	// The parent PowerShell wrapper must enforce this BEFORE starting Node,
	// too: rejecting it here alone cannot prevent Node startup side effects.
	assert.ok(!process.env.NODE_OPTIONS, "blocked: inherited NODE_OPTIONS is nonempty");
	assert.equal(process.version, "v24.14.1", "requires the observed installed Node");
	assert.ok(process.env.LOCALAPPDATA, "requires inherited LOCALAPPDATA");

	const expectedRuntime = join(process.env.LOCALAPPDATA, "Gentle Dot", "runtime");
	const nativeRealpath = (path: string) => realpathSync.native(path);
	const identity = (path: string) => toNamespacedPath(nativeRealpath(path)).toLowerCase();
	assert.equal(
		identity(process.execPath),
		identity(join(expectedRuntime, "node", "node.exe")),
		"must run the actual installed Node, not a copied or source Node",
	);

	// Rust fs::canonicalize yields the verbatim spelling on Windows. Some
	// Node/libuv versions strip that prefix, so restore it explicitly on the
	// real installed path rather than introducing a fixture or fake cwd.
	const actualCanonicalRoot = toNamespacedPath(nativeRealpath(dirname(dirname(process.execPath))));
	assert.equal(identity(actualCanonicalRoot), identity(expectedRuntime));
	assert.match(actualCanonicalRoot, /^\\\\\?\\[A-Za-z]:\\/, "requires the installed drive layout");
	const ordinaryRoot = actualCanonicalRoot.slice(4);
	const ordinaryLauncher = join(
		ordinaryRoot,
		"daemon",
		"node_modules",
		"gentle-pi",
		"bin",
		"gentle-shell.mjs",
	);
	assert.ok(statSync(ordinaryLauncher).isFile(), "installed launcher must already exist");

	function checkLauncher(label: string, launcher: string) {
		// No env or cwd option: the real inherited environment and cwd remain
		// untouched. --check parses only; it does not start the engine/app.
		const result = spawnSync(process.execPath, ["--check", launcher], {
			timeout: 20_000,
			maxBuffer: 1024 * 1024,
		});
		t.diagnostic(
			JSON.stringify({
				label,
				launcher,
				exit: result.status,
				signal: result.signal,
				errorCode: result.error && "code" in result.error ? result.error.code : null,
				stdoutBytes: result.stdout?.length ?? null,
				stdoutBase64: result.stdout?.toString("base64") ?? null,
				stderrBytes: result.stderr?.length ?? null,
				stderrBase64: result.stderr?.toString("base64") ?? null,
			}),
		);
		assert.ifError(result.error);
		assert.equal(result.signal, null, `${label}: must exit normally`);
		assert.equal(result.status, 0, `${label}: installed Node --check must succeed`);
		assert.equal(result.stdout.length, 0, `${label}: stdout must be empty`);
		assert.equal(result.stderr.length, 0, `${label}: stderr must be empty`);
	}

	// An import failure or a failed control is NOT behavioral RED. Stop on
	// either; only an ordinary success followed by a resolver-path failure
	// can establish the suspected downstream engine argument defect.
	checkLauncher("ordinary-control", ordinaryLauncher);
	const { bundledGentleShell } = await import("../src/config.ts");
	// This object selects the public resolver branch; it is NOT a child
	// environment replacement. Both checks inherit process.env unchanged.
	const generatedLauncher = bundledGentleShell({
		GENTLE_DOT_RUNTIME: canonical ? actualCanonicalRoot : ordinaryRoot,
	});
	assert.equal(identity(generatedLauncher), identity(ordinaryLauncher), "must select the same file");
	if (!canonical) assert.equal(generatedLauncher, ordinaryLauncher, "ordinary spelling is preserved");
	checkLauncher("production-resolver", generatedLauncher);
	if (!canonical) {
		const manifestPath = join(dirname(dirname(generatedLauncher)), "package.json");
		const manifest = readFileSync(manifestPath);
		t.diagnostic(
			JSON.stringify({
				contract: "ordinary-resolver",
				launcher: generatedLauncher,
				identity: identity(generatedLauncher),
				manifestIdentity: identity(manifestPath),
				manifestSHA256: createHash("sha256").update(manifest).digest("hex"),
				version: JSON.parse(manifest.toString("utf8")).version,
			}),
		);
	}
}

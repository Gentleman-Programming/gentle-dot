import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const readRepo = (rel) => readFileSync(join(REPO, rel), "utf8");
const stageSource = () => readRepo("scripts/package/stage-runtime.mjs");

// Observed packaged evidence (2026-10-17, isolated `build/` scratch, fake HOME, no user state):
// the installed archive in `build/linux` carries `@earendil-works/pi-codemode` 1.3.0 while the last
// working archive carries 1.1.0; the engine (`@earendil-works/pi-coding-agent` 1.0.4 in both)
// statically imports `MCP_TYPESCRIPT_PREAMBLE` from `@earendil-works/pi-codemode/declarations`
// (engine `dist/extensions/codemode/tool.js:24`), which 1.3.0 no longer exports. Importing that
// binding against 1.3.0 fails ESM linking with
// `SyntaxError: ... does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'` (exit 1), while
// 1.1.0 loads it as a string (exit 0). The daemon's `await import("@earendil-works/pi-coding-agent")`
// then rejects, `auth_list` fails, and the panel never leaves "the assistant is restarting".
function probeNamedExport({ providesPreamble }) {
	const tmp = mkdtempSync(join(REPO, "build", ".tmp-codemode-compat-"));
	try {
		const home = join(tmp, "fakehome");
		const pkg = join(tmp, "node_modules", "@earendil-works", "pi-codemode");
		mkdirSync(join(pkg, "dist"), { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(pkg, "package.json"),
			`${JSON.stringify({ name: "@earendil-works/pi-codemode", version: "0.0.0-test", type: "module", exports: { "./declarations": "./dist/declarations.js" } }, null, "\t")}\n`,
		);
		writeFileSync(
			join(pkg, "dist", "declarations.js"),
			providesPreamble
				? `export const MCP_TYPESCRIPT_PREAMBLE = "type CallToolResult = unknown;";\n`
				: `export const DEFAULT_INPUT_SCHEMA_MAX_CHARS = 16000;\n`,
		);
		return spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				"import { MCP_TYPESCRIPT_PREAMBLE } from '@earendil-works/pi-codemode/declarations'; console.log(typeof MCP_TYPESCRIPT_PREAMBLE);",
			],
			{ cwd: tmp, encoding: "utf8", env: { ...process.env, HOME: home, TMPDIR: home } },
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

describe("staged runtime codemode compatibility", () => {
	it("pins the codemode release the bundled engine still matches", () => {
		const source = stageSource();
		assert.ok(
			source.includes('"@earendil-works/pi-codemode"'),
			"stage-runtime.mjs no longer names the pinned codemode package",
		);
		assert.ok(
			source.includes('"1.1.0"'),
			"stage-runtime.mjs no longer pins codemode 1.1.0",
		);
		assert.ok(
			source.includes("pinDaemonDependency(daemon, PI_CODEMODE, PI_CODEMODE_VERSION)"),
			"stage-runtime.mjs never applies the codemode pin to the staged daemon",
		);
		assert.ok(
			source.includes("manifest.overrides"),
			"the pin no longer goes through npm overrides",
		);
	});

	it("applies the pin before installing daemon modules, without changing npm's flags", () => {
		const source = stageSource();
		assert.ok(
			source.indexOf("pinDaemonDependency(daemon,") !== -1 &&
				source.indexOf("pinDaemonDependency(daemon,") < source.indexOf("npm install --omit=dev"),
			"the codemode pin must run before `npm install --omit=dev`",
		);
		for (const flag of ["--omit=dev", "--no-bin-links", "--no-audit", "--no-fund", "--foreground-scripts"])
			assert.ok(
				source.includes(`"${flag}"`),
				`staging lost its npm flag ${flag}`,
			);
	});

	it("documents why the range cannot float (preamble removal breaks auth_list)", () => {
		const source = stageSource();
		assert.ok(
			source.includes("MCP_TYPESCRIPT_PREAMBLE"),
			"the pin lost the rationale naming the removed export",
		);
		assert.ok(
			source.includes("auth_list"),
			"the pin lost the rationale naming the failing daemon call",
		);
	});

	it("fails module linking when the preamble export is missing (the packaged failure mode)", () => {
		const run = probeNamedExport({ providesPreamble: false });
		assert.equal(run.status, 1, `expected a linking failure.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
		assert.match(
			run.stderr,
			/does not provide an export named 'MCP_TYPESCRIPT_PREAMBLE'/,
			`unexpected stderr:\n${run.stderr}`,
		);
	});

	it("loads the preamble when the pinned shape provides it (the working control)", () => {
		const run = probeNamedExport({ providesPreamble: true });
		assert.equal(run.status, 0, `the control import failed.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
		assert.equal(run.stdout.trim(), "string");
	});

	it("keeps refusing an unknown target through the public CLI", () => {
		const run = spawnSync(
			process.execPath,
			["scripts/package/stage-runtime.mjs", "--target", "windows-x64"],
			{ cwd: REPO, encoding: "utf8" },
		);
		assert.notEqual(run.status, 0, "an unknown target must still fail");
		assert.match(run.stderr, /Unknown target windows-x64/, `unexpected stderr:\n${run.stderr}`);
		assert.match(run.stderr, /^stage-runtime: /m, `unexpected stderr:\n${run.stderr}`);
	});

	it("keeps refusing a non-empty output folder without a staged runtime", () => {
		const tmp = mkdtempSync(join(REPO, "build", ".tmp-stage-out-"));
		try {
			writeFileSync(join(tmp, "junk.txt"), "not a runtime");
			const run = spawnSync(
				process.execPath,
				["scripts/package/stage-runtime.mjs", "--target", "linux-x64", "--out", tmp],
				{ cwd: REPO, encoding: "utf8" },
			);
			assert.notEqual(run.status, 0, "a foreign non-empty --out must still fail");
			assert.match(run.stderr, /holds no staged runtime/, `unexpected stderr:\n${run.stderr}`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

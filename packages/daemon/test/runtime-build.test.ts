import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(PACKAGE, "..", "..");
const BUILD = join(PACKAGE, "scripts", "build-runtime.ts");
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
/** Evidence and build scratch for this check; gitignored, and removed in teardown. */
const CHECK_DIR = join(REPO, "build", "runtime-dependency-check");

let out: string;

beforeAll(() => {
	out = tempDir();
	const build = spawnSync(process.execPath, [BUILD, "--out", out], { encoding: "utf8" });
	expect(build.stderr).toBe("");
	expect(build.status).toBe(0);
}, 60_000);

function listFiles(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`)
			: [`${prefix}${entry.name}`],
	);
}

describe("build:runtime", () => {
	it("emits the daemon part of the runtime layout, without node_modules", () => {
		expect(listFiles(out).sort()).toEqual([
			"bin/pi",
			"daemon/cli.mjs",
			"daemon/engine-access.ts",
			"daemon/extensions/approval-guard.ts",
			"daemon/extensions/screenshot-context.ts",
			"daemon/identity.md",
			"daemon/limits.ts",
			"daemon/package.json",
			"daemon/private-file.ts",
		]);
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
	});

	it("lists the external dependencies with the lockfile's exact versions", () => {
		const manifest = JSON.parse(readFileSync(join(out, "daemon", "package.json"), "utf8"));
		expect(manifest).toMatchObject({ private: true, type: "module" });
		expect(manifest.dependencies).toEqual({
			"@earendil-works/pi-ai": "1.0.4",
			"@earendil-works/pi-coding-agent": "1.0.4",
			"@earendil-works/pi-mcp": "1.0.4",
			"@earendil-works/pi-tui": "1.0.4",
			"gentle-pi": "4.0.0",
			jiti: "2.7.0",
			ws: "8.22.0",
		});
	});

	it("runs its self-check from the output with the engine resolved inside it", () => {
		symlinkSync(join(PACKAGE, "node_modules"), join(out, "daemon", "node_modules"));
		const check = spawnSync(process.execPath, [join(out, "daemon", "cli.mjs"), "--self-check"], {
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: tempDir(),
				GENTLE_DOT_DATA_DIR: tempDir(),
				GENTLE_DOT_RUNTIME: out,
				ENGRAM_BIN: "/x/engram",
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
			engramBin: "/x/engram",
		});
		expect(realpathSync(report.approvalGuard)).toBe(join(real, "daemon", "extensions", "approval-guard.ts"));
		expect(realpathSync(report.identity)).toBe(join(real, "daemon", "identity.md"));
	});

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
});

/** The files a source text needs at runtime: `import type` is erased by Node, so it names none. */
function runtimeSpecifiers(text: string): string[] {
	return [
		...text
			.replace(/\b(?:import|export)\s+type\b[^;]*;/g, "")
			.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g),
	]
		.map((match) => match[1] ?? "")
		.filter((specifier) => specifier.startsWith("."));
}

/**
 * The request-shaping extension loaded the way the engine loads it: from the staged file, by Node,
 * with the learned ceiling in force. Nothing here reads the sources.
 */
const SHAPE_PROBE = `
const { applyRequestBudget, pruneScreenshots } = await import(SOURCE_URL);
const guard = await import(GUARD_URL);
const messages = [
	{ role: "user", content: "hola" },
	{ role: "toolResult", toolName: "mcp__computer__screenshot", content: [
		{ type: "image", data: "a".repeat(1024) },
		{ type: "text", text: "shot" },
	] },
	{ role: "toolResult", toolName: "mcp__computer__screenshot", content: [
		{ type: "image", data: "b".repeat(1024) },
	] },
	{ role: "user", content: "y la segunda" },
];
const budgeted = applyRequestBudget(messages);
const underBudget = applyRequestBudget(messages, 4096);
const pruned = pruneScreenshots(messages);
process.stdout.write(JSON.stringify({
	budgeted,
	budgetedKeptInput: budgeted === messages,
	underBudgetKeptInput: underBudget === messages,
	pruned,
	prunedKeptInput: pruneScreenshots(messages) === messages,
	guardIsFunction: typeof guard.default === "function",
}));
`;

const OMITTED = { type: "text", text: "[earlier screenshot omitted: screenshot]" };

/** The one message the shape probe is expected to rewrite, whichever step rewrote it. */
function budgetedMessages() {
	return [
		{ role: "user", content: "hola" },
		{
			role: "toolResult",
			toolName: "mcp__computer__screenshot",
			content: [{ type: "text", text: "shot" }, OMITTED],
		},
		{
			role: "toolResult",
			toolName: "mcp__computer__screenshot",
			content: [{ type: "image", data: "b".repeat(1024) }],
		},
		{ role: "user", content: "y la segunda" },
	];
}

describe("build:runtime staged extensions", () => {
	let staged: string;
	let limits: string;

	beforeAll(() => {
		mkdirSync(CHECK_DIR, { recursive: true });
		staged = mkdtempSync(join(CHECK_DIR, "runtime-"));
		limits = tempDir();
		writeFileSync(
			join(limits, "provider-limits.json"),
			`${JSON.stringify({ model: "test-model", ceilings: { "test-model": 1500 } })}\n`,
		);
		const build = spawnSync(process.execPath, [BUILD, "--out", staged], { encoding: "utf8" });
		expect(build.stderr).toBe("");
		expect(build.status).toBe(0);
	}, 60_000);

	afterAll(() => {
		if (staged) rmSync(staged, { recursive: true, force: true });
	});

	it("loads the staged request shaper from the output, by Node alone", () => {
		const daemon = join(staged, "daemon");
		const source = join("daemon", "extensions", "screenshot-context.ts");
		const probe = `const SOURCE_URL = ${JSON.stringify(
			pathToFileURL(join(staged, source)).href,
		)};\nconst GUARD_URL = ${JSON.stringify(
			pathToFileURL(join(staged, "daemon", "extensions", "approval-guard.ts")).href,
		)};\n${SHAPE_PROBE}`;
		const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
			encoding: "utf8",
			cwd: daemon,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: tempDir(),
				GENTLE_DOT_REQUEST_BUDGET_BYTES: "4096",
				GENTLE_DOT_PROVIDER_LIMITS_FILE: join(limits, "provider-limits.json"),
			},
		});
		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		const shaped = budgetedMessages();
		expect(JSON.parse(run.stdout)).toEqual({
			budgeted: shaped,
			budgetedKeptInput: false,
			underBudgetKeptInput: true,
			pruned: shaped,
			prunedKeptInput: false,
			guardIsFunction: true,
		});
	});

	it("stages every file the shaper imports, with no link back to the sources", () => {
		const daemon = join(staged, "daemon");
		const stagedFiles = listFiles(daemon).filter((file) => file.endsWith(".ts"));
		expect(stagedFiles.sort()).toEqual([
			"engine-access.ts",
			"extensions/approval-guard.ts",
			"extensions/screenshot-context.ts",
			"limits.ts",
			"private-file.ts",
		]);
		for (const file of stagedFiles) {
			const path = join(daemon, file);
			// A link back into the sources would hide a missing dependency from this check.
			expect(lstatSync(path).isSymbolicLink(), file).toBe(false);
			for (const specifier of runtimeSpecifiers(readFileSync(path, "utf8"))) {
				const target = resolve(dirname(path), specifier);
				expect(relative(daemon, target).startsWith(".."), `${file} imports ${specifier}`).toBe(false);
				expect(existsSync(target), `${file} imports ${specifier}`).toBe(true);
			}
		}
	});
});

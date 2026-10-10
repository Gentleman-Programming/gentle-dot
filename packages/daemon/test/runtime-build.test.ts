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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
const BUILD = join(PACKAGE, "scripts", "build-runtime.ts");
const ENGINE_CLI = join("@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

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
			"daemon/extensions/approval-guard.ts",
			"daemon/extensions/command-code.ts",
			"daemon/extensions/screenshot-context.ts",
			"daemon/identity.md",
			"daemon/package.json",
		]);
		expect(readFileSync(join(out, "daemon", "identity.md"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "identity.md"), "utf8"),
		);
		expect(readFileSync(join(out, "daemon", "extensions", "approval-guard.ts"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "extensions", "approval-guard.ts"), "utf8"),
		);
		expect(readFileSync(join(out, "daemon", "extensions", "command-code.ts"), "utf8")).toBe(
			readFileSync(join(PACKAGE, "src", "extensions", "command-code.ts"), "utf8"),
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

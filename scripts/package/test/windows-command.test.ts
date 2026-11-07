import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { windowsReleaseConfig } from "../lib.mjs";
import { spawnCommandSync } from "../windows-command.mjs";

const root = fileURLToPath(new URL("../../../build/tooling/", import.meta.url));
mkdirSync(root, { recursive: true });
const scratch = mkdtempSync(join(root, "pnpm launcher "));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const probe = join(scratch, "argument probe.cjs");
writeFileSync(
	probe,
	`process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), marker: process.env.LAUNCH_MARKER }));
process.stderr.write("probe stderr");
process.exit(Number(process.env.LAUNCH_EXIT || 0));\n`,
);
const config = windowsReleaseConfig({ runtime: "D:\\build space\\runtime\\win-x64" });
const args = ["--config", JSON.stringify(config), "space & (parentheses)", "", 'embedded "quote"'];
const options = {
	cwd: scratch,
	env: { ...process.env, LAUNCH_MARKER: "preserved" },
	encoding: "utf8" as const,
	stdio: "pipe" as const,
};

function assertProbe(result: SpawnSyncReturns<string>, status = 0) {
	expect(result.error ?? null).toBeNull();
	expect(result.status).toBe(status);
	expect(result.signal).toBeNull();
	expect(result.stderr).toBe("probe stderr");
	const output = JSON.parse(result.stdout);
	expect(output).toEqual({ args, cwd: scratch, marker: "preserved" });
	expect(JSON.parse(output.args[1])).toEqual(config);
}

describe("packaging command subprocess interface", () => {
	it("preserves native executable arguments, cwd, env and both streams", () => {
		assertProbe(spawnCommandSync(process.execPath, [probe, ...args], options));
	});

	it("keeps nonzero status and output without converting failure into success", () => {
		assertProbe(
			spawnCommandSync(process.execPath, [probe, ...args], {
				...options,
				env: { ...options.env, LAUNCH_EXIT: "23" },
			}),
			23,
		);
	});

	it("reports a missing command as ENOENT with the platform's failure status", () => {
		const command = join(scratch, "missing-command");
		const result = spawnCommandSync(command, [], options);
		// Windows cmd.exe exits 1; cross-spawn also identifies the missing command as ENOENT.
		expect(result.status).toBe(process.platform === "win32" ? 1 : null);
		expect(result.error).toMatchObject({ code: "ENOENT", path: command, spawnargs: [] });
		expect(result.signal).toBeNull();
		if (process.platform === "win32") {
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("missing-command");
		} else {
			const native = spawnSync(command, [], options);
			expect([result.stdout, result.stderr, result.output]).toEqual([
				native.stdout,
				native.stderr,
				native.output,
			]);
		}
	});

	it.runIf(process.platform !== "win32")("runs a POSIX pnpm executable with spaces in its path", () => {
		const launcher = join(scratch, "pnpm");
		writeFileSync(launcher, `#!${process.execPath}\nimport(${JSON.stringify(probe)});\n`);
		chmodSync(launcher, 0o755);
		assertProbe(spawnCommandSync(launcher, args, options));
		const failedOptions = { ...options, env: { ...options.env, LAUNCH_EXIT: "23" } };
		assertProbe(spawnCommandSync(launcher, args, failedOptions), 23);
		// Public subprocess differential: POSIX launching remains Node's direct execution.
		for (const settings of [options, failedOptions]) {
			const before = spawnSync(launcher, args, settings);
			const after = spawnCommandSync(launcher, args, settings);
			expect([after.status, after.stdout, after.stderr]).toEqual([
				before.status,
				before.stdout,
				before.stderr,
			]);
		}
	});

	it.runIf(process.platform === "win32")("runs explicit pnpm.cmd and PATH lookup on Windows", () => {
		const launcher = join(scratch, "pnpm.cmd");
		writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`);
		assertProbe(spawnCommandSync(launcher, args, options));
		assertProbe(
			spawnCommandSync(launcher, args, {
				...options,
				env: { ...options.env, LAUNCH_EXIT: "23" },
			}),
			23,
		);
		const env = Object.fromEntries(
			Object.entries(options.env).filter(([key]) => key.toLowerCase() !== "path"),
		);
		env.PATH = `${scratch};${process.env.PATH ?? ""}`;
		env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
		assertProbe(spawnCommandSync("pnpm", args, { ...options, env }));
	});
});

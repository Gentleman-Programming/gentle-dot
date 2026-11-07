import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { claimDaemonAdmission } from "../src/daemon-admission.ts";
import { claimDaemonDirs } from "../src/daemon-claim.ts";
import { fixtureNodeArgs, fixtureNodeEnv, tempDir } from "./helpers.ts";

const probe = fileURLToPath(new URL("./fixtures/account-home-probe.mjs", import.meta.url));

it("refuses an unisolated metadata probe before looking up any real account", () => {
	const home = tempDir();
	const result = spawnSync(process.execPath, [probe], {
		env: fixtureNodeEnv({ PATH: process.env.PATH }, home),
		encoding: "utf8",
		timeout: 5000,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		code: 78,
		stdout: "account-home isolation missing\n",
		stderr: "",
	});
	expect(readdirSync(home)).toEqual([]);
});

it("forwards an owned shared admission default and preserves missing-home first run", async () => {
	const root = tempDir();
	const sdkHome = join(root, "missing-sdk");
	let registry = "";
	const lease = await claimDaemonAdmission({
		dataDir: join(root, "data"),
		sdkHome,
		accountHome: undefined,
		claim: (targets) => {
			registry ||= targets[0]?.path ?? "";
			return claimDaemonDirs(targets);
		},
	});
	try {
		const local = relative(realpathSync(tmpdir()), realpathSync(dirname(registry)));
		expect(local).not.toMatch(/^\.\./);
		expect(isAbsolute(local)).toBe(false);
		expect(registry).toBe(join(dirname(registry), ".gentle-dot-daemon-claims"));
		expect(lease.pendingHome).toBe(true);
		expect(existsSync(sdkHome)).toBe(false);
	} finally {
		lease.release();
	}
});

it("preserves explicit account providers, their access bracket and shared-registry exclusion", async () => {
	const root = tempDir();
	const account = tempDir();
	const sdkHome = tempDir();
	let inside = false;
	let lookups = 0;
	const options = {
		sdkHome,
		startupAttempts: 1,
		engineAccess: <T>(operation: () => T): T => {
			inside = true;
			try {
				return operation();
			} finally {
				inside = false;
			}
		},
		accountHome: () => {
			expect(inside).toBe(true);
			lookups++;
			return account;
		},
	};
	const first = await claimDaemonAdmission({ ...options, dataDir: join(root, "a") });
	try {
		await expect(claimDaemonAdmission({ ...options, dataDir: join(root, "b") })).rejects.toThrow(
			/already running/,
		);
		expect(lookups).toBe(2);
		expect(existsSync(join(account, ".gentle-dot-daemon-claims"))).toBe(true);
		expect(existsSync(join(root, "b"))).toBe(false);
	} finally {
		first.release();
	}
});

it("isolates native ESM, default and CJS account metadata without touching HOME", () => {
	const home = tempDir();
	const env = fixtureNodeEnv({ PATH: process.env.PATH }, home);
	const before = readdirSync(env.GENTLE_DOT_TEST_ACCOUNT_HOME as string, { recursive: true });
	const result = spawnSync(process.execPath, fixtureNodeArgs(probe), {
		env,
		encoding: "utf8",
		timeout: 5000,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect({ code: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		code: 0,
		stdout: "fixture metadata isolated: named/default/cjs; effective-user routing; buffer encoding\n",
		stderr: "",
	});
	expect(readdirSync(home)).toEqual([]);
	expect(readdirSync(env.GENTLE_DOT_TEST_ACCOUNT_HOME as string, { recursive: true })).toEqual(before);
});

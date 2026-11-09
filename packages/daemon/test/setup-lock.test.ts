import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearStaleSetupLock,
	isProcessAlive,
	SETUP_LOCK_FILE,
	SETUP_OWNER_FILE,
	writeSetupLockOwner,
} from "../src/setup-lock.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { FAKE_AGENT, waitFor } from "./helpers.ts";

// Scratch homes live outside the worktree and are removed in teardown.
const scratchDirs: string[] = [];
const running: AgentSupervisor[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-dot-setup-lock-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(running.splice(0).map((supervisor) => supervisor.stop().catch(() => {})));
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A pid that is provably gone: a child we started and let exit. */
async function exitedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
	const pid = child.pid;
	await once(child, "exit");
	if (pid === undefined) throw new Error("the probe child never got a pid");
	return pid;
}

function homeWithLock(owner?: string): string {
	const home = scratch();
	writeFileSync(join(home, SETUP_LOCK_FILE), "");
	if (owner !== undefined) writeFileSync(join(home, SETUP_OWNER_FILE), owner);
	return home;
}

const alive = () => true;
const dead = () => false;

describe("clearStaleSetupLock", () => {
	it("does nothing when there is no lock", () => {
		const home = scratch();
		expect(clearStaleSetupLock(home, undefined, alive)).toBe("no-lock");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
		expect(existsSync(join(home, SETUP_OWNER_FILE))).toBe(false);
	});

	it("clears the lock and the owner record when our owner pid is dead", () => {
		const home = homeWithLock("424242");
		expect(clearStaleSetupLock(home, undefined, dead)).toBe("cleared");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
		expect(existsSync(join(home, SETUP_OWNER_FILE))).toBe(false);
	});

	it("leaves the lock alone when our owner pid is still alive", () => {
		const home = homeWithLock("424242");
		expect(clearStaleSetupLock(home, undefined, alive)).toBe("held");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(true);
		expect(existsSync(join(home, SETUP_OWNER_FILE))).toBe(true);
	});

	it("leaves the lock when there is no owner record to prove it is ours", () => {
		const home = homeWithLock();
		expect(clearStaleSetupLock(home, undefined, dead)).toBe("unproven");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(true);
		expect(existsSync(join(home, SETUP_OWNER_FILE))).toBe(false);
	});

	it("leaves the lock when the owner record cannot be read as a pid", () => {
		for (const text of ["not-a-pid", "", "0", "-1", "1e3", "0x10"]) {
			const home = homeWithLock(text);
			expect(clearStaleSetupLock(home, undefined, dead)).toBe("unproven");
			expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(true);
		}
	});

	it("never clears a lock a live owner holds, however old the lock is", () => {
		const home = homeWithLock(String(process.pid));
		const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
		utimesSync(join(home, SETUP_LOCK_FILE), yesterday, yesterday);
		// Upstream's own 15-minute mtime expiry is not ours to change: a live owner still wins.
		expect(clearStaleSetupLock(home, undefined, alive)).toBe("held");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(true);
	});

	it("decides only by the injected liveness, so every branch holds on every platform", () => {
		// The same fixture with opposite liveness flips the decision, and the pid is this live
		// process, so a host-specific check could not produce either answer by accident.
		expect(clearStaleSetupLock(homeWithLock(String(process.pid)), undefined, alive)).toBe("held");
		expect(clearStaleSetupLock(homeWithLock(String(process.pid)), undefined, dead)).toBe("cleared");
		expect(clearStaleSetupLock(homeWithLock("424242"), undefined, alive)).toBe("held");
		expect(clearStaleSetupLock(homeWithLock("424242"), undefined, dead)).toBe("cleared");
	});
});

describe("writeSetupLockOwner", () => {
	it("records the pid as text in the owner file", () => {
		const home = scratch();
		writeSetupLockOwner(home, 12345);
		expect(readFileSync(join(home, SETUP_OWNER_FILE), "utf8")).toBe("12345");
	});
});

describe("isProcessAlive", () => {
	it("is true for a live process and false for one that has exited", async () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isProcessAlive(await exitedPid())).toBe(false);
	});

	it("answers false for a pid that cannot name a process", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
		expect(isProcessAlive(1.5)).toBe(false);
	});
});

describe("AgentSupervisor engine lock", () => {
	function supervise(home: string, command = process.execPath): AgentSupervisor {
		const supervisor = new AgentSupervisor({
			command,
			args: [FAKE_AGENT, "--home", home],
			cwd: home,
			dataDir: scratch(),
			backoffMs: [50, 100, 200],
			startTimeoutMs: 2000,
		});
		running.push(supervisor);
		return supervisor;
	}

	it("clears a stale lock before spawning and records the new engine's pid", async () => {
		const home = scratch();
		writeFileSync(join(home, SETUP_LOCK_FILE), "");
		writeFileSync(join(home, SETUP_OWNER_FILE), String(await exitedPid()));
		const supervisor = supervise(home);
		await supervisor.start();
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(false);
		expect(readFileSync(join(home, SETUP_OWNER_FILE), "utf8")).toBe(String(supervisor.pid));
		expect(isProcessAlive(supervisor.pid ?? 0)).toBe(true);
		await supervisor.stop();
	});

	it("leaves a lock a live owner holds", async () => {
		const home = scratch();
		writeFileSync(join(home, SETUP_LOCK_FILE), "");
		writeFileSync(join(home, SETUP_OWNER_FILE), String(process.pid));
		const supervisor = supervise(home);
		// The lock belongs to a live process (this test), so the supervisor cannot clear it.
		expect(clearStaleSetupLock(home, undefined, isProcessAlive)).toBe("held");
		expect(existsSync(join(home, SETUP_LOCK_FILE))).toBe(true);
		await supervisor.start();
		expect(readFileSync(join(home, SETUP_OWNER_FILE), "utf8")).toBe(String(supervisor.pid));
		await supervisor.stop();
	});

	it("records the new owner on every spawn attempt", async () => {
		const home = scratch();
		const supervisor = supervise(home);
		await supervisor.start();
		const first = supervisor.pid;
		await supervisor.request({ type: "prompt", message: "crash" });
		await waitFor(() => supervisor.pid !== undefined && supervisor.pid !== first);
		expect(readFileSync(join(home, SETUP_OWNER_FILE), "utf8")).toBe(String(supervisor.pid));
		await supervisor.stop();
	});

	it("does not write the owner record when the spawn fails", async () => {
		const home = scratch();
		const supervisor = supervise(home, join(home, "engine-that-does-not-exist"));
		await expect(supervisor.start()).rejects.toThrow();
		expect(existsSync(join(home, SETUP_OWNER_FILE))).toBe(false);
		await supervisor.stop();
	});
});

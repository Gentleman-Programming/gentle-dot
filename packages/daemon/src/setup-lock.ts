/**
 * The engine's own provisioning lock, and our record of who holds it.
 *
 * `gentle-shell` creates `<home>/.gentle-shell-setup.lock` with an exclusive `openSync(..., "wx")`
 * and writes nothing into it, and it releases the lock from a `finally` with no exit or signal
 * hook. A hard kill therefore runs no JavaScript and leaves the empty lock behind, and the next
 * start skips setup until upstream's own 15-minute mtime expiry clears it
 * (odd/tasks/windows-port.md, L67). That expiry is upstream's and is untouched here.
 *
 * We cannot write into the lock — it is upstream's file and is created empty — so ownership is
 * decided from a second file we own, `<home>/.gentle-shell-setup.owner`, holding the pid of the
 * engine process the daemon spawned. The decision is pure over injected effects, so every branch
 * is asserted on every OS; only liveness is platform-specific.
 *
 * It never clears a lock it cannot prove is ours: with no owner record, or one that does not read
 * back as a pid, it leaves the lock for upstream's expiry rather than guessing.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The empty lock `gentle-shell` creates in its home; upstream's file, never written to. */
export const SETUP_LOCK_FILE = ".gentle-shell-setup.lock";

/** Our record of the engine we spawned: the pid of the process that holds the lock. */
export const SETUP_OWNER_FILE = ".gentle-shell-setup.owner";

/** What `clearStaleSetupLock` did, so a caller (and a test) can assert the branch it took. */
export type SetupLockDecision = "no-lock" | "held" | "unproven" | "cleared";

/** The filesystem effects the lock decision reads and applies. */
export interface SetupLockIo {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, data: string): void;
	remove(path: string): void;
}

const nodeSetupLockIo: SetupLockIo = {
	exists: (path) => existsSync(path),
	read: (path) => readFileSync(path, "utf8"),
	write: (path, data) => writeFileSync(path, data),
	remove: (path) => rmSync(path, { force: true }),
};

/** The lock and owner paths in one engine home. */
export function setupLockPaths(home: string): { lock: string; owner: string } {
	return { lock: join(home, SETUP_LOCK_FILE), owner: join(home, SETUP_OWNER_FILE) };
}

/** The pid in an owner record, or undefined when the text is not a usable positive integer. */
function ownerPid(text: string): number | undefined {
	const trimmed = text.trim();
	// Digits only: `Number` would accept "0x10" and "1e3" as pids, and a record we never wrote
	// should not be trusted into a deletion decision.
	if (!/^\d+$/.test(trimmed)) return undefined;
	const pid = Number(trimmed);
	return pid > 0 ? pid : undefined;
}

/**
 * Whether a pid names a live process.
 *
 * `process.kill(pid, 0)` sends no signal and only asks the OS whether the process exists, which
 * Node supports on Windows too. A plain "no such process" (`ESRCH`) is the only answer that proves
 * the pid is gone; every other failure — a permission error on a process we may not signal
 * included, and anything a future platform reports that this code does not recognise — answers
 * "alive". The dangerous direction is clearing a lock a live run holds, so only a proof clears it.
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * Decides whether an abandoned engine lock may be cleared, and clears the lock and our owner
 * record when it may. The rule is exactly:
 *
 * - no lock: nothing to do;
 * - lock and our owner record, owner alive: leave it, someone is provisioning;
 * - lock and our owner record, owner not alive: remove both;
 * - lock and no usable owner record: leave it, we cannot prove it is ours.
 */
export function clearStaleSetupLock(
	home: string,
	io: SetupLockIo = nodeSetupLockIo,
	pidAlive: (pid: number) => boolean = isProcessAlive,
): SetupLockDecision {
	const { lock, owner } = setupLockPaths(home);
	if (!io.exists(lock)) return "no-lock";
	if (!io.exists(owner)) return "unproven";
	let pid: number | undefined;
	try {
		pid = ownerPid(io.read(owner));
	} catch {
		// An unreadable owner record proves nothing about the lock, so it is left alone.
		return "unproven";
	}
	if (pid === undefined) return "unproven";
	if (pidAlive(pid)) return "held";
	io.remove(lock);
	io.remove(owner);
	return "cleared";
}

/**
 * Records the engine the daemon just spawned as the lock's owner. The pid is not a secret; the
 * file is written through the same injected effects so the decision above stays testable everywhere.
 */
export function writeSetupLockOwner(home: string, pid: number, io: SetupLockIo = nodeSetupLockIo): void {
	io.write(setupLockPaths(home).owner, String(pid));
}

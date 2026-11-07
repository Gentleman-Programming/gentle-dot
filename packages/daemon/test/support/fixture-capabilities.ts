// Test fixtures whose POSIX mechanism does not port to Windows, and the portable substitutes.
//
// Three things a fixture needs on POSIX behave differently on Windows, and each substitute is
// measured rather than assumed (odd/tasks/windows-port.md):
//
// - A **directory link**. `symlinkSync(dir, link)` needs `SeCreateSymbolicLinkPrivilege` on a plain
//   Windows install (it fails with `EPERM` unless Developer Mode is on). A **junction** needs no
//   privilege: `symlinkSync(dir, link, "junction")` succeeds and `lstatSync(link).isSymbolicLink()`
//   is `true`, so directory links go through `symlinkDirectory` and run everywhere.
// - A **file link**, which has no unprivileged substitute: junctions are directory-only and a
//   hardlink is not a symlink, so `lstatSync().isSymbolicLink()` would be false and the fixture
//   would stop testing what it exists to test. The capability is probed (`fileSymlinkCapability`) and
//   the fixture skips where it is absent.
// - An **unwritable directory**. Clearing a directory's write bit is how a POSIX test simulates a
//   folder the code cannot write to. Windows honours the write, so the fixture's failure path is
//   never taken there and the test asserts nothing. An ACL does not help either: `icacls <dir>
//   /deny` in three forms still allowed the write, because a process at High Mandatory Level with
//   `SeBackupPrivilege` and `SeRestorePrivilege` enabled bypasses the DACL. The capability is
//   therefore probed, never assumed, and the fixture skips loudly where it is absent.
//
// Like `posix-modes.ts`, a skip announces itself: a green run must not quietly assert nothing. It
// writes to the raw stderr stream rather than `console.warn`, because vitest's default reporter
// hides console output from a test that ends up skipped, so a plain `pnpm test` would show `3
// skipped` with no reason at all. The write is emitted per call, not once per process, so a second
// fixture in the same file cannot go silent behind the first (W18).
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The link type a directory link needs: Windows does junctions without a privilege. */
export function directoryLinkType(platform: NodeJS.Platform = process.platform): "junction" | "dir" {
	return platform === "win32" ? "junction" : "dir";
}

/** `symlinkSync` for a directory target, portable: a junction on Windows, a directory link elsewhere. */
export function symlinkDirectory(target: string, path: string): void {
	symlinkSync(target, path, directoryLinkType());
}

let probed: boolean | undefined;

/** Creates a directory, clears its write bit, and reports whether a write inside it was refused. */
function probeUnwritableDirectory(): boolean {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-fixture-capability-"));
	const folder = join(scratch, "unwritable");
	try {
		mkdirSync(folder);
		chmodSync(folder, 0o555);
		try {
			writeFileSync(join(folder, "probe"), "probe");
			return false;
		} catch {
			return true;
		} finally {
			chmodSync(folder, 0o755);
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

function warnSkipped(label: string): void {
	// Raw stderr, not `console.warn`: vitest's default reporter drops console output from a skipped
	// test, so this is the only channel a plain `pnpm test` shows.
	process.stderr.write(
		`fixture-capabilities: skipping ${label}; a write inside a write-bit-cleared directory still ` +
			"succeeded on this host, so the unwritable-folder fixture would test nothing " +
			"(see odd/tasks/windows-port.md).\n",
	);
}

/**
 * Whether clearing the write bit actually stops a write on this host, probed once and cached.
 * When it does not, warns once per call naming `label` and the measured reason, then answers false.
 */
export function canMakeDirectoryUnwritable(label: string): boolean {
	probed ??= probeUnwritableDirectory();
	if (!probed) warnSkipped(label);
	return probed;
}

/** The privileged call a file-symlink probe makes, and its verification of what the call left. */
export interface SymlinkAttempt {
	/** The attempt itself; throws whatever the host refuses with (`EPERM` on a plain Windows install). */
	create(target: string, path: string): void;
	/** Whether the path the attempt left behind is a symbolic link. */
	isLink(path: string): boolean;
}

/** What the file-symlink probe found: the decision, and the reason a caller prints when it says no. */
export interface FileSymlinkCapability {
	canCreate: boolean;
	reason?: string;
}

/** The real attempt: `symlinkSync`, verified the way Node allows, with `lstatSync(...).isSymbolicLink()`. */
const realSymlinkAttempt: SymlinkAttempt = {
	create: (target, path) => symlinkSync(target, path),
	isLink: (path) => lstatSync(path).isSymbolicLink(),
};

/** Why an attempt failed, in the words the skip line prints: Node's error code where there is one. */
function refusalReason(error: unknown): string {
	if (error && typeof error === "object" && "code" in error) {
		return `the attempt failed with ${String((error as { code: unknown }).code)}`;
	}
	return "the attempt failed";
}

/** Makes one attempt on a file in a scratch directory and removes the scratch directory. */
function runFileSymlinkProbe(attempt: SymlinkAttempt): FileSymlinkCapability {
	const scratch = mkdtempSync(join(tmpdir(), "gentle-dot-fixture-capability-"));
	const target = join(scratch, "target");
	const link = join(scratch, "link");
	try {
		writeFileSync(target, "probe");
		try {
			attempt.create(target, link);
		} catch (error) {
			return { canCreate: false, reason: refusalReason(error) };
		}
		let isLink = false;
		try {
			isLink = attempt.isLink(link);
		} catch {
			isLink = false;
		}
		return isLink
			? { canCreate: true }
			: { canCreate: false, reason: "the attempt left something that is not a symbolic link" };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

let fileSymlinkProbed: FileSymlinkCapability | undefined;

/**
 * Whether this host can create a **file** symlink: the decision and, when it cannot, the reason to
 * print. Node exposes no query for the privilege, so the probe is the attempt itself on a file in
 * `tmpdir()`, verified with `lstat().isSymbolicLink()`. The answer is cached once per process, so an
 * injected `attempt` is honoured on the **first** call only; a test that forces a branch imports a
 * fresh module (`vi.resetModules()`) and gets a fresh cache.
 */
export function fileSymlinkCapability(attempt: SymlinkAttempt = realSymlinkAttempt): FileSymlinkCapability {
	fileSymlinkProbed ??= runFileSymlinkProbe(attempt);
	return fileSymlinkProbed;
}

function warnSkippedFileSymlink(label: string, reason: string): void {
	// Raw stderr, for the reason `warnSkipped` gives above. One line, naming the way out.
	process.stderr.write(
		`fixture-capabilities: skipping ${label}; this host refuses to create a file symlink ` +
			`(${reason}), and a file symlink has no unprivileged substitute here (a junction is ` +
			"directory-only and a hardlink is not a link); turn on Windows Developer Mode, or run the " +
			"suite from an elevated terminal, to run it (see odd/tasks/windows-port.md).\n",
	);
}

/**
 * Whether this host can create a **file** symlink, probed once and cached. When it cannot, warns once
 * per call naming `label` and the measured reason, then answers false. The `attempt` is injectable
 * and honoured on the first call only (see `fileSymlinkCapability`).
 */
export function canCreateFileSymlinks(label: string, attempt: SymlinkAttempt = realSymlinkAttempt): boolean {
	const probe = fileSymlinkCapability(attempt);
	if (!probe.canCreate) warnSkippedFileSymlink(label, probe.reason ?? "the attempt failed");
	return probe.canCreate;
}

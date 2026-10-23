// The three fixture mechanisms, proven on every OS: the link type takes an injected platform, the
// write-bit probe is compared against an independent measurement rather than a hardcoded answer, the
// file-symlink probe takes an injected attempt so both of its answers are asserted without the
// privilege, and the announcement is forced both ways with a mocked `node:fs`, so both branches run
// wherever the suite runs. Nothing here asserts a Windows or POSIX answer.
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canMakeDirectoryUnwritable, directoryLinkType, symlinkDirectory } from "./fixture-capabilities.ts";

const scratchDirs: string[] = [];

/** A temp directory outside the worktree, removed after the test. */
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-dot-fixture-capability-test-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	vi.doUnmock("node:fs");
	vi.resetModules();
});

/** Imports a fresh helper, so the probes' process-wide caches start empty. */
async function freshHelper() {
	vi.resetModules();
	return (await import("./fixture-capabilities.ts")) as typeof import("./fixture-capabilities.ts");
}

/** Imports a fresh helper whose probe sees `writeFileSync` replaced by `write`. */
async function helperWithWrite(write: () => void) {
	vi.resetModules();
	vi.doMock("node:fs", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:fs")>()),
		writeFileSync: write,
	}));
	return (await import("./fixture-capabilities.ts")) as typeof import("./fixture-capabilities.ts");
}

/** Captures the helper's skip announcements, which go to raw stderr (see the helper's comment). */
function captureStderr() {
	return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

/** Measures, independently of the helper, whether clearing the write bit stops a write here. */
function writeIsRefusedByMode(): boolean {
	const folder = join(scratch(), "unwritable");
	mkdirSync(folder);
	chmodSync(folder, 0o555);
	try {
		try {
			writeFileSync(join(folder, "probe"), "probe");
			return false;
		} catch {
			return true;
		}
	} finally {
		chmodSync(folder, 0o755);
	}
}

/** Measures, independently of the helper, whether this host can create a file symlink. */
function fileSymlinkIsRefusedHere(): boolean {
	const dir = scratch();
	const target = join(dir, "target");
	writeFileSync(target, "probe");
	try {
		symlinkSync(target, join(dir, "link"));
		return !lstatSync(join(dir, "link")).isSymbolicLink();
	} catch {
		return true;
	}
}

/** An attempt the host refuses, the way plain Windows refuses with `EPERM`. */
const refusedAttempt = {
	create: () => {
		throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
	},
	isLink: () => false,
};

describe("fixture capabilities", () => {
	it("asks for a junction on Windows and a directory link elsewhere", () => {
		expect(directoryLinkType("win32")).toBe("junction");
		expect(directoryLinkType("linux")).toBe("dir");
		expect(directoryLinkType("darwin")).toBe("dir");
	});

	it("makes a directory link this host reports as a link, resolving to the target's contents", () => {
		const dir = scratch();
		const target = join(dir, "target");
		mkdirSync(target);
		writeFileSync(join(target, "inside.txt"), "contents\n");
		const link = join(dir, "link");
		symlinkDirectory(target, link);
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(link, "inside.txt"), "utf8")).toBe("contents\n");
	});

	it("tells the truth about whether clearing the write bit stops a write", () => {
		// The helper announces a skip through raw stderr; this case is about the answer, not the line.
		const write = captureStderr();
		try {
			const measured = writeIsRefusedByMode();
			expect(canMakeDirectoryUnwritable("an unwritable-folder fixture")).toBe(measured);
		} finally {
			write.mockRestore();
		}
	});

	it("announces once per call, naming the fixture, when a write inside a cleared directory succeeds", async () => {
		const { canMakeDirectoryUnwritable: forced } = await helperWithWrite(() => {});
		const write = captureStderr();
		try {
			expect(forced("child-guard: the extensions folder cannot be written")).toBe(false);
			expect(forced("rotation: the session folder cannot be written")).toBe(false);
			// Per call, never a once-per-process flag: the second fixture must announce too.
			expect(write).toHaveBeenCalledTimes(2);
			for (const [index, needle] of [
				"child-guard: the extensions folder cannot be written",
				"rotation: the session folder cannot be written",
			].entries()) {
				const line = String(write.mock.calls[index]?.[0]);
				expect(line).toContain(needle);
				expect(line).toContain("odd/tasks/windows-port.md");
				expect(line.endsWith("\n")).toBe(true);
				expect(line.slice(0, -1)).not.toContain("\n");
			}
		} finally {
			write.mockRestore();
		}
	});

	it("stays silent when clearing the write bit does stop a write", async () => {
		const { canMakeDirectoryUnwritable: forced } = await helperWithWrite(() => {
			throw new Error("EACCES");
		});
		const write = captureStderr();
		try {
			expect(forced("a fixture on a host that honours the write bit")).toBe(true);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	it("tells the truth about whether this host can create a file symlink", async () => {
		// The helper announces a skip through raw stderr; this case is about the answer, not the line.
		const refused = fileSymlinkIsRefusedHere();
		const write = captureStderr();
		try {
			const { canCreateFileSymlinks: probe } = await freshHelper();
			expect(probe("a file-symlink fixture")).toBe(!refused);
		} finally {
			write.mockRestore();
		}
	});

	it("skips, naming the reason and the way out, when the attempt is refused", async () => {
		const { canCreateFileSymlinks: probe } = await freshHelper();
		const write = captureStderr();
		try {
			expect(probe("conversations: a session file reached through a symlink", refusedAttempt)).toBe(false);
			expect(write).toHaveBeenCalledTimes(1);
			const line = String(write.mock.calls[0]?.[0]);
			expect(line).toContain("conversations: a session file reached through a symlink");
			expect(line).toContain("EPERM");
			expect(line).toContain("Developer Mode");
			expect(line).toContain("elevated");
			expect(line).toContain("odd/tasks/windows-port.md");
			expect(line.endsWith("\n")).toBe(true);
			expect(line.slice(0, -1)).not.toContain("\n");
		} finally {
			write.mockRestore();
		}
	});

	it("runs, and says nothing, when the attempt leaves a symbolic link", async () => {
		const { canCreateFileSymlinks: probe, fileSymlinkCapability: capability } = await freshHelper();
		const accepted = { create: () => {}, isLink: () => true };
		const write = captureStderr();
		try {
			expect(capability(accepted)).toEqual({ canCreate: true });
			// The decision and the reason are separate, so a caller can assert either.
			expect(capability(accepted)).not.toHaveProperty("reason");
			expect(probe("a file-symlink fixture", accepted)).toBe(true);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});

	it("refuses an attempt that leaves something other than a symbolic link", async () => {
		const { fileSymlinkCapability: capability } = await freshHelper();
		const decision = capability({ create: () => {}, isLink: () => false });
		expect(decision.canCreate).toBe(false);
		expect(decision.reason).toContain("not a symbolic link");
	});

	it("probes once per process, so a second call keeps the first answer", async () => {
		const { canCreateFileSymlinks: probe } = await freshHelper();
		const write = captureStderr();
		try {
			expect(probe("the first file-symlink fixture", { create: () => {}, isLink: () => true })).toBe(true);
			// The injected attempt is honoured on the first call only: the real attempt is never made twice.
			expect(probe("the second file-symlink fixture", refusedAttempt)).toBe(true);
			expect(write).not.toHaveBeenCalled();
		} finally {
			write.mockRestore();
		}
	});
});

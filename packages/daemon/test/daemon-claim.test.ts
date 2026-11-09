import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ClaimIo,
	claimDaemonDirs,
	DAEMON_CLAIM_FILE,
	daemonClaimDirs,
	daemonClaimMessage,
	releaseDaemonClaims,
} from "../src/daemon-claim.ts";
import { expectPosixMode } from "./support/posix-modes.ts";

// Scratch folders live outside the worktree and are removed in teardown.
const scratchDirs: string[] = [];

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "gentle-dot-claim-"));
	scratchDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every filesystem effect the claim reads and applies, in memory, so every branch is deterministic. */
function memoryIo() {
	const files = new Map<string, string>();
	const dirs = new Set<string>();
	const io: ClaimIo & { files: Map<string, string>; dirs: Set<string> } = {
		files,
		dirs,
		exists: (path) => files.has(path),
		read: (path) => {
			const value = files.get(path);
			if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			return value;
		},
		ensureDir: (path) => {
			dirs.add(path);
		},
		create: (path, data) => {
			if (files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
			files.set(path, data);
		},
		remove: (path) => {
			files.delete(path);
		},
	};
	return io;
}

const alive = () => true;
const dead = () => false;
const claimPath = (dir: string) => join(dir, DAEMON_CLAIM_FILE);

describe("daemonClaimDirs", () => {
	it("claims the data folder alone when the agent home is inside it", () => {
		const dataDir = scratch();
		expect(daemonClaimDirs(dataDir, join(dataDir, "agent"))).toEqual([resolve(dataDir)]);
		expect(daemonClaimDirs(dataDir, dataDir)).toEqual([resolve(dataDir)]);
	});

	it("adds the agent home when it resolves outside the data folder", () => {
		const dataDir = scratch();
		const other = scratch();
		expect(daemonClaimDirs(dataDir, other)).toEqual([resolve(dataDir), resolve(other)]);
	});

	it("does not read a folder whose name merely starts with the data folder's as inside it", () => {
		const dataDir = scratch();
		expect(daemonClaimDirs(dataDir, `${dataDir}-agent`)).toEqual([
			resolve(dataDir),
			resolve(`${dataDir}-agent`),
		]);
	});

	it("claims the data folder alone when there is no agent home", () => {
		const dataDir = scratch();
		expect(daemonClaimDirs(dataDir, undefined)).toEqual([resolve(dataDir)]);
	});
});

describe("claimDaemonDirs", () => {
	it("claims a free folder and records our own pid", () => {
		const dir = scratch();
		const io = memoryIo();
		const outcome = claimDaemonDirs([dir], io, alive, 4242);
		expect(outcome).toEqual({ status: "claimed", files: [claimPath(dir)] });
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon 4242\n");
	});

	it("creates every folder it claims, so a fresh one needs no earlier write", () => {
		const first = scratch();
		const second = scratch();
		const io = memoryIo();
		claimDaemonDirs([first, second], io, alive, 7);
		expect([...io.dirs].sort()).toEqual([first, second].sort());
	});

	it("refuses a folder a live process holds, and names the pid", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon 4242\n");
		const outcome = claimDaemonDirs([dir], io, alive, 7);
		expect(outcome).toEqual({ status: "already-running", dir, pid: 4242 });
		// The holder's record is left exactly as it was: the file is not ours to rewrite.
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon 4242\n");
	});

	it("takes over a folder whose recorded pid is dead", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon 4242\n");
		expect(claimDaemonDirs([dir], io, dead, 7)).toEqual({ status: "claimed", files: [claimPath(dir)] });
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon 7\n");
	});

	it("takes over an empty record, which is ours half written", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "");
		expect(claimDaemonDirs([dir], io, alive, 7)).toEqual({ status: "claimed", files: [claimPath(dir)] });
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon 7\n");
	});

	it("refuses a foreign file and leaves its contents untouched", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "someone else's lock\n");
		expect(claimDaemonDirs([dir], io, dead, 7)).toEqual({ status: "unproven", dir });
		expect(io.files.get(claimPath(dir))).toBe("someone else's lock\n");
	});

	it("refuses a record that carries the mark but no usable pid", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon not-a-pid\n");
		expect(claimDaemonDirs([dir], io, dead, 7)).toEqual({ status: "unproven", dir });
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon not-a-pid\n");
	});

	it("refuses a record it cannot read", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon 1\n");
		io.read = () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		};
		expect(claimDaemonDirs([dir], io, dead, 7)).toEqual({ status: "unproven", dir });
	});

	it("claims every folder when they are all free", () => {
		const first = scratch();
		const second = scratch();
		const io = memoryIo();
		expect(claimDaemonDirs([first, second], io, alive, 7)).toEqual({
			status: "claimed",
			files: [claimPath(first), claimPath(second)],
		});
	});

	it("releases what it already claimed when a later folder is held", () => {
		const first = scratch();
		const second = scratch();
		const io = memoryIo();
		io.files.set(claimPath(second), "gentle-dot-daemon 4242\n");
		expect(claimDaemonDirs([first, second], io, alive, 7)).toEqual({
			status: "already-running",
			dir: second,
			pid: 4242,
		});
		// No residue behind: a refused start must not leave a claim of ours on the first folder.
		expect(io.files.has(claimPath(first))).toBe(false);
	});

	it("gives up rather than looping when a stale record can never be replaced", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon 4242\n");
		// A record that always reads as a dead pid whose file cannot be removed: the loser of a race
		// must refuse, never spin.
		io.remove = () => {};
		expect(claimDaemonDirs([dir], io, dead, 7)).toEqual({ status: "unproven", dir });
	});
});

describe("releaseDaemonClaims", () => {
	it("removes our own record", () => {
		const dir = scratch();
		const io = memoryIo();
		claimDaemonDirs([dir], io, alive, 7);
		releaseDaemonClaims([claimPath(dir)], io, 7);
		expect(io.files.has(claimPath(dir))).toBe(false);
	});

	it("leaves a record that names another pid alone", () => {
		const dir = scratch();
		const io = memoryIo();
		io.files.set(claimPath(dir), "gentle-dot-daemon 4242\n");
		releaseDaemonClaims([claimPath(dir)], io, 7);
		expect(io.files.get(claimPath(dir))).toBe("gentle-dot-daemon 4242\n");
	});

	it("ignores a claim file that is already gone", () => {
		const dir = scratch();
		const io = memoryIo();
		expect(() => releaseDaemonClaims([claimPath(dir)], io, 7)).not.toThrow();
	});
});

describe("daemonClaimMessage", () => {
	it("names the holder and the folder for a live one", () => {
		const message = daemonClaimMessage({ status: "already-running", dir: "D:/data", pid: 4242 });
		expect(message).toContain("already running on this data folder");
		expect(message).toContain("pid 4242");
		expect(message).toContain(join("D:/data", DAEMON_CLAIM_FILE));
	});

	it("names the file to remove when the claim is not ours", () => {
		const message = daemonClaimMessage({ status: "unproven", dir: "D:/data" });
		expect(message).toContain(join("D:/data", DAEMON_CLAIM_FILE));
		expect(message).toContain("refusing to start");
	});
});

describe("claimDaemonDirs on the real filesystem", () => {
	it("creates the folder it claims, private", () => {
		const parent = scratch();
		const dir = join(parent, "data");
		const outcome = claimDaemonDirs([dir]);
		expect(outcome).toEqual({ status: "claimed", files: [claimPath(dir)] });
		expect(existsSync(claimPath(dir))).toBe(true);
		expectPosixMode(dir, 0o700);
	});

	it("claims, refuses a second claim from a live pid, and claims again after a release", () => {
		const dir = scratch();
		const first = claimDaemonDirs([dir], undefined, undefined, process.pid);
		expect(first.status).toBe("claimed");
		if (first.status !== "claimed") throw new Error("the first claim failed");
		expect(readFileSync(claimPath(dir), "utf8")).toBe(`gentle-dot-daemon ${process.pid}\n`);

		// The real pid-liveness reader: this very process holds it, so the second claim is refused.
		expect(claimDaemonDirs([dir]).status).toBe("already-running");
		expect(existsSync(claimPath(dir))).toBe(true);

		releaseDaemonClaims(first.files);
		expect(existsSync(claimPath(dir))).toBe(false);
		expect(claimDaemonDirs([dir]).status).toBe("claimed");
	});

	it("leaves a foreign file where it is and refuses", () => {
		const dir = scratch();
		writeFileSync(claimPath(dir), "not ours\n");
		expect(claimDaemonDirs([dir]).status).toBe("unproven");
		expect(readFileSync(claimPath(dir), "utf8")).toBe("not ours\n");
	});
});

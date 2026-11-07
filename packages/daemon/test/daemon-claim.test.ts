import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ClaimIo,
	claimDaemonDirs,
	DAEMON_CLAIM_FILE,
	DAEMON_CLAIM_GUARD,
	DAEMON_CLAIM_MARK,
	DaemonClaimContention,
} from "../src/daemon-claim.ts";
import type { EngineAccess } from "../src/engine-access.ts";
import { windowsPrivateStorage } from "../src/windows-private-storage.ts";

const data = resolve("synthetic-data");
const home = resolve("synthetic-home");
const file = join(data, DAEMON_CLAIM_FILE);
const guard = join(data, DAEMON_CLAIM_GUARD);
const nonce = "a".repeat(32);
const nextNonce = "b".repeat(32);
const record = (pid = 101, id = nonce) => `${DAEMON_CLAIM_MARK} ${pid} ${id}\n`;
const error = (code: string) => Object.assign(new Error(code), { code });

function fixture() {
	const files = new Map<string, string>();
	const guards = new Set<string>();
	const calls: [string, string][] = [];
	const hooks: { fail?: (op: string, path: string) => void; writing?: () => void } = {};
	const step = (op: string, path: string) => {
		calls.push([op, path]);
		hooks.fail?.(op, path);
	};
	const io: ClaimIo = {
		prepare: (path) => {
			step("prepare", path);
			return resolve(path);
		},
		guard: (path) => {
			step("guard", path);
			if (guards.has(path)) throw error("EEXIST");
			guards.add(path);
		},
		protect: (path) => {
			step("protect", path);
		},
		unguard: (path) => {
			step("unguard", path);
			guards.delete(path);
		},
		read: (path) => {
			step("read", path);
			const text = files.get(path);
			if (text === undefined) throw error("ENOENT");
			return text;
		},
		create: (path, text) => {
			step("create", path);
			if (files.has(path)) throw error("EEXIST");
			files.set(path, "");
			hooks.writing?.();
			files.set(path, text);
		},
		remove: (path) => {
			step("remove", path);
			files.delete(path);
		},
	};
	return {
		files,
		guards,
		calls,
		hooks,
		io,
		snapshot: () => ({ files: [...files], guards: [...guards] }),
		options: { io, pid: 101, nonce, alive: () => true },
	};
}

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("guarded daemon directory claims", () => {
	it("owns private directories with one nonce and releases idempotently", () => {
		const f = fixture();
		const lease = claimDaemonDirs([{ path: data }, { path: home }], f.options);
		expect(lease.files).toEqual([file, join(home, DAEMON_CLAIM_FILE)]);
		expect(f.files.get(file)).toBe(record());
		expect(f.guards.size).toBe(0);
		lease.release();
		expect(f.snapshot()).toEqual({ files: [], guards: [] });
		const calls = f.calls.length;
		lease.release();
		expect(f.calls).toHaveLength(calls);
	});

	it.each([true, "uncertain"])("preserves a live or uncertain owner (%s)", (alive) => {
		const f = fixture();
		f.files.set(file, `${DAEMON_CLAIM_MARK} 303\n`);
		const before = f.snapshot();
		expect(() =>
			claimDaemonDirs([{ path: data }], {
				...f.options,
				alive: () => {
					if (alive === "uncertain") throw error("EPERM");
					return true;
				},
			}),
		).toThrow(/already running.*303/);
		expect(f.snapshot()).toEqual(before);
		expect(f.calls.filter(([op]) => ["create", "remove"].includes(op))).toEqual([]);
	});

	it("types live contention without changing its exact prior diagnostic", () => {
		const f = fixture();
		f.files.set(file, record(303));
		let failure: unknown;
		try {
			claimDaemonDirs([{ path: data }], f.options);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(DaemonClaimContention);
		expect((failure as DaemonClaimContention).kind).toBe("live-owner");
		expect((failure as Error).message).toBe(
			`another Gentle Dot assistant is already running on this data folder (pid 303 holds ${file})`,
		);
	});

	it("recovers only a well-formed, proven-dead owner while holding guard", () => {
		const f = fixture();
		f.files.set(file, `${DAEMON_CLAIM_MARK} 303\n`);
		f.hooks.fail = (op) => {
			if (["read", "remove", "create"].includes(op)) expect(f.guards.has(guard)).toBe(true);
		};
		const lease = claimDaemonDirs([{ path: data }], { ...f.options, alive: () => false });
		expect(f.files.get(file)).toBe(record());
		expect(f.calls.filter(([op]) => op === "remove")).toHaveLength(1);
		lease.release();
	});

	it.each([
		"",
		"\n",
		"foreign data",
		`${DAEMON_CLAIM_MARK} 0\n`,
		`${DAEMON_CLAIM_MARK} 9999999999999999999\n`,
	])("leaves empty or unproven records unchanged (%j)", (text) => {
		const f = fixture();
		f.files.set(file, text);
		const before = f.snapshot();
		expect(() => claimDaemonDirs([{ path: data }], f.options)).toThrow(/unproven.*refus/i);
		expect(f.snapshot()).toEqual(before);
		expect(f.calls.filter(([op]) => ["create", "remove"].includes(op))).toEqual([]);
	});

	it("never recovers an existing guard or reads its claim", () => {
		const f = fixture();
		f.guards.add(guard);
		const before = f.snapshot();
		let failure: unknown;
		try {
			claimDaemonDirs([{ path: data }], f.options);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(DaemonClaimContention);
		expect((failure as DaemonClaimContention).kind).toBe("active-guard");
		expect((failure as Error).message).toBe(
			`Claim guard ${guard} already exists; stop all daemons and inspect it before manual recovery.`,
		);
		expect(f.snapshot()).toEqual(before);
		expect(f.calls.map(([op]) => op)).toEqual(["prepare", "guard"]);
	});

	it("blocks a competitor during the create-to-write interval without erasing the writer", () => {
		const f = fixture();
		f.hooks.writing = () => {
			const before = f.snapshot();
			expect(() =>
				claimDaemonDirs([{ path: data }], { ...f.options, pid: 202, nonce: nextNonce, alive: () => false }),
			).toThrow(/guard.*manual/i);
			expect(f.snapshot()).toEqual(before);
		};
		const lease = claimDaemonDirs([{ path: data }], f.options);
		expect(f.files.get(file)).toBe(record());
		expect(f.calls.filter(([op]) => op === "create")).toHaveLength(1);
		expect(f.calls.filter(([op]) => op === "remove")).toEqual([]);
		lease.release();
	});

	it("rolls back earlier owned claims when a later directory is occupied", () => {
		const f = fixture();
		const other = join(home, DAEMON_CLAIM_FILE);
		f.files.set(other, record(303, nextNonce));
		const before = f.snapshot();
		expect(() => claimDaemonDirs([{ path: data }, { path: home }], f.options)).toThrow(/already running/);
		expect(f.snapshot()).toEqual(before);
		expect(f.calls.filter(([op, path]) => op === "remove" && path === other)).toEqual([]);
	});

	it("fences release by nonce, not merely a reused pid", () => {
		const f = fixture();
		const lease = claimDaemonDirs([{ path: data }], f.options);
		f.files.set(file, record(101, nextNonce));
		const before = f.snapshot();
		expect(() => lease.release()).toThrow(/ownership changed/i);
		expect(f.snapshot()).toEqual(before);
	});

	it("retains a claim and reports failure when release cannot acquire guard", () => {
		const f = fixture();
		const lease = claimDaemonDirs([{ path: data }], f.options);
		f.guards.add(guard);
		const before = f.snapshot();
		expect(() => lease.release()).toThrow(/guard.*manual/i);
		expect(f.snapshot()).toEqual(before);
	});

	it("does not claim success when protection fails, and removes only its own guard", () => {
		const f = fixture();
		f.hooks.fail = (op) => {
			if (op === "protect") throw new Error("protection refused");
		};
		expect(() => claimDaemonDirs([{ path: data }], f.options)).toThrow(/protection refused/);
		expect(f.snapshot()).toEqual({ files: [], guards: [] });
		expect(f.calls.filter(([op]) => ["read", "create", "remove"].includes(op))).toEqual([]);
	});

	it("reports incomplete rollback without erasing an uncertain guard or claim", () => {
		const f = fixture();
		f.files.set(join(home, DAEMON_CLAIM_FILE), record(303));
		f.hooks.fail = (op, path) => {
			if (op === "unguard" && path === guard) throw new Error("guard cleanup failed");
		};
		expect(() => claimDaemonDirs([{ path: data }, { path: home }], f.options)).toThrow(
			/guard cleanup failed/,
		);
		expect(f.files.get(file)).toBe(record());
		expect(f.guards.has(guard)).toBe(true);
	});

	it("keeps every directory operation inside its synchronous ownership context", () => {
		const f = fixture();
		let inside = false;
		const access: EngineAccess = (fn) => {
			inside = true;
			try {
				return fn();
			} finally {
				inside = false;
			}
		};
		f.hooks.fail = () => expect(inside).toBe(true);
		const lease = claimDaemonDirs([{ path: data, access }], f.options);
		expect(lease.files).toEqual([file]);
		lease.release();
	});

	it("deduplicates the canonical private directory before acquiring twice", () => {
		const f = fixture();
		f.io.prepare = () => data;
		const lease = claimDaemonDirs([{ path: data }, { path: home }], f.options);
		expect(lease.files).toEqual([file]);
		expect(f.calls.filter(([op]) => op === "create")).toHaveLength(1);
		lease.release();
	});

	it("rolls back instead of accepting an ownership context that skips its operation", () => {
		const f = fixture();
		const deny: EngineAccess = <T>() => undefined as T;
		const before = f.snapshot();
		expect(() => claimDaemonDirs([{ path: data }, { path: home, access: deny }], f.options)).toThrow(
			/ownership.*synchronous/i,
		);
		expect(f.snapshot()).toEqual(before);
	});

	it("does not forget a lease when its release context skips the operation", () => {
		const f = fixture();
		let enabled = true;
		const access: EngineAccess = <T>(fn: () => T) => (enabled ? fn() : (undefined as T));
		const lease = claimDaemonDirs([{ path: data, access }], f.options);
		const before = f.snapshot();
		enabled = false;
		expect(() => lease.release()).toThrow(/ownership.*synchronous/i);
		expect(f.snapshot()).toEqual(before);
		enabled = true;
		lease.release();
		expect(f.snapshot()).toEqual({ files: [], guards: [] });
	});

	it("refuses a deferred ownership callback before it can touch the filesystem", () => {
		const f = fixture();
		let deferred: (() => unknown) | undefined;
		const access: EngineAccess = <T>(fn: () => T) => {
			deferred = fn;
			return undefined as T;
		};
		expect(() => claimDaemonDirs([{ path: data, access }], f.options)).toThrow(/ownership.*synchronous/i);
		expect(() => deferred?.()).toThrow(/ownership.*synchronous/i);
		expect(f.calls).toEqual([]);
		expect(f.snapshot()).toEqual({ files: [], guards: [] });
	});

	it("preserves both protection and guard-cleanup failure diagnostics", () => {
		const f = fixture();
		f.hooks.fail = (op) => {
			if (op === "protect") throw new Error("first protection refused");
			if (op === "unguard") throw new Error("second guard cleanup refused");
		};
		expect(() => claimDaemonDirs([{ path: data }], f.options)).toThrow(
			/first protection refused.*second guard cleanup refused/,
		);
		expect(f.files.size).toBe(0);
		expect(f.guards.has(guard)).toBe(true);
	});

	it("verifies an existing Windows parent without hardening it (synthetic helper ordering)", async () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-native-order-"));
		temps.push(dir);
		const helper = vi
			.spyOn(await import("../src/windows-private-storage.ts"), "windowsPrivateStorage")
			.mockImplementation(() => {});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platform) throw new Error("Missing platform descriptor");
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			const lease = claimDaemonDirs([{ path: dir }]);
			expect(helper.mock.calls[0]?.[0]).toBe("secure-file");
			expect(helper.mock.calls[0]?.[1]).toContain(".claim-parent-check-");
			expect(helper.mock.calls.some(([op, path]) => op === "ensure-dir" && path === dir)).toBe(false);
			expect(helper).toHaveBeenCalledWith("ensure-dir", join(dir, DAEMON_CLAIM_GUARD));
			expect(helper).toHaveBeenCalledWith("secure-file", join(dir, DAEMON_CLAIM_FILE));
			lease.release();
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", platform);
			helper.mockRestore();
		}
	});

	it("fails before guard or claim creation when Windows parent protection is refused", async () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "claim-native-denied-"));
		temps.push(dir);
		const helper = vi
			.spyOn(await import("../src/windows-private-storage.ts"), "windowsPrivateStorage")
			.mockImplementation(() => {
				throw new Error("parent protection refused");
			});
		const platform = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platform) throw new Error("Missing platform descriptor");
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		try {
			expect(() => claimDaemonDirs([{ path: dir }])).toThrow("parent protection refused");
			expect(helper).toHaveBeenCalledOnce();
			expect(helper.mock.calls[0]?.[0]).toBe("secure-file");
			expect(readdirSync(dir)).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", platform);
			helper.mockRestore();
		}
	});

	it("validates its own record before any filesystem operation", () => {
		const f = fixture();
		for (const invalid of [{ pid: 0 }, { pid: Number.MAX_SAFE_INTEGER }, { nonce: "unknown" }])
			expect(() => claimDaemonDirs([{ path: data }], { ...f.options, ...invalid })).toThrow(
				/invalid.*claim/i,
			);
		expect(f.calls).toEqual([]);
		expect(f.snapshot()).toEqual({ files: [], guards: [] });
	});

	it("uses the real exclusive guard and preserves unproven file bytes in an owned fixture", () => {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "daemon-claim-"));
		temps.push(dir);
		if (process.platform === "win32") windowsPrivateStorage("ensure-dir", dir);
		const lease = claimDaemonDirs([{ path: dir }]);
		expect(lease.files).toEqual([join(dir, DAEMON_CLAIM_FILE)]);
		expect(() => claimDaemonDirs([{ path: dir }])).toThrow(/already running/);
		lease.release();
		writeFileSync(join(dir, DAEMON_CLAIM_FILE), "unknown operator input", { mode: 0o600 });
		expect(() => claimDaemonDirs([{ path: dir }])).toThrow(/unproven/);
		expect(readFileSync(join(dir, DAEMON_CLAIM_FILE), "utf8")).toBe("unknown operator input");
	});
});

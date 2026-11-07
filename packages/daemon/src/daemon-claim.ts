/** Cooperative leases on private coordination directories; SDK-home selection belongs to the caller. */
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { directAccess, type EngineAccess, insideEngineAccess } from "./engine-access.ts";
import { readPrivateFileSync } from "./private-file.ts";
import { windowsPrivateStorage } from "./windows-private-storage.ts";

export const DAEMON_CLAIM_FILE = ".gentle-dot-daemon.lock";
export const DAEMON_CLAIM_GUARD = `${DAEMON_CLAIM_FILE}.guard`;
export const DAEMON_CLAIM_MARK = "gentle-dot-daemon";

/** Retryable only at startup admission; neither kind authorizes guard removal. */
export class DaemonClaimContention extends Error {
	readonly kind: "live-owner" | "active-guard";
	constructor(kind: "live-owner" | "active-guard", message: string, options?: ErrorOptions) {
		super(message, options);
		this.kind = kind;
	}
}

export interface ClaimDirectory {
	/** An authorized private coordination directory, not an arbitrary shared SDK home. */
	path: string;
	access?: EngineAccess;
}

/** Synchronous effects, injectable for deterministic protocol contention and failure tests. */
export interface ClaimIo {
	prepare(path: string): string;
	guard(path: string): void;
	protect(path: string): void;
	unguard(path: string): void;
	read(path: string): string;
	create(path: string, record: string): void;
	remove(path: string): void;
}

export interface ClaimOptions {
	io?: ClaimIo;
	alive?: (pid: number) => boolean;
	pid?: number;
	nonce?: string;
}

export interface DaemonClaims {
	readonly files: readonly string[];
	/** Call only after owned resources stop. Failed releases retain their pending ownership. */
	release(): void;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException | null | undefined)?.code;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const validPid = (pid: number) => Number.isInteger(pid) && pid > 0 && pid <= 2_147_483_647;
const unproven = (file: string, cause?: unknown) =>
	new Error(`The claim file ${file} has unproven ownership; refusing to modify it.`, { cause });

function native(operation: "ensure-dir" | "secure-file", path: string): void {
	if (process.platform !== "win32") return;
	if (insideEngineAccess()) throw new Error("A native process cannot start inside EngineAccess.");
	windowsPrivateStorage(operation, path);
}

function ownFile(path: string): void {
	const stat = lstatSync(path);
	const uid = process.geteuid?.() ?? process.getuid?.();
	if (!stat.isFile() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) throw unproven(path);
	if (stat.size > 512) throw unproven(path);
}

const nodeIo: ClaimIo = {
	prepare(path) {
		const absolute = resolve(path);
		try {
			lstatSync(absolute);
		} catch (error) {
			if (code(error) !== "ENOENT") throw error;
			if (process.platform === "win32") native("ensure-dir", absolute);
			else mkdirSync(absolute, { recursive: true, mode: 0o700 });
		}
		const stat = lstatSync(absolute);
		if (!stat.isDirectory()) throw new Error(`Not a private claim directory: ${absolute}`);
		if (process.platform === "win32") {
			// Parent now demonstrably exists. Native secure-file verifies its owner/DACL before
			// reporting a missing target; unlike ensure-dir, it does not harden this parent.
			native("secure-file", join(absolute, `.claim-parent-check-${randomBytes(16).toString("hex")}`));
		} else {
			const uid = process.geteuid?.() ?? process.getuid?.();
			if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o022) !== 0)
				throw new Error(`Not a private claim directory: ${absolute}`);
		}
		return realpathSync.native(absolute);
	},
	guard: (path) => mkdirSync(path, { mode: 0o700 }),
	protect: (path) => native("ensure-dir", path),
	unguard: (path) => rmdirSync(path),
	read(path) {
		ownFile(path);
		return readPrivateFileSync(path);
	},
	create(path, record) {
		const fd = openSync(path, "wx", 0o600);
		let verified = false;
		try {
			const uid = process.geteuid?.() ?? process.getuid?.();
			const stat = fstatSync(fd);
			if (stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) throw unproven(path);
			if (process.platform !== "win32") {
				fchmodSync(fd, 0o600);
				verified = true;
			}
			writeFileSync(fd, record);
		} catch (error) {
			closeSync(fd);
			// Remove only a newly created, verified POSIX file. Uncertain ownership stays visible.
			if (verified) unlinkSync(path);
			throw error;
		}
		closeSync(fd);
		native("secure-file", path);
	},
	remove: (path) => unlinkSync(path),
};

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return code(error) !== "ESRCH";
	}
}

/** Accept strict legacy PID records for liveness, never as a nonce-bound release capability. */
function holder(text: string, file: string): number {
	const match = /^gentle-dot-daemon ([1-9]\d*)(?: [0-9a-f]{32})?\n?$/.exec(text);
	const pid = Number(match?.[1]);
	if (!validPid(pid)) throw unproven(file);
	return pid;
}

function read(io: ClaimIo, file: string): string | undefined {
	try {
		return io.read(file);
	} catch (error) {
		if (code(error) === "ENOENT") return undefined;
		throw unproven(file, error);
	}
}

/** Refuse skipped/deferred callbacks instead of acknowledging an unexecuted ownership operation. */
function inAccess<T>(access: EngineAccess, path: string, fn: () => T): T {
	let active = true;
	let completed = false;
	try {
		const result = access(() => {
			if (!active) throw new Error(`Ownership access must run synchronously for ${path}.`);
			const value = fn();
			completed = true;
			return value;
		});
		if (!completed) throw new Error(`Ownership access must complete synchronously for ${path}.`);
		return result;
	} finally {
		active = false;
	}
}

function guarded(io: ClaimIo, dir: string, fn: () => void): void {
	const guard = join(dir, DAEMON_CLAIM_GUARD);
	try {
		io.guard(guard);
	} catch (error) {
		if (code(error) !== "EEXIST") throw error;
		throw new DaemonClaimContention(
			"active-guard",
			`Claim guard ${guard} already exists; stop all daemons and inspect it before manual recovery.`,
			{ cause: error },
		);
	}
	let failed = false;
	let failure: unknown;
	try {
		io.protect(guard);
		fn();
	} catch (error) {
		failed = true;
		failure = error;
	}
	try {
		io.unguard(guard);
	} catch (cleanup) {
		if (failed) throw new AggregateError([failure, cleanup], `${message(failure)}; ${message(cleanup)}`);
		throw cleanup;
	}
	if (failed) throw failure;
}

/** Acquire all or roll back our own earlier leases. No guard is reclaimed by age, PID or contents. */
export function claimDaemonDirs(
	targets: readonly ClaimDirectory[],
	options: ClaimOptions = {},
): DaemonClaims {
	const pid = options.pid ?? process.pid;
	const nonce = options.nonce ?? randomBytes(16).toString("hex");
	if (
		!validPid(pid) ||
		!/^[0-9a-f]{32}$/.test(nonce) ||
		targets.some(({ path }) => !isAbsolute(path) || path.includes("\0"))
	)
		throw new Error("Invalid daemon directory claim identity or path.");
	const io = options.io ?? nodeIo;
	const isAlive = options.alive ?? alive;
	const record = `${DAEMON_CLAIM_MARK} ${pid} ${nonce}\n`;
	const owned = new Map<string, { dir: string; access: EngineAccess }>();
	const release = () => {
		const errors: unknown[] = [];
		for (const [file, { dir, access }] of owned) {
			try {
				inAccess(access, file, () =>
					guarded(io, dir, () => {
						const current = read(io, file);
						if (current === undefined) return;
						if (current !== record)
							throw new Error(`Claim ownership changed at ${file}; refusing to remove it.`);
						io.remove(file);
					}),
				);
				owned.delete(file);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(errors, `Could not release daemon claims: ${errors.map(message).join("; ")}`);
	};
	try {
		for (const target of targets) {
			const access = target.access ?? directAccess;
			inAccess(access, target.path, () => {
				const dir = io.prepare(target.path);
				const file = join(dir, DAEMON_CLAIM_FILE);
				if (owned.has(file)) return;
				guarded(io, dir, () => {
					const previous = read(io, file);
					if (previous !== undefined) {
						const other = holder(previous, file);
						let live = true;
						try {
							live = isAlive(other) !== false;
						} catch {
							/* Uncertain means retained. */
						}
						if (live)
							throw new DaemonClaimContention(
								"live-owner",
								`another Gentle Dot assistant is already running on this data folder (pid ${other} holds ${file})`,
							);
						io.remove(file);
					}
					io.create(file, record);
					owned.set(file, { dir, access });
				});
			});
		}
	} catch (error) {
		try {
			release();
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				`Could not acquire all daemon claims: ${message(error)}; ${message(cleanup)}`,
			);
		}
		throw error;
	}
	return { files: Object.freeze([...owned.keys()]), release };
}

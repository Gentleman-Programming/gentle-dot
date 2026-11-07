/** Cooperative startup admission; ordinary daemon startup, not admission, initializes SDK homes. */
import type * as Fs from "node:fs";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type ClaimDirectory,
	claimDaemonDirs,
	DaemonClaimContention,
	type DaemonClaims,
} from "./daemon-claim.ts";
import { directAccess, type EngineAccess } from "./engine-access.ts";

export interface AdmissionOptions {
	dataDir: string;
	sdkHome: string;
	engineAccess?: EngineAccess;
	/** OS effective-user metadata by default; inject only an authorized account directory. */
	accountHome?: () => string;
	/** Trusted ordinary owned-dataDir layout only; synchronous, outside EngineAccess, never SDK setup. */
	prepareOwnedDataDir?: () => undefined;
	startupAttempts?: number;
	retryDelayMs?: number;
	/** Fault seam: wrappers must delegate to the real foundation protocol. */
	claim?: (targets: readonly ClaimDirectory[]) => DaemonClaims;
}

export interface DaemonAdmission {
	readonly pendingHome: boolean;
	assertCurrent(): void;
	promoteHome(): void;
	/** Only after resources stop; retry explicitly if release fails. */
	release(): void;
}

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A completion AND active fence: a deferred callback must not touch files as the wrong user. */
function accessNow<T>(access: EngineAccess, fn: () => T): T {
	let active = true;
	let completed = false;
	try {
		const result = access(() => {
			if (!active) throw new Error("Admission access must run synchronously.");
			const value = fn();
			completed = true;
			return value;
		});
		if (!completed) throw new Error("Admission access must complete synchronously.");
		return result;
	} finally {
		active = false;
	}
}

function validPath(path: string): void {
	if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid admission directory path.");
}

/** Existing kernel identity only; never derive ownership from a spelling or missing ancestor. */
function identity(path: string): string | undefined {
	let stat: Fs.BigIntStats;
	try {
		stat = statSync(path, { bigint: true });
	} catch (error) {
		if (!missing(error)) throw error;
		// Distinguish absence from a dangling final link. Ancestor uncertainty is checked by boundary().
		try {
			lstatSync(path);
		} catch (probe) {
			if (missing(probe)) return undefined;
			throw probe;
		}
		throw new Error(`Unresolved admission directory alias: ${path}`);
	}
	if (!stat.isDirectory()) throw new Error(`Not an admission directory: ${path}`);
	if (typeof stat.dev !== "bigint" || typeof stat.ino !== "bigint" || stat.dev < 0n || stat.ino <= 0n)
		throw new Error(`Unsupported physical directory identity: ${path}`);
	return `${stat.dev.toString(16)}-${stat.ino.toString(16)}`;
}

interface Boundary {
	path: string;
	ids: string[];
	id?: string;
}
/** Canonical ancestors are for REJECTION only, never a lease key for a missing directory. */
function boundary(path: string): Boundary {
	const suffix: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			lstatSync(current);
			// This fails closed for dangling links, including links in any missing ancestor.
			const canonical = realpathSync.native(current);
			const ids: string[] = [];
			for (let ancestor = canonical; ; ancestor = dirname(ancestor)) {
				const id = identity(ancestor);
				if (id === undefined) throw new Error("Admission ancestor disappeared.");
				ids.push(id);
				if (dirname(ancestor) === ancestor) break;
			}
			return { path: join(canonical, ...suffix), ids, id: suffix.length ? undefined : ids[0] };
		} catch (error) {
			if (!missing(error)) throw error;
			// A present but unresolved link must never be interpreted as a missing ordinary component.
			try {
				lstatSync(current);
				throw new Error(`Unresolved admission boundary: ${current}`);
			} catch (probe) {
				if (!missing(probe)) throw probe;
			}
			const parent = dirname(current);
			if (parent === current) throw error;
			suffix.unshift(relative(parent, current));
			current = parent;
		}
	}
}

function contains(parent: string, child: string): boolean {
	const part = relative(parent, child);
	return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function disjoint(registry: Boundary, target: Boundary): void {
	if (
		contains(registry.path, target.path) ||
		contains(target.path, registry.path) ||
		(registry.id !== undefined && target.ids.includes(registry.id)) ||
		(target.id !== undefined && registry.ids.includes(target.id))
	)
		throw new Error("Admission registry must not overlap dataDir or SDK home.");
}

export async function claimDaemonAdmission(options: AdmissionOptions): Promise<DaemonAdmission> {
	validPath(options.dataDir);
	validPath(options.sdkHome);
	const attempts = options.startupAttempts ?? 20;
	const wait = options.retryDelayMs ?? 25;
	if (
		!Number.isInteger(attempts) ||
		attempts < 1 ||
		attempts > 100 ||
		!Number.isFinite(wait) ||
		wait < 0 ||
		wait > 1000
	)
		throw new Error("Invalid bounded admission retry policy.");
	const engine = options.engineAccess ?? directAccess;
	const claim = options.claim ?? claimDaemonDirs;
	const account = accessNow(engine, () => (options.accountHome ?? (() => userInfo().homedir))());
	validPath(account);
	const registry = join(account, ".gentle-dot-daemon-claims");
	let layoutPending = options.prepareOwnedDataDir !== undefined;
	const dataPath = resolve(options.dataDir);
	const sdkPath = resolve(options.sdkHome);
	const containedHome = dataPath !== sdkPath && contains(dataPath, sdkPath);
	const homeBoundary = (): Boundary | undefined => {
		try {
			return accessNow(engine, () => boundary(options.sdkHome));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code;
			// Only ordinary traversal of an owned-dataDir-contained home may await owned layout.
			// This is NOT a home identity or an assertion that the hidden path has no aliases.
			if (layoutPending && containedHome && (code === "EACCES" || code === "EPERM")) return undefined;
			throw error;
		}
	};
	const metadataBoundary = (path: string, root: Boundary) => {
		const target = accessNow(engine, () => boundary(path));
		if (!contains(root.path, target.path))
			throw new Error("Admission metadata escapes the private registry.");
		return target;
	};
	const checkBoundaries = () => {
		const root = accessNow(engine, () => boundary(registry));
		const physical = metadataBoundary(join(registry, "physical"), root);
		for (const target of [accessNow(directAccess, () => boundary(options.dataDir)), homeBoundary()]) {
			if (target === undefined) continue;
			disjoint(root, target);
			disjoint(physical, target);
		}
	};
	// Inspect all accessible inputs before metadata; dataDir/registry checks are never deferred.
	checkBoundaries();
	const leases = new Set<DaemonClaims>();
	const acquire = (path: string, access: EngineAccess) => {
		if (path !== registry && access === engine && path !== options.dataDir) {
			const root = accessNow(engine, () => boundary(registry));
			const metadata = metadataBoundary(path, root);
			disjoint(
				metadata,
				accessNow(directAccess, () => boundary(options.dataDir)),
			);
			const home = homeBoundary();
			if (home !== undefined) disjoint(metadata, home);
		}
		const lease = claim([{ path, access }]);
		leases.add(lease);
		return lease;
	};
	const physicalIds = new Set<string>();
	const acquirePhysical = (id: string) => {
		if (physicalIds.has(id)) return;
		acquire(join(registry, "physical", id), engine);
		physicalIds.add(id);
	};
	const drop = (lease: DaemonClaims) => {
		lease.release();
		leases.delete(lease);
	};
	const releaseAll = () => {
		const errors: unknown[] = [];
		for (const lease of leases) {
			try {
				drop(lease);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(errors, `Could not release admission: ${errors.map(text).join("; ")}`);
	};
	let startup: DaemonClaims | undefined;
	let closed = false;
	let dataId: string | undefined;
	let homeId: string | undefined;
	const ensureOpen = () => {
		if (closed) throw new Error("Daemon admission is closed.");
	};
	const currentData = () => accessNow(directAccess, () => identity(options.dataDir));
	const currentHome = () => accessNow(engine, () => identity(options.sdkHome));
	const assertCurrent = () => {
		ensureOpen();
		checkBoundaries();
		if (currentData() !== dataId || (homeId !== undefined && currentHome() !== homeId))
			throw new Error("Admission directory identity changed; retain ownership until resources stop.");
	};
	const bindHome = () => {
		assertCurrent();
		if (homeId === undefined) {
			const id = currentHome();
			if (id === undefined)
				throw new Error("SDK home is missing; ordinary startup must create it before promotion.");
			acquirePhysical(id);
			homeId = id;
			assertCurrent();
		}
		if (startup) {
			drop(startup);
			startup = undefined;
		}
	};
	try {
		for (let attempt = 0; ; attempt++) {
			try {
				startup = acquire(registry, engine);
				break;
			} catch (error) {
				if (!(error instanceof DaemonClaimContention) || attempt + 1 >= attempts) throw error;
				// No access bracket or filesystem guard crosses this await. Never remove a busy guard.
				await delay(wait);
				checkBoundaries();
			}
		}
		checkBoundaries();
		const existingData = currentData();
		const existingHome = homeBoundary() === undefined ? undefined : currentHome();
		// Known cross-role/shared-home contention must precede ANY contender dataDir effects.
		if (existingHome !== undefined) {
			acquirePhysical(existingHome);
			homeId = existingHome;
		}
		if (existingData !== undefined) acquirePhysical(existingData);
		if (currentData() !== existingData || (homeId !== undefined && currentHome() !== homeId))
			throw new Error("Admission directory identity changed before dataDir ownership.");
		acquire(options.dataDir, directAccess); // Preserve legacy PID and cross-engine dataDir exclusion.
		dataId = currentData();
		if (dataId === undefined || (existingData !== undefined && dataId !== existingData))
			throw new Error("Claimed data directory identity changed or disappeared.");
		acquirePhysical(dataId);
		// Only trusted, ordinary owned-dataDir layout is authorized here; no SDK setup or async work.
		if (options.prepareOwnedDataDir) {
			const result = options.prepareOwnedDataDir();
			if (result !== undefined)
				throw new Error("Owned dataDir layout must complete synchronously and return undefined.");
		}
		layoutPending = false;
		checkBoundaries(); // STRICT engine inspection after layout; never read the SDK path as daemon.
		assertCurrent();
		if (currentHome() !== undefined) bindHome();
		assertCurrent();
	} catch (error) {
		try {
			releaseAll();
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				`Admission acquisition failed: ${text(error)}; ${text(cleanup)}`,
			);
		}
		throw error;
	}
	return {
		get pendingHome() {
			return homeId === undefined;
		},
		assertCurrent,
		promoteHome() {
			ensureOpen();
			bindHome();
		},
		release() {
			if (closed) return;
			releaseAll();
			closed = true;
		},
	};
}

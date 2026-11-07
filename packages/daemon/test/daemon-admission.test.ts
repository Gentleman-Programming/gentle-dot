import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type AdmissionOptions, claimDaemonAdmission } from "../src/daemon-admission.ts";
import { claimDaemonDirs } from "../src/daemon-claim.ts";
import { directAccess, type EngineAccess } from "../src/engine-access.ts";

const base = join(tmpdir(), "gentle-dot-admission");
function fixture() {
	mkdirSync(base, { recursive: true, mode: 0o700 });
	const root = mkdtempSync(join(base, "admission-"));
	const account = join(root, "account");
	const home = join(root, "sdk");
	mkdirSync(account, { mode: 0o700 });
	mkdirSync(home, { mode: 0o755 });
	writeFileSync(join(home, "sentinel"), "SDK owned content");
	const options = (name: string, sdkHome = home): AdmissionOptions => ({
		dataDir: join(root, name),
		sdkHome,
		accountHome: () => account,
		startupAttempts: 1,
	});
	return { root, account, home, options };
}
const snapshot = (path: string) => ({
	mode: statSync(path).mode,
	ino: statSync(path, { bigint: true }).ino,
	text: readFileSync(join(path, "sentinel"), "utf8"),
	entries: readdirSync(path),
});

// Permission-bracket MODEL on owned fixtures only, not native VPS/Windows evidence.
const permissionModel = it.skipIf(process.platform === "win32" || process.geteuid?.() === 0);
function modeledLayout(dataDir: string, deniedCode = "EACCES") {
	let prepared = false;
	let inside = false;
	const access: EngineAccess = (fn) => {
		const mode = statSync(dataDir).mode & 0o777;
		inside = true;
		if (!prepared) chmodSync(dataDir, 0);
		try {
			return fn();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EACCES" && deniedCode === "EPERM")
				throw Object.assign(new Error("Modeled engine traversal denied"), { code: "EPERM" });
			throw error;
		} finally {
			chmodSync(dataDir, mode);
			inside = false;
		}
	};
	return {
		access,
		inside: () => inside,
		prepare: () => {
			prepared = true;
		},
	};
}

describe("physical daemon admission", () => {
	it("excludes existing shared homes across dataDirs without changing the SDK home", async () => {
		const f = fixture();
		const before = snapshot(f.home);
		const a = await claimDaemonAdmission(f.options("a"));
		let layouts = 0;
		const contender = {
			...f.options("b"),
			prepareOwnedDataDir: () => {
				layouts++;
				return undefined;
			},
		};
		await expect(claimDaemonAdmission(contender)).rejects.toThrow(/already running/);
		expect(existsSync(contender.dataDir)).toBe(false);
		expect(layouts).toBe(0);
		expect(snapshot(f.home)).toEqual(before);
		a.release();
		const b = await claimDaemonAdmission(f.options("b"));
		b.release();
	});

	it("maps default agent/external symlink aliases to the same physical home", async () => {
		const f = fixture();
		const data = join(f.root, "a");
		mkdirSync(data, { mode: 0o700 });
		const agent = join(data, "agent");
		renameSync(f.home, agent);
		const alias = join(f.root, "external");
		symlinkSync(agent, alias, "junction");
		const a = await claimDaemonAdmission(f.options("a", agent));
		await expect(claimDaemonAdmission(f.options("b", alias))).rejects.toThrow(/already running/);
		a.release();
	});

	it("excludes cross-role dataDir/SDK identity and deduplicates its own roles", async () => {
		const f = fixture();
		const a = await claimDaemonAdmission(f.options("a"));
		const before = snapshot(f.home);
		let dataClaims = 0;
		let layouts = 0;
		const contender = {
			...f.options("b", join(f.root, "other")),
			dataDir: f.home,
			prepareOwnedDataDir: () => {
				layouts++;
				return undefined;
			},
			claim: (targets: Parameters<typeof claimDaemonDirs>[0]) => {
				if (targets.some((target) => target.path === f.home)) dataClaims++;
				return claimDaemonDirs(targets);
			},
		};
		await expect(claimDaemonAdmission(contender)).rejects.toThrow(/already running/);
		expect(dataClaims).toBe(0);
		expect(layouts).toBe(0);
		expect(snapshot(f.home)).toEqual(before);
		a.release();
		const own = await claimDaemonAdmission({ ...f.options("same"), dataDir: f.home });
		own.assertCurrent();
		own.release();
	});

	permissionModel.each(["EACCES", "EPERM"])(
		"stages owned layout after exclusive data ownership before strict engine inspection (%s model)",
		async (deniedCode) => {
			const f = fixture();
			const data = join(f.root, "private-data");
			mkdirSync(data, { mode: 0o700 });
			const home = join(data, "agent");
			const model = modeledLayout(data, deniedCode);
			let layouts = 0;
			const options = {
				...f.options("private-data", home),
				engineAccess: model.access,
				accountHome: () => {
					expect(model.inside()).toBe(true);
					return f.account;
				},
				prepareOwnedDataDir: () => {
					layouts++;
					expect(model.inside()).toBe(false);
					expect(() => claimDaemonDirs([{ path: data }])).toThrow(/already running/);
					expect(existsSync(home)).toBe(false);
					model.prepare(); // Models ONLY normal traversal becoming available, not SDK creation.
					return undefined;
				},
			};
			const a = await claimDaemonAdmission(options);
			expect(layouts).toBe(1);
			expect(a.pendingHome).toBe(true);
			expect(existsSync(home)).toBe(false);
			a.assertCurrent();
			expect(() => a.promoteHome()).toThrow(/missing/);
			mkdirSync(home, { mode: 0o755 }); // Caller-owned ordinary creation, after admission.
			writeFileSync(join(home, "sentinel"), "SDK owned content");
			const before = snapshot(home);
			a.promoteHome();
			a.assertCurrent();
			expect(snapshot(home)).toEqual(before);
			expect(layouts).toBe(1);
			a.release();
		},
	);

	permissionModel.each(["denied", "dangling"])(
		"requires strict post-layout SDK checks after deferred inspection (%s model)",
		async (kind) => {
			const f = fixture();
			const data = join(f.root, "private-data");
			mkdirSync(data, { mode: 0o700 });
			const home = join(data, "agent");
			if (kind === "dangling") symlinkSync(join(f.root, "absent"), home, "junction");
			const model = modeledLayout(data);
			let layouts = 0;
			const options = {
				...f.options("private-data", home),
				engineAccess: model.access,
				prepareOwnedDataDir: () => {
					layouts++;
					if (kind === "dangling") model.prepare();
					return undefined;
				},
			};
			await expect(claimDaemonAdmission(options)).rejects.toThrow();
			expect(layouts).toBe(1);
			expect(existsSync(home)).toBe(false);
			if (kind === "dangling") expect(lstatSync(home).isSymbolicLink()).toBe(true);
			const legacy = claimDaemonDirs([{ path: data }]); // Acquisition rollback released OUR legacy lease.
			legacy.release();
		},
	);

	it("rolls back owned-layout failure and preserves failed cleanup ownership for explicit retry", async () => {
		const f = fixture();
		const before = snapshot(f.home);
		const options = {
			...f.options("a"),
			prepareOwnedDataDir: () => {
				throw new Error("ordinary layout failure");
			},
		};
		await expect(claimDaemonAdmission(options)).rejects.toThrow(/ordinary layout failure/);
		expect(snapshot(f.home)).toEqual(before);
		const a = await claimDaemonAdmission(f.options("a"));
		a.release();
		let retained: ReturnType<typeof claimDaemonDirs> | undefined;
		await expect(
			claimDaemonAdmission({
				...options,
				claim: (targets) => {
					const real = claimDaemonDirs(targets);
					if (targets[0]?.path !== options.dataDir) return real;
					retained = real;
					return {
						files: real.files,
						release() {
							throw new Error("layout rollback refusal");
						},
					};
				},
			}),
		).rejects.toThrow(/ordinary layout failure.*layout rollback refusal/);
		expect(() => claimDaemonDirs([{ path: options.dataDir }])).toThrow(/already running/);
		expect(snapshot(f.home)).toEqual(before);
		retained?.release();
		const b = await claimDaemonAdmission(f.options("a"));
		b.release();
	});

	it.each(["skip", "defer"])(
		"fences %s engine access after owned layout and retains failed rollback for retry",
		async (kind) => {
			const f = fixture();
			const data = join(f.root, "a");
			const home = join(data, "agent");
			let blocked = false;
			const deferred: (() => unknown)[] = [];
			const leases: ReturnType<typeof claimDaemonDirs>[] = [];
			const access: EngineAccess = <T>(fn: () => T): T => {
				if (!blocked) return fn();
				if (kind === "defer") deferred.push(fn);
				return undefined as T;
			};
			const options = {
				...f.options("a", home),
				engineAccess: access,
				prepareOwnedDataDir: () => {
					blocked = true;
					return undefined;
				},
				claim: (targets: Parameters<typeof claimDaemonDirs>[0]) => {
					const real = claimDaemonDirs(targets);
					leases.push(real);
					return real;
				},
			};
			await expect(claimDaemonAdmission(options)).rejects.toThrow(/synchronous/);
			expect(existsSync(home)).toBe(false);
			const before = readdirSync(data);
			blocked = false;
			for (const callback of deferred) expect(callback).toThrow(/synchronous/);
			expect(readdirSync(data)).toEqual(before);
			await expect(claimDaemonAdmission(f.options("b"))).rejects.toThrow(/already running/);
			for (const lease of leases) lease.release();
			const a = await claimDaemonAdmission(f.options("a", home));
			a.release();
		},
	);

	it("rejects a non-undefined layout result instead of acknowledging asynchronous layout", async () => {
		const f = fixture();
		const options = {
			...f.options("a"),
			prepareOwnedDataDir: (() => Promise.resolve()) as unknown as () => undefined,
		};
		await expect(claimDaemonAdmission(options)).rejects.toThrow(/synchronous.*undefined/);
		const a = await claimDaemonAdmission(f.options("a"));
		a.release();
	});

	permissionModel(
		"never defers external engine traversal denial or denial without a layout hook",
		async () => {
			const f = fixture();
			const data = join(f.root, "private-data");
			mkdirSync(data, { mode: 0o700 });
			const model = modeledLayout(data);
			await expect(
				claimDaemonAdmission({
					...f.options("private-data", join(data, "agent")),
					engineAccess: model.access,
				}),
			).rejects.toMatchObject({ code: "EACCES" });
			let layouts = 0;
			const options = {
				...f.options("other-data", join(data, "agent")),
				engineAccess: model.access,
				prepareOwnedDataDir: () => {
					layouts++;
					return undefined;
				},
			};
			await expect(claimDaemonAdmission(options)).rejects.toMatchObject({ code: "EACCES" });
			expect(layouts).toBe(0);
			expect(readdirSync(data)).toEqual([]);
			expect(existsSync(options.dataDir)).toBe(false);
			expect(existsSync(join(f.account, ".gentle-dot-daemon-claims"))).toBe(false);
		},
	);

	it("keeps missing home untouched, serializes startup, then promotes before admitting another", async () => {
		const f = fixture();
		const missing = join(f.root, "new", "external");
		const a = await claimDaemonAdmission(f.options("a", missing));
		expect(a.pendingHome).toBe(true);
		expect(existsSync(join(f.root, "new"))).toBe(false);
		let attempts = 0;
		const waiting = claimDaemonAdmission({
			...f.options("b"),
			startupAttempts: 20,
			retryDelayMs: 1,
			claim: (targets) => {
				attempts++;
				return claimDaemonDirs(targets);
			},
		});
		expect(existsSync(join(f.root, "b"))).toBe(false);
		// These are caller-owned ordinary startup effects, never coordinator initialization.
		mkdirSync(missing, { recursive: true, mode: 0o755 });
		writeFileSync(join(missing, "sentinel"), "SDK owned content");
		const before = snapshot(missing);
		a.promoteHome();
		expect(a.pendingHome).toBe(false);
		const b = await waiting;
		expect(attempts).toBeGreaterThan(1);
		expect(snapshot(missing)).toEqual(before);
		a.release();
		b.release();
	});

	it("retains pending ownership on failed promotion until explicit release", async () => {
		const f = fixture();
		const missing = join(f.root, "missing");
		const a = await claimDaemonAdmission(f.options("a", missing));
		expect(() => a.promoteHome()).toThrow(/missing|exist/i);
		await expect(claimDaemonAdmission(f.options("b"))).rejects.toThrow(/already running/);
		a.release();
		const b = await claimDaemonAdmission(f.options("b"));
		b.release();
	});

	it("refuses promotion of a newly created alias to an already admitted home", async () => {
		const f = fixture();
		const b = await claimDaemonAdmission(f.options("b"));
		const missing = join(f.root, "missing");
		const a = await claimDaemonAdmission(f.options("a", missing));
		symlinkSync(f.home, missing, "junction"); // Ordinary caller creation resolves to an occupied object.
		expect(() => a.promoteHome()).toThrow(/already running/);
		expect(a.pendingHome).toBe(true);
		await expect(claimDaemonAdmission(f.options("c"))).rejects.toThrow(/already running/);
		b.release();
		a.promoteHome();
		a.assertCurrent();
		a.release();
	});

	it("preserves acquisition and rollback failures without discarding pending leases", async () => {
		const f = fixture();
		const retained: ReturnType<typeof claimDaemonDirs>[] = [];
		const failure = claimDaemonAdmission({
			...f.options("a"),
			claim: (targets) => {
				if (targets[0]?.path === join(f.root, "a")) throw new Error("primary refusal");
				const real = claimDaemonDirs(targets);
				retained.push(real);
				return {
					files: real.files,
					release() {
						throw new Error("cleanup refusal");
					},
				};
			},
		});
		await expect(failure).rejects.toThrow(/primary refusal.*cleanup refusal/);
		await expect(claimDaemonAdmission(f.options("b"))).rejects.toThrow(/already running/);
		for (const lease of retained) lease.release();
		const b = await claimDaemonAdmission(f.options("b"));
		b.release();
	});

	it.each(["data", "home"])("detects %s identity drift but retains ownership", async (role) => {
		const f = fixture();
		const a = await claimDaemonAdmission(f.options("a"));
		const target = role === "data" ? join(f.root, "a") : f.home;
		renameSync(target, `${target}-old`);
		mkdirSync(target, { mode: 0o700 });
		expect(() => a.assertCurrent()).toThrow(/identity.*changed/i);
		await expect(
			claimDaemonAdmission(f.options("b", role === "home" ? `${target}-old` : f.home)),
		).rejects.toThrow(/already running/);
		// Restore caller's directory so the foundation can release its original lease safely.
		renameSync(target, `${target}-replacement`);
		renameSync(`${target}-old`, target);
		a.release();
	});

	it.each(["same", "ancestor", "descendant", "alias", "dangling"])(
		"rejects registry %s overlap/uncertainty before metadata or data effects",
		async (kind) => {
			const f = fixture();
			const registry = join(f.account, ".gentle-dot-daemon-claims");
			let selected = registry;
			if (kind === "ancestor") selected = f.account;
			if (kind === "descendant") selected = join(registry, "sdk");
			if (kind === "alias" || kind === "dangling") {
				selected = join(f.root, "alias");
				symlinkSync(kind === "alias" ? f.account : join(f.root, "absent"), selected, "junction");
			}
			let claims = 0;
			await expect(
				claimDaemonAdmission({
					...f.options("a", selected),
					claim: (targets) => {
						claims++;
						return claimDaemonDirs(targets);
					},
				}),
			).rejects.toThrow();
			expect(claims).toBe(0);
			expect(existsSync(registry)).toBe(false);
			expect(existsSync(join(f.root, "a"))).toBe(false);
		},
	);

	it("rejects a redirected private metadata subtree before any claim or data effects", async () => {
		const f = fixture();
		const registry = join(f.account, ".gentle-dot-daemon-claims");
		mkdirSync(registry, { mode: 0o700 });
		symlinkSync(f.home, join(registry, "physical"), "junction");
		const before = snapshot(f.home);
		let calls = 0;
		await expect(
			claimDaemonAdmission({
				...f.options("a"),
				claim: (targets) => {
					calls++;
					return claimDaemonDirs(targets);
				},
			}),
		).rejects.toThrow(/registry|metadata/i);
		expect(calls).toBe(0);
		expect(existsSync(join(f.root, "a"))).toBe(false);
		expect(snapshot(f.home)).toEqual(before);
	});

	it("rejects non-directory homes before data effects and never retries untyped failures", async () => {
		const f = fixture();
		const file = join(f.root, "file");
		writeFileSync(file, "do not touch");
		await expect(claimDaemonAdmission(f.options("a", file))).rejects.toThrow(/directory/i);
		expect(existsSync(join(f.root, "a"))).toBe(false);
		let calls = 0;
		await expect(
			claimDaemonAdmission({
				...f.options("a"),
				startupAttempts: 3,
				claim: () => {
					calls++;
					throw new Error("already running is not a type");
				},
			}),
		).rejects.toThrow(/not a type/);
		expect(calls).toBe(1);
	});

	it.each(["skip", "defer"])(
		"refuses %s access before late account lookup or filesystem effects",
		async (kind) => {
			const f = fixture();
			let late: (() => unknown) | undefined;
			let lookups = 0;
			const access: EngineAccess = <T>(fn: () => T): T => {
				if (kind === "defer") late = fn;
				return undefined as T;
			};
			await expect(
				claimDaemonAdmission({
					...f.options("a"),
					engineAccess: access,
					accountHome: () => {
						lookups++;
						return f.account;
					},
				}),
			).rejects.toThrow(/synchronous/i);
			if (late) expect(late).toThrow(/synchronous/i);
			expect(lookups).toBe(0);
			expect(existsSync(join(f.root, "a"))).toBe(false);
		},
	);

	it("reads account metadata and SDK identity in engine access, data identity outside it", async () => {
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
		const a = await claimDaemonAdmission({
			...f.options("a"),
			engineAccess: access,
			accountHome: () => {
				expect(inside).toBe(true);
				return f.account;
			},
			claim: (targets) => {
				for (const target of targets)
					expect(target.access ?? directAccess).toBe(
						target.path === join(f.root, "a") ? directAccess : access,
					);
				return claimDaemonDirs(targets);
			},
		});
		a.release();
	});

	it("rolls back acquisition, retains failed release for retry, and forbids post-close mutation", async () => {
		const f = fixture();
		let failAcquire = true;
		await expect(
			claimDaemonAdmission({
				...f.options("a"),
				claim: (targets) => {
					if (targets[0]?.path === join(f.root, "a") && failAcquire) {
						failAcquire = false;
						throw new Error("data failure");
					}
					return claimDaemonDirs(targets);
				},
			}),
		).rejects.toThrow(/data failure/);
		let failRelease = true;
		const a = await claimDaemonAdmission({
			...f.options("a"),
			claim: (targets) => {
				const real = claimDaemonDirs(targets);
				return {
					files: real.files,
					release() {
						if (targets[0]?.path === join(f.root, "a") && failRelease) {
							failRelease = false;
							throw new Error("release failure");
						}
						real.release();
					},
				};
			},
		});
		expect(() => a.release()).toThrow(/release failure/);
		a.release();
		a.release();
		expect(() => a.promoteHome()).toThrow(/closed/i);
		expect(() => a.assertCurrent()).toThrow(/closed/i);
		const b = await claimDaemonAdmission(f.options("a"));
		b.release();
		expect(lstatSync(f.home).isDirectory()).toBe(true);
	});
});

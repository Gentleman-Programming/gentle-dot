/**
 * The web PIN on a server (S25.8, docs/deploy-vps.md). Without the desktop app there is no native
 * dialog, so the web page confirms connector changes and sending actions with a PIN the user sets
 * on first use. Only a salted scrypt hash is kept, in `<data>/web-pin.json` (mode 0600, in a folder
 * the engine's user cannot list), compared in constant time. After {@link PIN_ATTEMPTS} wrong tries
 * in a row it is locked for {@link PIN_LOCK_MS}; the count and the lock are in the same file, so a
 * restart does not reset them. Checks run one at a time, so tries sent together still count one by
 * one. The PIN reaches the daemon over the WebSocket and goes nowhere else: not to the engine, not
 * to a log. Forgotten PIN: remove the file on the server (docs/deploy-vps.md), then set a new one.
 */
import { randomBytes, type ScryptOptions, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { PIN_PATTERN, type PinStatus } from "@gentle-dot/protocol";
import { writePrivateFile } from "./private-file.ts";

export const PIN_FILE = "web-pin.json";
/** Wrong tries in a row before the PIN locks. */
export const PIN_ATTEMPTS = 5;
/** How long it stays locked. */
export const PIN_LOCK_MS = 15 * 60_000;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const HASH_BYTES = 32;

export type PinOutcome =
	| { ok: true }
	| {
			ok: false;
			code: "pin_required" | "pin_wrong" | "pin_locked" | "pin_invalid" | "pin_exists";
			message: string;
	  };

interface Saved {
	version: 1;
	kdf: "scrypt";
	N: number;
	r: number;
	p: number;
	salt: string;
	hash: string;
	failures: number;
	lockedUntil: number;
}

const DAMAGED: PinOutcome = {
	ok: false,
	code: "pin_locked",
	message:
		"The PIN file on the server is damaged. Remove it on the server to set a new PIN (see the deploy guide).",
};

function derive(pin: string, salt: Buffer, options: ScryptOptions & { N: number }): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scrypt(pin, salt, HASH_BYTES, options, (error, key) => (error ? reject(error) : resolve(key))),
	);
}

export class PinGate {
	private readonly file: string;
	private readonly now: () => number;
	/** Every set and check, one after the other. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: { file: string; now?: () => number }) {
		this.file = options.file;
		this.now = options.now ?? Date.now;
	}

	status(): PinStatus {
		const saved = this.load();
		if (saved === undefined) return { set: false };
		if (saved === "damaged" || saved.lockedUntil > this.now()) return { set: true, locked: true };
		return { set: true };
	}

	/** Sets the PIN when there is none yet; never replaces one. */
	set(pin: string): Promise<PinOutcome> {
		return this.serial(async () => {
			if (!PIN_PATTERN.test(pin)) return { ok: false, code: "pin_invalid", message: "Use 6 to 12 digits." };
			const saved = this.load();
			if (saved === "damaged") return DAMAGED;
			if (saved !== undefined)
				return { ok: false, code: "pin_exists", message: "A PIN is already set for this assistant." };
			const salt = randomBytes(16);
			const hash = await derive(pin, salt, SCRYPT);
			const { N, r, p } = SCRYPT;
			this.save({
				version: 1,
				kdf: "scrypt",
				N,
				r,
				p,
				salt: salt.toString("base64"),
				hash: hash.toString("base64"),
				failures: 0,
				lockedUntil: 0,
			});
			return { ok: true };
		});
	}

	/** Checks the PIN; a wrong one counts towards the lock. */
	verify(pin: string): Promise<PinOutcome> {
		return this.serial(async () => {
			const saved = this.load();
			if (saved === "damaged") return DAMAGED;
			if (saved === undefined) return { ok: false, code: "pin_required", message: "Set a PIN first." };
			if (saved.lockedUntil > this.now()) return this.locked(saved);
			const expected = Buffer.from(saved.hash, "base64");
			const given = PIN_PATTERN.test(pin)
				? await derive(pin, Buffer.from(saved.salt, "base64"), {
						N: saved.N,
						r: saved.r,
						p: saved.p,
						maxmem: SCRYPT.maxmem,
					})
				: Buffer.alloc(expected.length);
			if (given.length === expected.length && timingSafeEqual(given, expected) && PIN_PATTERN.test(pin)) {
				if (saved.failures !== 0 || saved.lockedUntil !== 0)
					this.save({ ...saved, failures: 0, lockedUntil: 0 });
				return { ok: true };
			}
			const failures = saved.failures + 1;
			if (failures >= PIN_ATTEMPTS) {
				const lockedUntil = this.now() + PIN_LOCK_MS;
				this.save({ ...saved, failures: 0, lockedUntil });
				return this.locked({ ...saved, lockedUntil });
			}
			this.save({ ...saved, failures, lockedUntil: 0 });
			const left = PIN_ATTEMPTS - failures;
			return {
				ok: false,
				code: "pin_wrong",
				message: `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left before it locks for ${PIN_LOCK_MS / 60_000} minutes.`,
			};
		});
	}

	private locked(saved: Saved): PinOutcome {
		const minutes = Math.max(1, Math.ceil((saved.lockedUntil - this.now()) / 60_000));
		return {
			ok: false,
			code: "pin_locked",
			message: `Too many wrong PINs. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
		};
	}

	private serial<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	/** The saved PIN, undefined when none was set, or `damaged` when the file cannot be trusted. */
	private load(): Saved | undefined | "damaged" {
		if (!existsSync(this.file)) return undefined;
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Saved>;
			const numbers = [saved.N, saved.r, saved.p, saved.failures, saved.lockedUntil];
			if (
				saved.version === 1 &&
				saved.kdf === "scrypt" &&
				numbers.every((n) => Number.isSafeInteger(n) && (n as number) >= 0) &&
				typeof saved.salt === "string" &&
				typeof saved.hash === "string" &&
				Buffer.from(saved.hash, "base64").length === HASH_BYTES
			)
				return saved as Saved;
		} catch {}
		return "damaged";
	}

	private save(saved: Saved): void {
		writePrivateFile(this.file, `${JSON.stringify(saved)}\n`);
	}
}

// The web PIN on a server (S25.8): set once in the web page, kept only as a salted scrypt hash in a
// file of the daemon, and locked after repeated wrong tries, also across restarts.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIN_ATTEMPTS, PIN_LOCK_MS, PinGate } from "../src/web-pin.ts";
import { tempDir } from "./helpers.ts";

const PIN = "482913";

function gate(file = join(tempDir(), "web-pin.json")) {
	let now = 1_000_000;
	const clock = { advance: (ms: number) => (now += ms) };
	return { file, clock, pin: new PinGate({ file, now: () => now }) };
}

describe("web PIN", () => {
	it("is set on first use only, and only its salted hash reaches the disk", async () => {
		const { file, pin } = gate();
		expect(pin.status()).toEqual({ set: false });
		expect(existsSync(file)).toBe(false);
		// Nothing can be checked before the PIN exists.
		expect(await pin.verify(PIN)).toMatchObject({ ok: false, code: "pin_required" });
		expect(await pin.set(PIN)).toEqual({ ok: true });
		expect(pin.status()).toEqual({ set: true });
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(PIN);
		const saved = JSON.parse(text) as Record<string, unknown>;
		expect(saved).toMatchObject({ version: 1, kdf: "scrypt" });
		expect(typeof saved.salt).toBe("string");
		expect(typeof saved.hash).toBe("string");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// Two PINs set from the same digits still differ: the salt is random.
		const other = gate();
		await other.pin.set(PIN);
		expect(JSON.parse(readFileSync(other.file, "utf8")).hash).not.toBe(saved.hash);

		// Set once: a second set does not replace it.
		expect(await pin.set("111111")).toMatchObject({ ok: false, code: "pin_exists" });
		expect(readFileSync(file, "utf8")).toBe(text);
		expect(await pin.verify(PIN)).toEqual({ ok: true });
		expect(await new PinGate({ file }).verify(PIN)).toEqual({ ok: true });
	});

	it("refuses a PIN that is not 6 to 12 digits", async () => {
		const { file, pin } = gate();
		expect(await pin.set("1234")).toMatchObject({ ok: false, code: "pin_invalid" });
		expect(existsSync(file)).toBe(false);
	});

	it("locks after repeated wrong tries, even for the right PIN, and stays locked after a restart", async () => {
		const { file, clock, pin } = gate();
		await pin.set(PIN);
		for (let i = 1; i < PIN_ATTEMPTS; i++) {
			const wrong = await pin.verify("000000");
			expect(wrong).toMatchObject({ ok: false, code: "pin_wrong" });
			if (!wrong.ok) expect(wrong.message).toContain(`${PIN_ATTEMPTS - i}`);
		}
		expect(await pin.verify("000000")).toMatchObject({ ok: false, code: "pin_locked" });
		expect(pin.status()).toEqual({ set: true, locked: true });
		expect(await pin.verify(PIN)).toMatchObject({ ok: false, code: "pin_locked" });
		// A restarted daemon reads the lock from its file.
		const restarted = new PinGate({ file, now: () => 1_000_000 + 60_000 });
		expect(await restarted.verify(PIN)).toMatchObject({ ok: false, code: "pin_locked" });
		clock.advance(PIN_LOCK_MS + 1);
		expect(pin.status()).toEqual({ set: true });
		expect(await pin.verify(PIN)).toEqual({ ok: true });
	});

	it("counts tries made at the same time, one after the other", async () => {
		const { pin } = gate();
		await pin.set(PIN);
		const answers = await Promise.all(Array.from({ length: PIN_ATTEMPTS + 3 }, () => pin.verify("000000")));
		expect(answers.filter((a) => !a.ok && a.code === "pin_wrong")).toHaveLength(PIN_ATTEMPTS - 1);
		expect(answers.filter((a) => !a.ok && a.code === "pin_locked")).toHaveLength(4);
	});

	it("a right PIN clears the count of wrong tries", async () => {
		const { pin } = gate();
		await pin.set(PIN);
		for (let i = 1; i < PIN_ATTEMPTS; i++) await pin.verify("000000");
		expect(await pin.verify(PIN)).toEqual({ ok: true });
		expect(await pin.verify("000000")).toMatchObject({
			ok: false,
			code: "pin_wrong",
			message: expect.stringContaining(`${PIN_ATTEMPTS - 1}`),
		});
	});

	it("fails closed on a damaged PIN file instead of letting a new PIN replace it", async () => {
		const { file, pin } = gate();
		writeFileSync(file, "not json");
		expect(pin.status()).toEqual({ set: true, locked: true });
		expect(await pin.set(PIN)).toMatchObject({ ok: false });
		expect(await pin.verify(PIN)).toMatchObject({ ok: false, code: "pin_locked" });
		expect(readFileSync(file, "utf8")).toBe("not json");
	});
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserSettings } from "../src/user-settings.ts";

const dirs: string[] = [];
function setup(raw?: string) {
	const dir = mkdtempSync(join(tmpdir(), "dot-user-settings-"));
	dirs.push(dir);
	const file = join(dir, "user-settings.json");
	if (raw !== undefined) writeFileSync(file, raw);
	return { dir, file, store: new UserSettings(dir) };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("daemon user settings", () => {
	it("defaults to continuous chat and uses only the exact legacy environment fallback", () => {
		const { store } = setup();
		for (const value of [undefined, "", "0", "true"]) expect(store.conversations(value)).toBe(false);
		expect(store.conversations("1")).toBe(true);
	});

	it.each([false, true])(
		"persists an explicit %s even when equal to the fallback, and reloads before env",
		(value) => {
			const { dir, file, store } = setup();
			store.setConversations(value);
			expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ conversations: value });
			const reloaded = new UserSettings(dir);
			expect(reloaded.conversations(value ? "0" : "1")).toBe(value);
			if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		},
	);

	it("preserves unrelated keys and reads them again before each write", () => {
		const { file, store } = setup('{"future":{"choice":7}}');
		store.setConversations(true);
		writeFileSync(file, '{"future":{"choice":8},"conversations":true}');
		store.setConversations(false);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ future: { choice: 8 }, conversations: false });
	});

	it.each(["{broken", "[]", "null", "1", '{"conversations":"true"}', '{"conversations":null}'])(
		"refuses corrupt settings without replacing %s",
		(raw) => {
			const { file, store } = setup(raw);
			expect(() => store.conversations("1")).toThrow();
			expect(() => store.setConversations(false)).toThrow();
			expect(readFileSync(file, "utf8")).toBe(raw);
		},
	);

	it("rejects a non-boolean without changing the saved choice", () => {
		const { file, store } = setup('{"conversations":true}');
		expect(() => store.setConversations("false" as unknown as boolean)).toThrow();
		expect(readFileSync(file, "utf8")).toBe('{"conversations":true}');
	});

	it("reports read and write failures rather than pretending the preference was saved", () => {
		const { dir, file, store } = setup();
		mkdirSync(file);
		expect(() => store.conversations()).toThrow();
		expect(() => store.setConversations(false)).toThrow();
		const missing = new UserSettings(join(dir, "missing"));
		expect(() => missing.setConversations(true)).toThrow();
	});
});

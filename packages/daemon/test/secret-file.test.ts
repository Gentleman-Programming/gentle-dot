// Connector secrets on a server (S25.8): no desktop app, so the daemon keeps them in a file of its
// own, each one encrypted with AES-256-GCM under a key that only the daemon's environment holds.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSecretSource, NO_SECRETS_KEY, parseSecretsKey } from "../src/secret-file.ts";
import { SecretsUnavailableError } from "../src/secret-source.ts";
import { tempDir } from "./helpers.ts";

const SECRET = "xoxb-plain-bot-token-0123456789";

function store(key: Buffer | undefined) {
	const file = join(tempDir(), "secrets.enc.json");
	return { file, key, source: new FileSecretSource({ file, key }) };
}

describe("encrypted secrets file", () => {
	it("stores a secret that only the same key reads back, with no plaintext on disk", async () => {
		const { file, key, source } = store(randomBytes(32));
		expect(source.available).toBe(true);
		await source.put("connector/slack/bot", SECRET);
		await source.put("integrity/connectors", "a".repeat(64));
		const text = readFileSync(file, "utf8");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain(Buffer.from(SECRET).toString("base64"));
		expect(text).not.toContain("a".repeat(64));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		// Every record has its own nonce: the same secret twice is two different ciphertexts.
		await source.put("connector/discord/bot", SECRET);
		const records = JSON.parse(readFileSync(file, "utf8")).records as Record<
			string,
			{ data: string; nonce: string }
		>;
		expect(records["connector/slack/bot"]?.nonce).not.toBe(records["connector/discord/bot"]?.nonce);
		expect(records["connector/slack/bot"]?.data).not.toBe(records["connector/discord/bot"]?.data);

		const again = new FileSecretSource({ file, key });
		expect(await again.get("connector/slack/bot")).toBe(SECRET);
		expect(await again.get("missing/one")).toBeUndefined();
		expect(await again.list()).toEqual([
			"connector/discord/bot",
			"connector/slack/bot",
			"integrity/connectors",
		]);
		expect(await again.delete("connector/discord/bot")).toBe(true);
		expect(await again.delete("connector/discord/bot")).toBe(false);
		expect(await again.list()).toEqual(["connector/slack/bot", "integrity/connectors"]);
	});

	it("fails closed without a key, saying which variable to set, and writes nothing", async () => {
		const { file, source } = store(undefined);
		expect(source.available).toBe(false);
		await expect(source.put("connector/slack/bot", SECRET)).rejects.toThrow(SecretsUnavailableError);
		await expect(source.get("connector/slack/bot")).rejects.toThrow(/GENTLE_DOT_SECRETS_KEY/);
		await expect(source.list()).rejects.toThrow(NO_SECRETS_KEY);
		expect(existsSync(file)).toBe(false);
	});

	it("refuses a wrong key without changing the file", async () => {
		const { file, source } = store(randomBytes(32));
		await source.put("connector/slack/bot", SECRET);
		const before = readFileSync(file, "utf8");
		const wrong = new FileSecretSource({ file, key: randomBytes(32) });
		await expect(wrong.get("connector/slack/bot")).rejects.toThrow(SecretsUnavailableError);
		await expect(wrong.get("connector/slack/bot")).rejects.toThrow(/cannot be opened/);
		// A wrong key never writes: a put or a delete would mix two keys in one file.
		await expect(wrong.put("connector/notion/token", "other")).rejects.toThrow(/cannot be opened/);
		await expect(wrong.delete("connector/slack/bot")).rejects.toThrow(/cannot be opened/);
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	it("detects a changed ciphertext and a record moved to another id", async () => {
		const { file, key, source } = store(randomBytes(32));
		await source.put("connector/slack/bot", SECRET);
		await source.put("connector/notion/token", "notion-token");
		const saved = JSON.parse(readFileSync(file, "utf8"));
		const flipped = structuredClone(saved);
		const data = Buffer.from(flipped.records["connector/slack/bot"].data, "base64");
		data[0] = (data[0] ?? 0) ^ 1;
		flipped.records["connector/slack/bot"].data = data.toString("base64");
		writeFileSync(file, JSON.stringify(flipped));
		await expect(new FileSecretSource({ file, key }).get("connector/slack/bot")).rejects.toThrow(
			SecretsUnavailableError,
		);
		// Each record is bound to its id: Slack's record under Notion's id does not open.
		const swapped = structuredClone(saved);
		swapped.records["connector/notion/token"] = saved.records["connector/slack/bot"];
		writeFileSync(file, JSON.stringify(swapped));
		await expect(new FileSecretSource({ file, key }).get("connector/notion/token")).rejects.toThrow(
			/cannot be opened/,
		);
	});

	it("reads the key as 32 bytes in base64 or hex, and nothing else", () => {
		const key = randomBytes(32);
		expect(parseSecretsKey(key.toString("base64"))).toEqual(key);
		expect(parseSecretsKey(key.toString("base64url"))).toEqual(key);
		expect(parseSecretsKey(key.toString("hex"))).toEqual(key);
		expect(parseSecretsKey(`  ${key.toString("base64")}\n`)).toEqual(key);
		for (const text of [undefined, "", "short", randomBytes(16).toString("base64"), "z".repeat(64)])
			expect(parseSecretsKey(text), String(text)).toBeUndefined();
	});
});

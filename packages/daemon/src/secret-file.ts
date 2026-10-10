/**
 * Connector secrets on a server (S25.8, docs/deploy-vps.md): there is no desktop app and no OS
 * store, so the daemon keeps them in `<data>/secrets.enc.json` (mode 0600, in a folder the engine's
 * user cannot list). Each secret is encrypted on its own with AES-256-GCM: a random 12-byte nonce
 * per write, and its id as additional data, so a record moved to another id does not open. The key
 * is 32 bytes from `GENTLE_DOT_SECRETS_KEY`, read only from the daemon's environment; the daemon
 * never writes it to a file and never passes it to a child. Without it, or with another key, every
 * call fails closed with a reason the user can act on, and nothing is written.
 *
 * File: `{"version":1,"records":{"<id>":{"nonce":"<base64>","data":"<base64>","tag":"<base64>"}}}`.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writePrivateFile } from "./private-file.ts";
import { type SecretSource, SecretsUnavailableError } from "./secret-source.ts";

/** The daemon's environment variable with the key. */
export const SECRETS_KEY_VAR = "GENTLE_DOT_SECRETS_KEY";
/** The file's name in the data folder. */
export const SECRETS_FILE = "secrets.enc.json";

export const NO_SECRETS_KEY = `Connectors that need a secret are off on this server: set ${SECRETS_KEY_VAR} (32 random bytes in base64, for example from \`openssl rand -base64 32\`) and restart Gentle Dot.`;
export const BAD_SECRETS_KEY = `${SECRETS_KEY_VAR} must be 32 bytes in base64 or hex (for example from \`openssl rand -base64 32\`); connectors that need a secret are off until it is.`;
const CANNOT_OPEN = `The stored connector secrets cannot be opened with this ${SECRETS_KEY_VAR} (another key, or the file was changed); nothing was read or written.`;
const DAMAGED = `The stored connector secrets file is damaged; nothing was read or written. Restore it from a backup, or remove ${SECRETS_FILE} and sign in to the connectors again.`;

const ID = /^[A-Za-z0-9._:@/-]{1,200}$/;
const AAD = "gentle-dot/secrets/v1\n";

/** The key as bytes: 64 hex digits, or base64 (standard or URL-safe) of exactly 32 bytes. */
export function parseSecretsKey(text: string | undefined): Buffer | undefined {
	const value = text?.trim() ?? "";
	if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
	if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) return undefined;
	const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
	return key.length === 32 ? key : undefined;
}

interface SealedRecord {
	nonce: string;
	data: string;
	tag: string;
}

export interface FileSecretSourceOptions {
	file: string;
	/** Undefined when the key is missing or not valid; `problem` then says why. */
	key: Buffer | undefined;
	problem?: string;
}

export class FileSecretSource implements SecretSource {
	private readonly options: FileSecretSourceOptions;

	constructor(options: FileSecretSourceOptions) {
		this.options = options;
	}

	get available(): boolean {
		return this.options.key !== undefined;
	}

	get unavailable(): string | undefined {
		return this.options.key ? undefined : (this.options.problem ?? NO_SECRETS_KEY);
	}

	async get(id: string): Promise<string | undefined> {
		const records = this.read(id);
		const record = records[id];
		return record === undefined ? undefined : this.open(id, record);
	}

	async put(id: string, secret: string): Promise<void> {
		const records = this.readAll(id);
		records[id] = this.seal(id, secret);
		this.write(records);
	}

	async delete(id: string): Promise<boolean> {
		const records = this.readAll(id);
		if (records[id] === undefined) return false;
		delete records[id];
		this.write(records);
		return true;
	}

	async list(): Promise<string[]> {
		return Object.keys(this.read()).sort();
	}

	private key(): Buffer {
		const key = this.options.key;
		if (!key) throw new SecretsUnavailableError(this.options.problem ?? NO_SECRETS_KEY);
		return key;
	}

	/** The records as stored, after checking the key and the id; none when there is no file yet. */
	private read(id?: string): Record<string, SealedRecord> {
		this.key();
		if (id !== undefined && !ID.test(id)) throw new Error("That secret id is not valid.");
		let text: string;
		try {
			text = readFileSync(this.options.file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw new SecretsUnavailableError(DAMAGED);
		}
		try {
			const parsed = JSON.parse(text) as { version?: unknown; records?: unknown };
			if (parsed.version === 1 && typeof parsed.records === "object" && parsed.records !== null)
				return parsed.records as Record<string, SealedRecord>;
		} catch {}
		throw new SecretsUnavailableError(DAMAGED);
	}

	/** Every record, each checked to open with this key: a write never mixes two keys in one file. */
	private readAll(id: string): Record<string, SealedRecord> {
		const records = this.read(id);
		for (const [name, record] of Object.entries(records)) this.open(name, record);
		return records;
	}

	private seal(id: string, secret: string): SealedRecord {
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", this.key(), nonce);
		cipher.setAAD(Buffer.from(AAD + id, "utf8"));
		const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
		return {
			nonce: nonce.toString("base64"),
			data: data.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
		};
	}

	private open(id: string, record: SealedRecord): string {
		try {
			const nonce = Buffer.from(record.nonce, "base64");
			const tag = Buffer.from(record.tag, "base64");
			if (nonce.length !== 12 || tag.length !== 16) throw new Error("bad record");
			const decipher = createDecipheriv("aes-256-gcm", this.key(), nonce);
			decipher.setAAD(Buffer.from(AAD + id, "utf8"));
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(Buffer.from(record.data, "base64")), decipher.final()]).toString(
				"utf8",
			);
		} catch {
			throw new SecretsUnavailableError(CANNOT_OPEN);
		}
	}

	private write(records: Record<string, SealedRecord>): void {
		writePrivateFile(this.options.file, `${JSON.stringify({ version: 1, records })}\n`);
	}
}

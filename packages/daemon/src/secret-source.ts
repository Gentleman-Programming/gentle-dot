/**
 * Where the daemon gets connector secrets (S25.5, docs/design.md "Security"): bot tokens, client
 * secrets, imported headers and environment values, and OAuth sign-ins. On the desktop they live in
 * Keychain items the signed app creates (`apps/desktop` `secure_store`), and reach the daemon over
 * the app's private channel (`secret_get`, `secret_put`, `secret_delete`, `secret_list`). The daemon
 * keeps them in memory only and never writes them to a file or a log. Without the app (a daemon it
 * only attached to, one started from a terminal, the web) there is no source, and connectors that
 * need a secret fail closed with {@link NO_APP}; there is no file fallback. A server in server mode
 * (S25.8) has its own source instead: an encrypted file (`secret-file.ts`).
 */
import { APPROVAL_WAIT_MS, type AppChannel } from "./app-channel.ts";

/** Why a connector that needs a secret cannot run: the secrets are only in the app's store. */
export const NO_APP = "Open the Gentle Dot app to use this connector.";

/**
 * The app's answer when Linux has no usable Secret Service (`StoreError::Unavailable` in `secure_store/linux.rs`).
 * Other platforms keep their earlier message.
 */
const NO_KEYRING = /^the secret store is unavailable: .*Secret Service/;

/** The secret store is not reachable; `message` is safe to show. */
export class SecretsUnavailableError extends Error {
	constructor(message = NO_APP) {
		super(message);
		this.name = "SecretsUnavailableError";
	}
}

export interface SecretSource {
	/** False while there is no app to ask; every call then rejects with {@link SecretsUnavailableError}. */
	readonly available: boolean;
	/** Why it is not available, when the source knows better than {@link NO_APP}; safe to show. */
	readonly unavailable?: string | undefined;
	/** The secret under `id`, or undefined when there is none. */
	get(id: string): Promise<string | undefined>;
	/** Stores `secret` under `id`, replacing any previous one. */
	put(id: string, secret: string): Promise<void>;
	/** Removes the secret under `id`; true when one was there. */
	delete(id: string): Promise<boolean>;
	/** Every id in the store. */
	list(): Promise<string[]>;
}

/** Secret ids the app accepts (`secure_store::check_id`). */
const ID = /^[A-Za-z0-9._:@/-]{1,200}$/;

/**
 * The desktop app's Keychain over its channel. A Keychain read can wait for a SecurityAgent prompt
 * (an item made by another build), so calls wait as long as an approval does. A failure never
 * carries a secret: the app answers with the store's error, and the daemon adds nothing.
 */
export class AppSecretSource implements SecretSource {
	private readonly channel: AppChannel | undefined;
	private readonly timeoutMs: number;

	constructor(channel: AppChannel | undefined, timeoutMs = APPROVAL_WAIT_MS) {
		this.channel = channel;
		this.timeoutMs = timeoutMs;
	}

	get available(): boolean {
		return this.channel?.connected === true;
	}

	async get(id: string): Promise<string | undefined> {
		const result = (await this.call("secret_get", { id })) as { secret?: unknown } | null | undefined;
		return typeof result?.secret === "string" ? result.secret : undefined;
	}

	async put(id: string, secret: string): Promise<void> {
		await this.call("secret_put", { id, secret });
	}

	async delete(id: string): Promise<boolean> {
		const result = (await this.call("secret_delete", { id })) as { deleted?: unknown } | undefined;
		return result?.deleted === true;
	}

	async list(): Promise<string[]> {
		const result = (await this.call("secret_list", {})) as { ids?: unknown } | undefined;
		return Array.isArray(result?.ids) ? result.ids.filter((id): id is string => typeof id === "string") : [];
	}

	private async call(method: string, params: { id?: string; secret?: string }): Promise<unknown> {
		const channel = this.channel;
		if (!channel?.connected) throw new SecretsUnavailableError();
		if (params.id !== undefined && !ID.test(params.id)) throw new Error("That secret id is not valid.");
		try {
			return await channel.request(method, params, this.timeoutMs);
		} catch (error) {
			if (!channel.connected) throw new SecretsUnavailableError();
			const message = (error as Error).message;
			// The app's own words for a missing keyring on Linux, safe to show (S25.7).
			if (NO_KEYRING.test(message)) throw new SecretsUnavailableError(`T${message.slice(1)}`);
			throw new Error(`The app's secure store refused it: ${message}`);
		}
	}
}

/** An in-memory store, for tests; `corrupt` makes reads of an id return something else. */
export class MemorySecretSource implements SecretSource {
	available = true;
	readonly values = new Map<string, string>();
	/** The ids of every put, in order. */
	readonly puts: string[] = [];
	corrupt: (id: string) => boolean = () => false;

	async get(id: string): Promise<string | undefined> {
		this.check(id);
		const value = this.values.get(id);
		return value !== undefined && this.corrupt(id) ? `${value}-changed` : value;
	}

	async put(id: string, secret: string): Promise<void> {
		this.check(id);
		this.values.set(id, secret);
		this.puts.push(id);
	}

	async delete(id: string): Promise<boolean> {
		this.check(id);
		return this.values.delete(id);
	}

	async list(): Promise<string[]> {
		if (!this.available) throw new SecretsUnavailableError();
		return [...this.values.keys()].sort();
	}

	private check(id: string): void {
		if (!this.available) throw new SecretsUnavailableError();
		if (!ID.test(id)) throw new Error("That secret id is not valid.");
	}
}

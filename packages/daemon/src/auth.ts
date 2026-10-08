import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AuthEvent, AuthMethod, AuthPrompt, AuthProvider, ServerPayload } from "@gentle-dot/protocol";
import { presentText } from "./white-label.ts";

type PromptRequest = {
	type: AuthPrompt["kind"];
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string; description?: string }[];
	signal?: AbortSignal;
};

type EventRequest =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface AuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: PromptRequest): Promise<string>;
	notify(event: EventRequest): void;
}

/** The part of Pi's ModelRuntime the assistant uses for sign-in. */
export interface AuthRuntime {
	getProviders(): readonly {
		id: string;
		name: string;
		auth: { apiKey?: { name: string }; oauth?: { name: string } };
	}[];
	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string };
	login(
		providerId: string,
		type: AuthMethod,
		interaction: AuthInteraction,
		options?: { getDeviceId?: () => string },
	): Promise<unknown>;
	logout(providerId: string): Promise<void>;
}

/** The assistant's own engine home: never the user's Gentle Shell or Pi home unless explicitly overridden. */
export function resolveAgentHome(env: NodeJS.ProcessEnv, dataDir: string): string {
	return resolve(env.GENTLE_DOT_AGENT_HOME ?? join(dataDir, "agent"));
}

/** Pi's ModelRuntime on the assistant's home: same auth.json format and file locking as Gentle Shell. */
export async function createModelAuthRuntime(agentHome: string, cwd: string): Promise<AuthRuntime> {
	mkdirSync(agentHome, { recursive: true, mode: 0o700 });
	const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create({
		authPath: join(agentHome, "auth.json"),
		modelsPath: join(agentHome, "models.json"),
		// Offline, but refreshed on create so credentials saved by other runtimes are visible.
		allowModelNetwork: false,
	});
	const settings = SettingsManager.create(cwd, agentHome);
	return {
		getProviders: () => runtime.getProviders() as unknown as ReturnType<AuthRuntime["getProviders"]>,
		getProviderAuthStatus: (providerId) => runtime.getProviderAuthStatus(providerId),
		login: (providerId, type, interaction) =>
			runtime.login(providerId, type, interaction as never, {
				getDeviceId: () => settings.getOrCreateDeviceId(),
			}),
		logout: (providerId) => runtime.logout(providerId),
	};
}

type Emit = (payload: ServerPayload) => void;

/** Sign-in methods the assistant never offers: a Claude subscription cannot be used legally from here. */
const UNSUPPORTED_METHODS: Readonly<Record<string, AuthMethod>> = { anthropic: "oauth" };

const isUnsupported = (providerId: string, method: AuthMethod) =>
	Object.hasOwn(UNSUPPORTED_METHODS, providerId) && UNSUPPORTED_METHODS[providerId] === method;

/** Why a sign-in or sign-out did not start; `message` is safe to show. */
export type AuthRefusal = { code: "auth_busy" | "auth_unsupported" | "unknown_provider"; message: string };

const REFUSALS = {
	busy: { code: "auth_busy", message: "Another sign-in is in progress. Finish or cancel it first." },
	unsupported: {
		code: "auth_unsupported",
		message: "Signing in with a Claude subscription is not supported. Use an Anthropic API key instead.",
	},
	unknown: { code: "unknown_provider", message: "That account is not available." },
} as const satisfies Record<string, AuthRefusal>;

interface Flow {
	id: string;
	providerId: string;
	owner: object;
	controller: AbortController;
	pending?: { resolve: (value: string) => void; reject: (error: Error) => void };
	/** Values the user typed in this flow; removed from anything logged. */
	answers: string[];
}

export interface AuthManagerOptions {
	runtime: () => Promise<AuthRuntime>;
	log?: (line: string) => void;
}

/**
 * Runs sign-in flows for the UI. One flow at a time (OAuth callback ports are
 * shared), prompts go to the window that started it, and typed answers never
 * reach logs.
 */
export class AuthManager {
	private flow: Flow | undefined;
	private readonly options: AuthManagerOptions;
	onCredentialsChanged: () => void = () => {};

	constructor(options: AuthManagerOptions) {
		this.options = options;
	}

	async providers(): Promise<AuthProvider[]> {
		const runtime = await this.options.runtime();
		return runtime.getProviders().flatMap((provider) => {
			const oauth = isUnsupported(provider.id, "oauth") ? undefined : provider.auth.oauth;
			const methods: AuthMethod[] = [];
			if (oauth) methods.push("oauth");
			if (provider.auth.apiKey && !isUnsupported(provider.id, "api_key")) methods.push("api_key");
			if (methods.length === 0) return [];
			const status = runtime.getProviderAuthStatus(provider.id);
			const entry: AuthProvider = {
				id: provider.id,
				name: provider.name,
				methods,
				configured: status.configured,
			};
			if (oauth) entry.oauthName = oauth.name;
			if (status.configured && status.source) entry.source = status.source;
			return [entry];
		});
	}

	/** Starts a flow, or says why it did not start. */
	start(owner: object, providerId: string, method: AuthMethod, emit: Emit): AuthRefusal | undefined {
		if (isUnsupported(providerId, method)) return REFUSALS.unsupported;
		if (this.flow) return REFUSALS.busy;
		const flow: Flow = {
			id: randomUUID(),
			providerId,
			owner,
			controller: new AbortController(),
			answers: [],
		};
		this.flow = flow;
		void this.run(flow, method, emit);
		return undefined;
	}

	/** Delivers the user's answer (or cancellation) to the prompt of a flow `owner` started. */
	reply(owner: object, flowId: string, answer: { value?: string; cancelled?: boolean }): boolean {
		const flow = this.flow;
		if (!flow || flow.id !== flowId || flow.owner !== owner) return false;
		if (answer.cancelled) {
			flow.controller.abort();
			return true;
		}
		if (!flow.pending || answer.value === undefined) return false;
		flow.answers.push(answer.value);
		const { resolve } = flow.pending;
		flow.pending = undefined;
		resolve(answer.value);
		return true;
	}

	/** A window that goes away takes its sign-in with it. */
	cancelOwnedBy(owner: object): void {
		if (this.flow?.owner === owner) this.flow.controller.abort();
	}

	/** Signs out of a listed provider, or says why not. */
	async logout(providerId: string): Promise<AuthRefusal | undefined> {
		const runtime = await this.options.runtime();
		if (!runtime.getProviders().some((provider) => provider.id === providerId)) return REFUSALS.unknown;
		await runtime.logout(providerId);
		this.log(`signed out of ${providerId}`);
		this.onCredentialsChanged();
		return undefined;
	}

	/** True when at least one provider has a credential. */
	async hasAccount(): Promise<boolean> {
		const runtime = await this.options.runtime();
		return runtime.getProviders().some((provider) => runtime.getProviderAuthStatus(provider.id).configured);
	}

	private async run(flow: Flow, method: AuthMethod, emit: Emit): Promise<void> {
		const { signal } = flow.controller;
		signal.addEventListener("abort", () => {
			flow.pending?.reject(new Error("cancelled"));
			flow.pending = undefined;
		});
		const interaction: AuthInteraction = {
			signal,
			prompt: (request) =>
				new Promise<string>((resolvePrompt, rejectPrompt) => {
					if (signal.aborted) return rejectPrompt(new Error("cancelled"));
					flow.pending = { resolve: resolvePrompt, reject: rejectPrompt };
					const prompt: AuthPrompt = {
						flowId: flow.id,
						kind: request.type,
						message: presentText(request.message),
					};
					if (request.placeholder) prompt.placeholder = request.placeholder;
					if (request.options)
						prompt.options = request.options.map((o) => ({ ...o, label: presentText(o.label) }));
					emit({ type: "auth_prompt", prompt });
				}),
			notify: (event) => emit({ type: "auth_event", flowId: flow.id, event: toAuthEvent(event) }),
		};
		try {
			const runtime = await this.options.runtime();
			await runtime.login(flow.providerId, method, interaction);
			this.log(`signed in to ${flow.providerId} (${method})`);
			emit({ type: "auth_done", flowId: flow.id, providerId: flow.providerId, ok: true });
			this.flow = undefined;
			this.onCredentialsChanged();
		} catch (error) {
			const cancelled = signal.aborted;
			if (!cancelled)
				this.log(`sign-in to ${flow.providerId} failed: ${redact((error as Error).message, flow.answers)}`);
			emit({
				type: "auth_done",
				flowId: flow.id,
				providerId: flow.providerId,
				ok: false,
				message: cancelled ? "Sign-in cancelled." : "Sign-in did not finish. Please try again.",
			});
		} finally {
			if (this.flow === flow) this.flow = undefined;
		}
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

function toAuthEvent(event: EventRequest): AuthEvent {
	switch (event.type) {
		case "info": {
			const info: AuthEvent = { kind: "info", message: presentText(event.message) };
			if (event.links) info.links = event.links.map((l) => ({ ...l }));
			return info;
		}
		case "auth_url":
			return event.instructions
				? { kind: "auth_url", url: event.url, instructions: presentText(event.instructions) }
				: { kind: "auth_url", url: event.url };
		case "device_code": {
			const code: AuthEvent = {
				kind: "device_code",
				userCode: event.userCode,
				verificationUri: event.verificationUri,
			};
			if (event.expiresInSeconds) code.expiresInSeconds = event.expiresInSeconds;
			return code;
		}
		case "progress":
			return { kind: "progress", message: presentText(event.message) };
	}
}

function redact(text: string, secrets: string[]): string {
	let safe = text.slice(0, 300);
	for (const secret of secrets) if (secret.length >= 4) safe = safe.split(secret).join("[redacted]");
	return safe;
}

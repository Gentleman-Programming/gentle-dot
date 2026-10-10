/**
 * Sign-in in server mode (S25.8, B1). Pi's ModelRuntime reads the engine's `auth.json`,
 * `models.json`, and `settings.json`, runs a value that starts with `!` as a shell command, and
 * expands `$NAME` from its environment. Those files belong to the engine's user, so the root daemon
 * never runs ModelRuntime itself: it starts this helper as the engine's user (the same user, groups,
 * environment, and working folder as the engine, with no capabilities), and asks it over Node's IPC
 * channel. Whatever a planted value runs, it runs as the engine's user. Every answer is plain data:
 * provider names and statuses, an OpenAI key for voice, and the sign-in's prompts and events.
 *
 * Daemon -> helper: `{kind:"call", id, method, params}`, `{kind:"answer", promptId, value|error}`,
 * `{kind:"abort", id}`. Helper -> daemon: `{kind:"result", id, result|error}`,
 * `{kind:"prompt", id, promptId, request}`, `{kind:"notify", id, event}`.
 * The desktop keeps ModelRuntime in the daemon (`createModelAuthRuntime`), as before.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { AuthMethod } from "@gentle-dot/protocol";
import { type AuthInteraction, type AuthRuntime, createModelAuthRuntime } from "./auth.ts";
import type { OsUser } from "./vps.ts";

/** The helper's command line: the daemon's own entry point with `--auth-helper`. */
export interface AuthHelperCommand {
	command: string;
	args: string[];
}

export interface AuthHelperOptions extends AuthHelperCommand {
	user: OsUser;
	/** The engine's environment (already without the daemon's secrets). */
	env: NodeJS.ProcessEnv;
	/** The engine's home (`auth.json`, `models.json`, `settings.json`) and working folder. */
	agentHome: string;
	cwd: string;
	log?: (line: string) => void;
}

type Provider = ReturnType<AuthRuntime["getProviders"]>[number];
type Status = ReturnType<AuthRuntime["getProviderAuthStatus"]>;
type Snapshot = { providers: Provider[]; status: Record<string, Status> };

type FromHelper =
	| { kind: "result"; id: number; result?: unknown; error?: string }
	| { kind: "prompt"; id: number; promptId: number; request: Parameters<AuthInteraction["prompt"]>[0] }
	| { kind: "notify"; id: number; event: Parameters<AuthInteraction["notify"]>[0] };

type ToHelper =
	| { kind: "call"; id: number; method: string; params?: Record<string, unknown> }
	| { kind: "answer"; promptId: number; value?: string; error?: string }
	| { kind: "abort"; id: number };

const CALL_TIMEOUT_MS = 60_000;
const HOME_VAR = "GENTLE_DOT_AUTH_HOME";
const CWD_VAR = "GENTLE_DOT_AUTH_CWD";

const isString = (value: unknown): value is string => typeof value === "string";
const named = (value: unknown) =>
	typeof value === "object" && value !== null && isString((value as { name?: unknown }).name)
		? { name: (value as { name: string }).name }
		: undefined;

/** The helper's answer to `snapshot`, kept only where it has the expected shape. */
function parseSnapshot(value: unknown): Snapshot {
	const raw = (typeof value === "object" && value !== null ? value : {}) as {
		providers?: unknown;
		status?: unknown;
	};
	const providers: Provider[] = [];
	for (const item of Array.isArray(raw.providers) ? raw.providers : []) {
		const p = item as { id?: unknown; name?: unknown; auth?: { apiKey?: unknown; oauth?: unknown } };
		if (!isString(p.id) || !isString(p.name)) continue;
		const apiKey = named(p.auth?.apiKey);
		const oauth = named(p.auth?.oauth);
		providers.push({
			id: p.id,
			name: p.name,
			auth: { ...(apiKey ? { apiKey } : {}), ...(oauth ? { oauth } : {}) },
		});
	}
	const status: Record<string, Status> = {};
	const given = (typeof raw.status === "object" && raw.status !== null ? raw.status : {}) as Record<
		string,
		unknown
	>;
	for (const { id } of providers) {
		const s = given[id] as { configured?: unknown; source?: unknown } | undefined;
		status[id] = { configured: s?.configured === true, ...(isString(s?.source) ? { source: s.source } : {}) };
	}
	return { providers, status };
}

/** The daemon's side: one helper, started on first use and again after it exits. */
export class AuthHelper {
	private child: ChildProcess | undefined;
	private nextId = 0;
	private readonly calls = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: Error): void; interaction?: AuthInteraction }
	>();
	private readonly options: AuthHelperOptions;

	constructor(options: AuthHelperOptions) {
		this.options = options;
	}

	/** A runtime over a fresh snapshot, as `createModelAuthRuntime` gives a fresh runtime. */
	async runtime(): Promise<AuthRuntime> {
		const { providers, status } = parseSnapshot(await this.call("snapshot"));
		return {
			getProviders: () => providers,
			getProviderAuthStatus: (providerId) => status[providerId] ?? { configured: false },
			login: async (providerId: string, type: AuthMethod, interaction: AuthInteraction) => {
				await this.call("login", { providerId, type }, interaction);
			},
			logout: async (providerId) => {
				await this.call("logout", { providerId });
			},
			openAIApiKey: async () => {
				const result = (await this.call("openAIApiKey")) as { key?: unknown } | undefined;
				return isString(result?.key) && result.key !== "" ? result.key : undefined;
			},
		};
	}

	close(): void {
		const child = this.child;
		this.child = undefined;
		this.failAll(new Error("The sign-in helper stopped."));
		child?.kill("SIGTERM");
	}

	private call(
		method: string,
		params?: Record<string, unknown>,
		interaction?: AuthInteraction,
	): Promise<unknown> {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const done = (settle: () => void) => {
				clearTimeout(timer);
				this.calls.delete(id);
				settle();
			};
			this.calls.set(id, {
				resolve: (value) => done(() => resolve(value)),
				reject: (error) => done(() => reject(error)),
				...(interaction ? { interaction } : {}),
			});
			// A sign-in waits for the user; it ends when they answer or cancel.
			if (!interaction)
				timer = setTimeout(
					() => this.calls.get(id)?.reject(new Error(`The sign-in helper did not answer ${method} in time.`)),
					CALL_TIMEOUT_MS,
				);
			if (interaction?.signal) {
				const abort = () => this.send({ kind: "abort", id });
				if (interaction.signal.aborted) abort();
				else interaction.signal.addEventListener("abort", abort, { once: true });
			}
			this.send({ kind: "call", id, method, ...(params ? { params } : {}) });
		});
	}

	private send(message: ToHelper): void {
		try {
			const child = this.ensureChild();
			if (!child.connected) throw new Error("The sign-in helper is not running.");
			child.send(message);
		} catch (error) {
			if (message.kind === "call") this.calls.get(message.id)?.reject(error as Error);
		}
	}

	private ensureChild(): ChildProcess {
		if (this.child) return this.child;
		const { command, args, user, env, agentHome, cwd } = this.options;
		const child = spawn(command, args, {
			cwd,
			env: { ...env, [HOME_VAR]: agentHome, [CWD_VAR]: cwd },
			uid: user.uid,
			gid: user.gid,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			serialization: "json",
		});
		this.child = child;
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			for (const line of chunk.split("\n"))
				if (line.trim()) this.log(`[sign-in helper] ${line.slice(0, 300)}`);
		});
		child.on("message", (message) => this.receive(message as FromHelper));
		const gone = (why: string) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.log(`the sign-in helper stopped (${why})`);
			this.failAll(new Error("The sign-in helper stopped."));
		};
		child.on("error", (error) => gone(error.message));
		child.on("exit", (code, signal) => gone(signal ?? `code ${code}`));
		return child;
	}

	private receive(message: FromHelper): void {
		if (typeof message !== "object" || message === null || typeof message.id !== "number") return;
		const call = this.calls.get(message.id);
		if (!call) return;
		if (message.kind === "result") {
			if (isString(message.error)) call.reject(new Error(message.error));
			else call.resolve(message.result);
			return;
		}
		const interaction = call.interaction;
		if (!interaction) return;
		if (message.kind === "notify") {
			interaction.notify(message.event);
			return;
		}
		if (message.kind === "prompt" && typeof message.promptId === "number") {
			const { promptId } = message;
			interaction
				.prompt({ ...message.request, ...(interaction.signal ? { signal: interaction.signal } : {}) })
				.then(
					(value) => this.send({ kind: "answer", promptId, value }),
					(error: Error) => this.send({ kind: "answer", promptId, error: error.message }),
				);
		}
	}

	private failAll(error: Error): void {
		for (const call of [...this.calls.values()]) call.reject(error);
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}

/** The helper's side (`cli.ts --auth-helper`), as the engine's user: ModelRuntime on the engine's home. */
export function serveAuthHelper(): void {
	const agentHome = process.env[HOME_VAR];
	const cwd = process.env[CWD_VAR];
	if (!process.send || !agentHome || !cwd) {
		process.stderr.write("the sign-in helper runs only when the daemon starts it\n");
		process.exit(2);
	}
	const reply = (message: FromHelper) => process.send?.(message);
	const logins = new Map<number, AbortController>();
	const prompts = new Map<number, { resolve(value: string): void; reject(error: Error): void }>();
	let nextPrompt = 0;
	const run = async (id: number, method: string, params: Record<string, unknown>): Promise<unknown> => {
		const runtime = await createModelAuthRuntime(agentHome, cwd);
		switch (method) {
			case "snapshot": {
				const providers = runtime.getProviders().map((p) => ({ id: p.id, name: p.name, auth: p.auth }));
				const status = Object.fromEntries(providers.map((p) => [p.id, runtime.getProviderAuthStatus(p.id)]));
				return { providers, status };
			}
			case "openAIApiKey":
				return { key: (await runtime.openAIApiKey?.()) ?? null };
			case "logout":
				await runtime.logout(String(params.providerId));
				return {};
			case "login": {
				const controller = new AbortController();
				logins.set(id, controller);
				const interaction: AuthInteraction = {
					signal: controller.signal,
					prompt: (request) =>
						new Promise<string>((resolve, reject) => {
							if (controller.signal.aborted) return reject(new Error("cancelled"));
							const promptId = ++nextPrompt;
							prompts.set(promptId, { resolve, reject });
							controller.signal.addEventListener("abort", () => {
								prompts.delete(promptId);
								reject(new Error("cancelled"));
							});
							const { signal: _signal, ...plain } = request;
							reply({ kind: "prompt", id, promptId, request: plain });
						}),
					notify: (event) => reply({ kind: "notify", id, event }),
				};
				try {
					await runtime.login(String(params.providerId), params.type as AuthMethod, interaction);
				} finally {
					logins.delete(id);
				}
				return {};
			}
			default:
				throw new Error(`Unknown request: ${method}`);
		}
	};
	process.on("message", (raw) => {
		const message = raw as ToHelper;
		if (message.kind === "call") {
			run(message.id, message.method, message.params ?? {}).then(
				(result) => reply({ kind: "result", id: message.id, result }),
				(error: Error) => reply({ kind: "result", id: message.id, error: error.message }),
			);
		} else if (message.kind === "answer") {
			const prompt = prompts.get(message.promptId);
			prompts.delete(message.promptId);
			if (isString(message.value)) prompt?.resolve(message.value);
			else prompt?.reject(new Error(message.error ?? "cancelled"));
		} else if (message.kind === "abort") logins.get(message.id)?.abort();
	});
	// The daemon is gone: so is the helper.
	process.on("disconnect", () => process.exit(0));
}

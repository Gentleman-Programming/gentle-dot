import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentSpawnEnv } from "./config.ts";
import { encodeRecord, JsonlDecoder } from "./jsonl.ts";
import { writePrivateFile } from "./private-file.ts";
import { terminateProcessTree, WINDOWS_TASKKILL_TIMEOUT_MS } from "./process-tree.ts";
import { clearStaleSetupLock, writeSetupLockOwner } from "./setup-lock.ts";
import type { OsUser } from "./vps.ts";

/** A record the agent wrote to stdout that is not a command response. */
export type AgentRecord = { type: string; [key: string]: unknown };

export type RpcResponse = {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
};

export type SupervisorState = "stopped" | "starting" | "ready" | "restarting";

export type SupervisorEvent =
	| AgentRecord
	| { type: "supervisor_state"; state: SupervisorState }
	| { type: "interrupted" };

export interface SupervisorOptions {
	/** Executable to run, for example `gentle-shell`. */
	command: string;
	/** Arguments placed before the RPC arguments (used to run a script with node). */
	args?: string[];
	/** Arguments placed after the RPC arguments. */
	extraArgs?: string[];
	cwd: string;
	/** Directory for `sessions/` and `state.json` (the open session and the chains of rotated ones). */
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	/** The user the agent runs as (server mode, S25.8); by default the daemon's own. */
	user?: OsUser;
	/** Runs before every spawn (first start, restart, respawn); returns variables added to `env`. */
	prepareSpawn?: () => NodeJS.ProcessEnv;
	/** Respawn delays; the last value repeats. Default 1s, 2s, 4s, 8s, 16s, 30s. */
	backoffMs?: number[];
	/** Uptime after which the backoff starts over. Default 30s. */
	stableMs?: number;
	/** Deadline for one command response. Default 5 minutes. */
	requestTimeoutMs?: number;
	/** Deadline for the agent to answer its first `get_state`. Default 60s. */
	startTimeoutMs?: number;
	/** Grace period after closing stdin before the first process-tree escalation. Default 5s. */
	stopTimeoutMs?: number;
	/** Lifecycle platform override; tests pair this with a termination override. */
	platform?: NodeJS.Platform;
	/** Time between soft and forced escalation. Default 12s on Windows, 2s on Unix. */
	hardStopTimeoutMs?: number;
	/** Time after forced escalation before shutdown rejects. Default 12s on Windows, 2s on Unix. */
	terminationFailureTimeoutMs?: number;
	/** Process-tree termination override, primarily for deterministic lifecycle tests. */
	terminateProcessTree?: typeof terminateProcessTree;
	log?: (line: string) => void;
}

type Pending = {
	resolve: (response: RpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

const DEFAULT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/**
 * The engine home the daemon passed as `--home`, if any. The daemon owns that home and marks it
 * (`claimEngineHome`), so its engine lock is ours to mend; without `--home` the engine manages a
 * home of its own that we never touch.
 */
function engineHomeArgument(args: string[]): string | undefined {
	for (let at = args.length - 1; at >= 0; at -= 1) {
		const arg = args[at];
		if (arg === "--home") {
			const value = args[at + 1];
			return value && !value.startsWith("--") ? value : undefined;
		}
		if (arg?.startsWith("--home=")) return arg.slice("--home=".length) || undefined;
	}
	return undefined;
}

/**
 * Runs the agent (`gentle-shell --mode rpc`) as a child process, correlates
 * commands with responses, forwards session events, and respawns the agent
 * after an unexpected exit, reopening the same conversation.
 */
export class AgentSupervisor {
	state: SupervisorState = "stopped";
	busy = false;
	sessionFile: string | undefined;
	sessionId: string | undefined;
	model: string | undefined;
	/** Whether the current model accepts images (its `input` lists `image`); undefined when not reported. */
	modelImages: boolean | undefined;

	private child: ChildProcess | undefined;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(event: SupervisorEvent) => void>();
	private nextId = 0;
	/** Count of `agent_settled` records seen, to order them against prompt responses. */
	private settledRuns = 0;
	private attempts = 0;
	private spawnedAt = 0;
	private stopping = false;
	private restarting = false;
	private interrupted = false;
	private restartTimer: NodeJS.Timeout | undefined;
	/** The spawn whose engine has not answered yet, while there is one. */
	private initializing: Promise<void> | undefined;
	/** A restart asked while an engine starts, run once that start settles. */
	private queuedRestart: Promise<void> | undefined;
	/** A restart closing the old process; the engine it starts next comes after any request made meanwhile. */
	private replacing: Promise<void> | undefined;
	private wasLaunched = false;
	private closeWaiters: (() => void)[] = [];
	/** For a session started by rotation, the session files it continues, oldest first. */
	private chains: Record<string, string[]> = {};
	private readonly sessionDir: string;
	private readonly stateFile: string;
	private readonly options: SupervisorOptions;

	constructor(options: SupervisorOptions) {
		this.options = options;
		this.sessionDir = join(options.dataDir, "sessions");
		this.stateFile = join(options.dataDir, "state.json");
		this.sessionFile = this.readPersistedSession();
	}

	/** Whether `start()` or `stop()` was called: before that, `stopped` only means not started yet. */
	get launched(): boolean {
		return this.wasLaunched;
	}

	get pid(): number | undefined {
		return this.child?.pid;
	}

	/** The earlier session files of the open chat, oldest first. */
	get previousSessions(): string[] {
		return (this.sessionFile && this.chains[this.sessionFile]) || [];
	}

	/** Records that `sessionFile` continues the chat held in `previous` (oldest first). */
	linkSessions(sessionFile: string, previous: string[]): void {
		this.chains[sessionFile] = previous;
		if (this.sessionFile) this.persistSession(this.sessionFile);
	}

	onEvent(listener: (event: SupervisorEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Spawns the agent and resolves once it answered `get_state`. */
	async start(): Promise<void> {
		this.stopping = false;
		this.wasLaunched = true;
		mkdirSync(this.sessionDir, { recursive: true });
		this.setState("starting");
		await this.initialize();
	}

	/** Sends a command and resolves with its successful response. */
	async request(command: AgentRecord): Promise<RpcResponse> {
		if (this.state !== "ready") throw new Error("Agent is not ready");
		const settledBefore = this.settledRuns;
		const response = await this.rawRequest(command, this.options.requestTimeoutMs ?? 300_000);
		// The run may already have settled before this response was handled.
		if (
			command.type === "prompt" &&
			(response.data as { disposition?: string } | undefined)?.disposition === "started" &&
			this.settledRuns === settledBefore
		) {
			this.busy = true;
		}
		if (command.type === "new_session" || command.type === "switch_session") await this.refreshSession();
		// A switch answers with the new model.
		if (command.type === "set_model") this.applyModel(response.data);
		if (command.type === "cycle_model") this.applyModel((response.data as { model?: unknown } | null)?.model);
		return response;
	}

	/** Writes a record that has no response, such as `extension_ui_response`. */
	send(record: AgentRecord): void {
		if (this.state !== "ready" || !this.child?.stdin?.writable) throw new Error("Agent is not ready");
		this.child.stdin.write(encodeRecord(record));
	}

	/**
	 * Replaces the agent process on purpose (for example after new credentials),
	 * reopening the same conversation. Not reported as an interruption.
	 * An engine still starting is not cut off: it is replaced once that start settles,
	 * once for any number of requests made meanwhile.
	 */
	restart(): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (this.initializing) {
			this.queuedRestart ??= this.initializing
				.catch(() => {})
				.then(() => {
					this.queuedRestart = undefined;
					return this.restart();
				});
			return this.queuedRestart;
		}
		if (this.replacing) return this.replacing;
		const replacing = this.replace().finally(() => {
			if (this.replacing === replacing) this.replacing = undefined;
		});
		this.replacing = replacing;
		return replacing;
	}

	private async replace(): Promise<void> {
		const child = this.child;
		if (!child || this.stopping) return;
		this.restarting = true;
		try {
			await this.closeChild(child);
		} catch (error) {
			// The old process is still running: never spawn a second engine over it. Its stdin is
			// closed, so it is not ready any more; its close schedules the replacement.
			this.restarting = false;
			if (this.child === child) this.setState("restarting");
			throw error;
		}
		// Stopped while the old process was closing: nothing is started again.
		if (this.stopping) {
			this.setState("stopped");
			return;
		}
		this.setState("restarting");
		this.replacing = undefined;
		await this.initialize();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.wasLaunched = true;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		const child = this.child;
		if (!child) {
			this.setState("stopped");
			return;
		}
		await this.closeChild(child);
	}

	/**
	 * Closes stdin, then escalates through the process tree: soft after the grace period, forced
	 * after the hard window. Rejects when the child is still the current one after the failure
	 * window, instead of waiting for a process that did not terminate.
	 */
	private closeChild(child: ChildProcess): Promise<void> {
		const gracefulMs = this.options.stopTimeoutMs ?? 5000;
		const platform = this.options.platform ?? process.platform;
		// Leave two seconds for the child's close event after taskkill's own deadline.
		const stageMs = platform === "win32" ? WINDOWS_TASKKILL_TIMEOUT_MS + 2000 : 2000;
		const hardMs = this.options.hardStopTimeoutMs ?? stageMs;
		const failureMs = this.options.terminationFailureTimeoutMs ?? stageMs;
		const terminate = this.options.terminateProcessTree ?? terminateProcessTree;
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const errors: string[] = [];
			const timers: NodeJS.Timeout[] = [];
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				for (const timer of timers) clearTimeout(timer);
				const index = this.closeWaiters.indexOf(onClose);
				if (index >= 0) this.closeWaiters.splice(index, 1);
				if (error) reject(error);
				else resolve();
			};
			const onClose = () => finish();
			let forced = false;
			// A root that already exited may still be current until its children release the pipes,
			// but its PID is free then and may be reused: never escalate on it.
			const running = () => this.child === child && child.exitCode === null && child.signalCode === null;
			const escalate = (force: boolean) => {
				if (!running() || (force && forced)) return;
				if (force) forced = true;
				void terminate(child, force, { platform, isCurrent: running }).catch((error: Error) => {
					errors.push(error.message);
					this.log(error.message);
					// taskkill /T without /F cannot end a windowless console process and fails at once:
					// force the tree now instead of waiting out the hard window.
					if (!force && platform === "win32") escalate(true);
				});
			};
			this.closeWaiters.push(onClose);
			child.stdin?.end();
			timers.push(setTimeout(() => escalate(false), gracefulMs));
			timers.push(setTimeout(() => escalate(true), gracefulMs + hardMs));
			timers.push(
				setTimeout(
					() => {
						if (this.child !== child) return finish();
						const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
						finish(
							new Error(
								`Failed to stop agent process ${child.pid ?? "without a PID"} after bounded termination${detail}`,
							),
						);
					},
					gracefulMs + hardMs + failureMs,
				),
			);
		});
	}

	private initialize(): Promise<void> {
		const run = this.spawnAndInitialize().finally(() => {
			if (this.initializing === run) this.initializing = undefined;
		});
		this.initializing = run;
		return run;
	}

	private async spawnAndInitialize(): Promise<void> {
		const wanted = this.sessionFile;
		const child = this.spawnChild();
		try {
			const state = await this.rawRequest({ type: "get_state" }, this.options.startTimeoutMs ?? 60_000);
			const current = (state.data as { sessionFile?: string } | undefined)?.sessionFile;
			if (wanted && wanted !== current && existsSync(wanted)) {
				await this.rawRequest({ type: "switch_session", sessionPath: wanted }, 30_000);
			}
			await this.refreshSession();
		} catch (error) {
			if (this.child === child) child.kill("SIGKILL");
			throw error;
		}
		if (this.child !== child) throw new Error("Agent exited during startup");
		this.spawnedAt = Date.now();
		this.setState("ready");
		if (this.interrupted) {
			this.interrupted = false;
			this.emit({ type: "interrupted" });
		}
	}

	private spawnChild(): ChildProcess {
		const { command, args = [], extraArgs = [], cwd, env, prepareSpawn, user } = this.options;
		const engineHome = engineHomeArgument(args);
		// An abrupt stop leaves the engine's empty setup lock behind (it releases it only in a
		// `finally`), so clear an abandoned one first. The decision never touches a lock our own
		// owner record proves is live.
		if (engineHome) clearStaleSetupLock(engineHome);
		const child = spawn(command, [...args, "--mode", "rpc", "--session-dir", this.sessionDir, ...extraArgs], {
			cwd,
			env: agentSpawnEnv(
				command,
				args,
				{ ...(env ?? process.env), ...prepareSpawn?.() },
				this.options.platform,
			),
			stdio: ["pipe", "pipe", "pipe"],
			...(user ? { uid: user.uid, gid: user.gid } : {}),
		});
		this.child = child;
		// Recorded only once the child exists (a failed spawn has no pid): this is the proof a later
		// start uses to tell an abandoned lock from one a live engine still holds.
		if (engineHome && child.pid !== undefined) writeSetupLockOwner(engineHome, child.pid);
		const decoder = new JsonlDecoder(
			(record) => this.handleRecord(record as AgentRecord),
			(line) => this.log(`agent wrote a malformed record: ${line.slice(0, 200)}`),
		);
		child.stdout?.on("data", (chunk: Buffer) => decoder.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => this.log(chunk.toString("utf8").trimEnd()));
		child.stdin?.on("error", () => {});
		child.on("error", (error) => this.log(`agent process error: ${error.message}`));
		child.on("close", (code, signal) => this.handleClose(child, code, signal));
		return child;
	}

	private rawRequest(command: AgentRecord, timeoutMs: number): Promise<RpcResponse> {
		const child = this.child;
		if (!child?.stdin?.writable) return Promise.reject(new Error("Agent is not ready"));
		const id = `d${++this.nextId}`;
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Agent did not answer ${command.type} within ${timeoutMs} ms`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			child.stdin?.write(encodeRecord({ ...command, id }));
		});
	}

	private handleRecord(record: AgentRecord): void {
		if (record.type === "response") {
			const response = record as unknown as RpcResponse;
			const pending = response.id === undefined ? undefined : this.pending.get(response.id);
			if (!pending || response.id === undefined) return;
			this.pending.delete(response.id);
			clearTimeout(pending.timer);
			if (response.success) pending.resolve(response);
			else pending.reject(new Error(response.error ?? `${response.command} failed`));
			return;
		}
		if (record.type === "agent_start") this.busy = true;
		if (record.type === "agent_settled") {
			this.settledRuns += 1;
			this.busy = false;
			void this.refreshSession().catch(() => {});
		}
		this.emit(record);
	}

	private handleClose(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
		if (child !== this.child) return;
		this.child = undefined;
		const reason = new Error(`Agent exited (${signal ?? `code ${code}`})`);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			pending.reject(reason);
			this.pending.delete(id);
		}
		const wasBusy = this.busy;
		this.busy = false;
		if (this.restarting) {
			this.restarting = false;
			for (const resolve of this.closeWaiters.splice(0)) resolve();
			return;
		}
		for (const resolve of this.closeWaiters.splice(0)) resolve();
		if (this.stopping) {
			this.setState("stopped");
			return;
		}
		this.log(`agent exited unexpectedly (${signal ?? `code ${code}`})`);
		if (wasBusy) this.interrupted = true;
		// The dead run's length, measured now, decides whether the next failures start the backoff
		// over; the old check ran inside scheduleRestart against a spawnedAt the failed runs never
		// updated, so a persistent startup crash reset the attempts on every call and retried at
		// the first delay forever.
		if (this.spawnedAt && Date.now() - this.spawnedAt > (this.options.stableMs ?? 30_000)) this.attempts = 0;
		this.spawnedAt = 0;
		this.scheduleRestart();
	}

	private scheduleRestart(): void {
		// One pending respawn at most. A death during startup reaches this from handleClose and
		// again from the spawn's catch; stacking the timers doubled the attempts every generation
		// (measured on Windows: one crash became ~416k respawn attempts in five hours).
		if (this.restartTimer) return;
		const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
		const delay = backoff[Math.min(this.attempts, backoff.length - 1)] ?? 1000;
		this.attempts += 1;
		this.setState("restarting");
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (this.stopping) return;
			this.initialize().catch((error: Error) => {
				this.log(`agent restart failed: ${error.message}`);
				// A child that is still alive will close and schedule the next attempt.
				if (!this.child && !this.stopping) this.scheduleRestart();
			});
		}, delay);
	}

	private async refreshSession(): Promise<void> {
		const response = await this.rawRequest({ type: "get_state" }, 30_000);
		this.applyState(response.data);
	}

	private applyState(data: unknown): void {
		const state = (data ?? {}) as {
			sessionFile?: string;
			sessionId?: string;
			model?: unknown;
		};
		if (state.model) this.applyModel(state.model);
		if (state.sessionId) this.sessionId = state.sessionId;
		if (state.sessionFile && state.sessionFile !== this.sessionFile) {
			this.sessionFile = state.sessionFile;
		}
		if (this.sessionFile) this.persistSession(this.sessionFile);
	}

	private applyModel(data: unknown): void {
		if (typeof data !== "object" || data === null) return;
		const model = data as { name?: string; id?: string; input?: unknown };
		this.model = model.name ?? model.id;
		this.modelImages = Array.isArray(model.input) ? model.input.includes("image") : undefined;
	}

	private readPersistedSession(): string | undefined {
		try {
			const saved = JSON.parse(readFileSync(this.stateFile, "utf8")) as {
				sessionFile?: string;
				chains?: unknown;
			};
			if (typeof saved.chains === "object" && saved.chains !== null) {
				for (const [file, previous] of Object.entries(saved.chains)) {
					if (Array.isArray(previous) && previous.every((p) => typeof p === "string"))
						this.chains[file] = previous;
				}
			}
			return typeof saved.sessionFile === "string" ? saved.sessionFile : undefined;
		} catch {
			return undefined;
		}
	}

	private persistSession(sessionFile: string): void {
		mkdirSync(this.options.dataDir, { recursive: true });
		writePrivateFile(this.stateFile, `${JSON.stringify({ sessionFile, chains: this.chains })}\n`);
	}

	private setState(state: SupervisorState): void {
		if (this.state === state) return;
		this.state = state;
		this.emit({ type: "supervisor_state", state });
	}

	private emit(event: SupervisorEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private log(line: string): void {
		if (line) this.options.log?.(line);
	}
}

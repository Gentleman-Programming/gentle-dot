/** A record the agent wrote to stdout that is not a command response. */
export type AgentRecord = {
	type: string;
	[key: string]: unknown;
};
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
	| {
			type: "supervisor_state";
			state: SupervisorState;
	  }
	| {
			type: "interrupted";
	  };
export interface SupervisorOptions {
	/** Executable to run, for example `gentle-shell`. */
	command: string;
	/** Arguments placed before the RPC arguments (used to run a script with node). */
	args?: string[];
	/** Arguments placed after the RPC arguments. */
	extraArgs?: string[];
	cwd: string;
	/** Directory for `sessions/` and `state.json`. */
	dataDir: string;
	env?: NodeJS.ProcessEnv;
	/** Respawn delays; the last value repeats. Default 1s, 2s, 4s, 8s, 16s, 30s. */
	backoffMs?: number[];
	/** Uptime after which the backoff starts over. Default 30s. */
	stableMs?: number;
	/** Deadline for one command response. Default 5 minutes. */
	requestTimeoutMs?: number;
	/** Deadline for the agent to answer its first `get_state`. Default 60s. */
	startTimeoutMs?: number;
	/** Grace period after closing stdin before SIGTERM. Default 5s. */
	stopTimeoutMs?: number;
	log?: (line: string) => void;
}
/**
 * Runs the agent (`gentle-shell --mode rpc`) as a child process, correlates
 * commands with responses, forwards session events, and respawns the agent
 * after an unexpected exit, reopening the same conversation.
 */
export declare class AgentSupervisor {
	state: SupervisorState;
	busy: boolean;
	sessionFile: string | undefined;
	sessionId: string | undefined;
	model: string | undefined;
	private child;
	private readonly pending;
	private readonly listeners;
	private nextId;
	private attempts;
	private spawnedAt;
	private stopping;
	private interrupted;
	private restartTimer;
	private closeWaiters;
	private readonly sessionDir;
	private readonly stateFile;
	private readonly options;
	constructor(options: SupervisorOptions);
	get pid(): number | undefined;
	onEvent(listener: (event: SupervisorEvent) => void): () => void;
	/** Spawns the agent and resolves once it answered `get_state`. */
	start(): Promise<void>;
	/** Sends a command and resolves with its successful response. */
	request(command: AgentRecord): Promise<RpcResponse>;
	/** Writes a record that has no response, such as `extension_ui_response`. */
	send(record: AgentRecord): void;
	stop(): Promise<void>;
	private spawnAndInitialize;
	private spawnChild;
	private rawRequest;
	private handleRecord;
	private handleClose;
	private scheduleRestart;
	private refreshSession;
	private applyState;
	private readPersistedSession;
	private persistSession;
	private setState;
	private emit;
	private log;
}

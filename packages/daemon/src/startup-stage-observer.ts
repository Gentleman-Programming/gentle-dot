import { createRequire } from "node:module";

export type StartupStage = 1 | 2 | 3 | 4;
// Stage 4 alone can use a reason code in place of the failure marker. Every frame is still 35 bytes.
const MEMORY_FAILURE_CODES = {
	"config-reread": "A",
	"preview-prerequisites": "B",
	"invalid-port": "C",
	"query-spawn": "D",
	"query-timeout": "E",
	"query-nonzero": "F",
	"query-stderr": "G",
	"query-parse": "H",
	"multiple-listeners": "I",
	"identity-missing": "J",
	"identity-mismatch": "K",
	"recheck-changed": "L",
	"recheck-unverified": "M",
} as const;
export type PrivateMemoryFailure = keyof typeof MEMORY_FAILURE_CODES;
export type StartupStageObserver = (stage: StartupStage, completed: boolean, reason?: PrivateMemoryFailure) => void;

export function startupStageMarker(stage: StartupStage, completed: boolean, reason?: PrivateMemoryFailure): string {
	if (completed) return "+";
	return stage === 4 && typeof reason === "string" && Object.hasOwn(MEMORY_FAILURE_CODES, reason)
		? MEMORY_FAILURE_CODES[reason] : "-";
}
const PORT = 43194;
const PORT_KEY = "GENTLE_DOT_CI_DAEMON_PHASE_PORT";
const ID_KEY = "GENTLE_DOT_CI_DAEMON_PHASE_ID";

export function consumeStartupStageEndpoint(env: NodeJS.ProcessEnv): string | undefined {
	const port = env[PORT_KEY];
	const id = env[ID_KEY];
	delete env[PORT_KEY];
	delete env[ID_KEY];
	return port === String(PORT) && id?.length === 32 && /^[a-f0-9]{32}$/.test(id) ? id : undefined;
}

/** No references that keep Node alive, no retries, and no transport result can change startup. */
export function openStartupStageObserver(): StartupStageObserver | undefined {
	if (process.platform !== "win32" || process.arch !== "x64") return undefined;
	const id = consumeStartupStageEndpoint(process.env);
	if (!id || !process.env.GENTLE_DOT_RUNTIME || process.env.GENTLE_DOT_ENGRAM !== "private" ||
		process.env.GENTLE_DOT_PREVIEW_MEMORY_ADMISSION !== "1") return undefined;
	try {
		const { createSocket } = createRequire(import.meta.url)("node:dgram") as typeof import("node:dgram");
		const socket = createSocket("udp4");
		let next = 1;
		const stop = () => {
			next = 5;
			try { socket.close(); } catch { /* best effort */ }
		};
		socket.on("error", stop);
		socket.unref();
		// Bind only to loopback. The send queue is bounded by the four ordered checkpoints.
		socket.bind(0, "127.0.0.1", () => socket.unref());
		return (stage, completed, reason) => {
			if (stage !== next) return;
			const terminal = !completed || stage === 4;
			next = terminal ? 5 : next + 1;
			try {
				socket.send(`${id} ${stage}${startupStageMarker(stage, completed, reason)}`, PORT, "127.0.0.1", (error) => {
					if (error || terminal) stop();
				});
			} catch { stop(); }
		};
	} catch { return undefined; }
}

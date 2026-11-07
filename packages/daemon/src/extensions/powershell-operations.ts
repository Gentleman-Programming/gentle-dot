import { spawn } from "node:child_process";
import { constants } from "node:os";
import { win32 } from "node:path";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";

// Matches the pinned SDK's output encoding setup, not a translation of the user's command.
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
const MAX_TIMEOUT_MS = 2_147_483_647;

type Dependencies = {
	spawn: typeof spawn;
	systemRoot: string;
	setTimeout: typeof setTimeout;
	clearTimeout: typeof clearTimeout;
};

/** Native Windows operations. No PATH lookup, shell wrapper, policy switch or environment rewriting. */
export function createPowerShellOperations(overrides: Partial<Dependencies> = {}): PowerShellOperations {
	const deps: Dependencies = {
		spawn,
		systemRoot: process.env.SystemRoot ?? "C:\\Windows",
		setTimeout,
		clearTimeout,
		...overrides,
	};
	const system = win32.join(deps.systemRoot, "System32");
	const executable = win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
	return {
		exec(
			command: string,
			cwd: string,
			{
				onData,
				signal,
				timeout,
				env,
			}: {
				onData: (data: Buffer) => void;
				signal?: AbortSignal;
				timeout?: number;
				env?: NodeJS.ProcessEnv;
			},
		) {
			if (signal?.aborted) return Promise.reject(new Error("aborted"));
			const timeoutMs = timeout === undefined ? undefined : timeout * 1000;
			if (
				timeoutMs !== undefined &&
				(!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)
			)
				return Promise.reject(
					new Error("Invalid timeout: must be positive finite seconds within the timer limit"),
				);
			return new Promise((resolve, reject) => {
				const child = deps.spawn(
					executable,
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(UTF8_OUTPUT_PREFIX + command, "utf16le").toString("base64"),
					],
					{
						cwd,
						env,
						shell: false,
						windowsHide: true,
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let settled = false;
				let exited = false;
				let stopping: Error | undefined;
				let timer: ReturnType<typeof setTimeout> | undefined;
				let drainTimer: ReturnType<typeof setTimeout> | undefined;
				let cleanupTerminator: (() => void) | undefined;
				const clearTimers = () => {
					if (timer !== undefined) deps.clearTimeout(timer);
					if (drainTimer !== undefined) deps.clearTimeout(drainTimer);
				};
				const finish = (error?: Error, code: number | null = null) => {
					if (settled) return;
					settled = true;
					clearTimers();
					cleanupTerminator?.();
					signal?.removeEventListener("abort", onAbort);
					child.removeListener("error", onError);
					child.removeListener("exit", onExit);
					child.removeListener("close", onClose);
					child.stdout?.removeListener("data", onOutput);
					child.stderr?.removeListener("data", onOutput);
					// Descendants can hold inherited pipes open after the owned shell exits.
					child.stdout?.destroy();
					child.stderr?.destroy();
					if (error) reject(error);
					else resolve({ exitCode: code });
				};
				const stop = (error: Error) => {
					if (settled || stopping) return;
					stopping = error;
					clearTimers();
					signal?.removeEventListener("abort", onAbort);
					// Never target a PID after observing its exit, or a name/image/all-process selector.
					if (exited) {
						finish(error);
						return;
					}
					// A failed spawn has no PID and reports error asynchronously; retain its listener.
					if (!child.pid) return;
					const terminationFailure = new Error(
						`${error.message}; could not terminate the PowerShell process tree`,
					);
					const failed = () => {
						if (settled) return;
						// Publish failure BEFORE kill: a synchronous error can reenter onError/finish.
						stopping = terminationFailure;
						try {
							if (!exited) child.kill();
						} catch {
							/* Failure is already authoritative. */
						}
						finish(terminationFailure);
					};
					try {
						const killer = deps.spawn(
							win32.join(system, "taskkill.exe"),
							["/PID", String(child.pid), "/T", "/F"],
							{
								env,
								shell: false,
								windowsHide: true,
								stdio: "ignore",
							},
						);
						let killTimer: ReturnType<typeof setTimeout>;
						let killRequested = false;
						let killerClosed = false;
						const onClosed = () => {
							killerClosed = true;
							killer.removeListener("error", failed);
						};
						cleanupTerminator = () => {
							deps.clearTimeout(killTimer);
							killer.removeListener("exit", onKilled);
							// kill() can report errors after returning. Drain until this helper closes.
							if (!killRequested || killerClosed) {
								killer.removeListener("error", failed);
								killer.removeListener("close", onClosed);
							}
						};
						const onKilled = (code: number | null) => (code === 0 ? finish(stopping) : failed());
						killer.on("error", failed);
						killer.once("exit", onKilled);
						killer.once("close", onClosed);
						killTimer = deps.setTimeout(() => {
							stopping = terminationFailure;
							killRequested = true;
							try {
								killer.kill();
							} catch {
								/* The bounded termination failed. */
							}
							failed();
						}, 1000);
					} catch {
						failed();
					}
				};
				const onAbort = () => stop(new Error("aborted"));
				const onError = (error: Error) => finish(stopping ?? error);
				const onOutput = (data: Buffer) => {
					if (!settled) {
						try {
							onData(data);
						} catch (error) {
							stop(error instanceof Error ? error : new Error(String(error)));
						}
					}
				};
				const exitCode = (code: number | null, signalName: NodeJS.Signals | null) =>
					code ?? (signalName ? 128 + (constants.signals[signalName] ?? 0) : null);
				const onExit = (code: number | null, signalName: NodeJS.Signals | null) => {
					exited = true;
					// Prefer close (all output drained), but do not hang on a descendant's inherited pipe.
					if (!stopping)
						drainTimer = deps.setTimeout(() => finish(undefined, exitCode(code, signalName)), 250);
				};
				const onClose = (code: number | null, signalName: NodeJS.Signals | null) => {
					exited = true;
					if (!stopping || !child.pid) finish(stopping, exitCode(code, signalName));
				};
				child.stdout?.on("data", onOutput);
				child.stderr?.on("data", onOutput);
				child.once("error", onError);
				child.once("exit", onExit);
				child.once("close", onClose);
				if (timeoutMs !== undefined)
					timer = deps.setTimeout(() => stop(new Error(`timeout:${timeout}`)), timeoutMs);
				signal?.addEventListener("abort", onAbort, { once: true });
				if (signal?.aborted) onAbort();
			});
		},
	};
}

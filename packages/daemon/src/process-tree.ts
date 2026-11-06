import { type ChildProcess, spawn } from "node:child_process";

/** Windows tree enumeration can take several seconds even for a small console process. */
export const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;

export interface ProcessTreeTerminationOptions {
	platform?: NodeJS.Platform;
	/** Confirms immediately before escalation that this is still the supervisor-owned child. */
	isCurrent?: () => boolean;
	/** Maximum time allowed for taskkill itself. */
	commandTimeoutMs?: number;
	/** Test seam for the taskkill process only. */
	spawnTaskkill?: (
		command: string,
		args: readonly string[],
		options: { windowsHide: boolean; stdio: "ignore" },
	) => ChildProcess;
}

/**
 * Escalates termination for one supervisor-owned child.
 *
 * Windows taskkill is necessarily PID-based. The ownership check narrows, but cannot
 * eliminate, the race where Windows reuses a PID between the check and taskkill.
 */
export function terminateProcessTree(
	child: ChildProcess,
	force: boolean,
	options: ProcessTreeTerminationOptions = {},
): Promise<boolean> {
	if (options.isCurrent && !options.isCurrent()) return Promise.resolve(false);
	if ((options.platform ?? process.platform) !== "win32") {
		return Promise.resolve(child.kill(force ? "SIGKILL" : "SIGTERM"));
	}

	const pid = child.pid;
	if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 0) {
		return Promise.reject(
			new Error("Cannot terminate Windows process tree without a strictly positive process id"),
		);
	}
	// Recheck after validation so a stale asynchronous escalation never reaches taskkill.
	if (options.isCurrent && !options.isCurrent()) return Promise.resolve(false);

	const args = ["/PID", String(pid), ...(force ? ["/F"] : []), "/T"];
	const spawnTaskkill = options.spawnTaskkill ?? spawn;
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		const taskkill = spawnTaskkill("taskkill.exe", args, { windowsHide: true, stdio: "ignore" });
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(true);
		};
		const timer = setTimeout(() => {
			taskkill.kill();
			finish(new Error(`taskkill timed out while terminating process tree ${pid}`));
		}, options.commandTimeoutMs ?? WINDOWS_TASKKILL_TIMEOUT_MS);
		taskkill.once("error", (error) =>
			finish(new Error(`taskkill failed for process tree ${pid}: ${error.message}`)),
		);
		taskkill.once("close", (code) => {
			if (code === 0) finish();
			else finish(new Error(`taskkill failed for process tree ${pid} with exit code ${code}`));
		});
	});
}

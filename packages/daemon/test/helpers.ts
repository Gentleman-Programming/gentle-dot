import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSupervisor, type SupervisorEvent, type SupervisorOptions } from "../src/supervisor.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "gentle-dot-test-"));
}

export function fakeSupervisor(overrides: Partial<SupervisorOptions> = {}) {
	const dataDir = overrides.dataDir ?? tempDir();
	const supervisor = new AgentSupervisor({
		command: process.execPath,
		args: [FAKE_AGENT],
		cwd: dataDir,
		dataDir,
		backoffMs: [50, 100, 200],
		...overrides,
	});
	const events: SupervisorEvent[] = [];
	supervisor.onEvent((event) => events.push(event));
	return { supervisor, events, dataDir };
}

export async function waitFor<T>(probe: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
	const started = Date.now();
	for (;;) {
		const value = probe();
		if (value) return value;
		if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Whether the process is still there; a child the supervisor waited out is gone, not a zombie. */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * The promise's value, or `undefined` when it is still going after `ms`: a test that would hang on
 * behaviour which never settles fails on the value instead of on the runner's timeout.
 */
export async function settled<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

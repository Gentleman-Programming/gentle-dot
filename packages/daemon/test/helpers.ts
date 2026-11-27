import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDir } from "../src/isolation.ts";
import { AgentSupervisor, type SupervisorEvent, type SupervisorOptions } from "../src/supervisor.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-agent.ts", import.meta.url));

export function tempDir(): string {
	if (process.platform === "win32") {
		const directory = join(tmpdir(), `gentle-dot-test-${randomUUID()}`);
		ensurePrivateDir(directory);
		return directory;
	}
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

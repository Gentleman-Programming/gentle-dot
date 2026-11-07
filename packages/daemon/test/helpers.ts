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

/** Test-only Node entrypoint; --import also covers native ESM named builtin imports. */
export function fixtureNodeArgs(entrypoint: string, ...args: string[]): string[] {
	return [
		"--import",
		fileURLToPath(new URL("./fixtures/account-home-preload.mjs", import.meta.url)),
		entrypoint,
		...args,
	];
}

/** Keep OS account metadata separate from a deliberately seeded HOME (privacy probes). */
export function fixtureNodeEnv(env: NodeJS.ProcessEnv, home = tempDir()): NodeJS.ProcessEnv {
	const accountRoot = tempDir();
	ensurePrivateDir(join(accountRoot, `uid-${process.geteuid?.() ?? "windows"}`));
	return {
		...env,
		HOME: home,
		USERPROFILE: home,
		GENTLE_DOT_TEST_ACCOUNT_HOME: accountRoot,
	};
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

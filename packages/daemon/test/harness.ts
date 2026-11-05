/**
 * The shared harness for daemon tests.
 *
 * The refactor replaced `startDaemon({ agentCommand, agentArgs, agentHome, agentEnv, uiDir })`
 * with `createDaemon({ configPath, port, host, dataDir, workspace, engineCommand })`, so the 24
 * gateway test files that still call the old entry point cannot boot anything. This module owns
 * the mapping once, so each file only has to swap its setup for `bootDaemon()`.
 *
 * Three details are easy to get wrong:
 *
 * 1. `AppChannel` resolves its socket path from `process.env.HOME` when the module loads, so
 *    HOME must point at the harness home *before* `daemon.ts` is imported. That is why the
 *    import below is dynamic and the home is set at module load.
 * 2. The config loader resolves its default path against the process cwd and the daemon needs
 *    the real connector blocks (a stub fails with "Missing daemon configuration"). Tests reuse
 *    the repo's `connectors.yaml`.
 * 3. `Daemon.stop()` is the teardown call; `close()` no longer exists, and stop() no longer
 *    exits the process.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_AGENT } from "./helpers.ts";

/** One HOME per test process, set before the daemon module (and AppChannel) is imported. */
export const HARNESS_HOME =
	process.env["GENTLE_DOT_TEST_HOME"] ?? mkdtempSync(join(tmpdir(), "gentle-dot-test-"));
process.env["HOME"] = HARNESS_HOME;
mkdirSync(join(HARNESS_HOME, ".gentle-dot"), { recursive: true });

/** The app-channel socket for this HOME (see AppChannel.DEFAULT_SOCKET_PATH). */
export const APP_SOCKET_PATH = join(HARNESS_HOME, ".gentle-dot", "app-channel.sock");

/** The repo's connector config: the daemon expects real blocks, not an empty stub. */
export const CONNECTORS_CONFIG_PATH = fileURLToPath(new URL("../connectors.yaml", import.meta.url));

export interface BootDaemonOptions {
	/** Where the daemon keeps its own state; a fresh temp dir by default. */
	dataDir?: string;
	/** The engine's workspace; a fresh temp dir by default. */
	workspace?: string;
	/** Fixed port, for tests that print it or connect twice. 0 picks a free one. */
	port?: number;
	/** Engine argv override. Defaults to this Node with the fake agent. */
	engineCommand?: string[];
	/** Environment for this boot: set before start, restored on stop. */
	env?: Record<string, string | undefined>;
}

export interface BootedDaemon {
	daemon: { stop(): Promise<void> };
	port: number;
	dataDir: string;
	workspace: string;
	socketPath: string;
	/** Stops the daemon and restores the environment this boot changed. */
	stop(): Promise<void>;
}

/** A port nothing listens on right now, for tests that need the number up front. */
export function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const server = createServer();
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => resolve(port));
		});
	});
}

/**
 * Boots a daemon with the fake engine, the way the gateway tests need it.
 *
 * `engineCommand` is the seam that replaced agentCommand/agentArgs: the spawner runs exactly
 * those argv entries instead of whatever `gentle-shell` resolves to on PATH.
 */
export async function bootDaemon(options: BootDaemonOptions = {}): Promise<BootedDaemon> {
	const dataDir = options.dataDir ?? mkdtempSync(join(HARNESS_HOME, "data-"));
	const workspace = options.workspace ?? mkdtempSync(join(HARNESS_HOME, "workspace-"));

	const restored = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(options.env ?? {})) {
		restored.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	const { createDaemon } = await import("../src/daemon.ts");
	const daemon = await createDaemon({
		configPath: CONNECTORS_CONFIG_PATH,
		port: options.port ?? 0,
		host: "127.0.0.1",
		dataDir,
		workspace,
		engineCommand: options.engineCommand ?? [process.execPath, FAKE_AGENT],
	});

	return {
		daemon,
		port: (daemon as unknown as { config?: { daemon?: { port?: number } } }).config?.daemon?.port ?? (options.port ?? 0),
		dataDir,
		workspace,
		socketPath: APP_SOCKET_PATH,
		async stop() {
			await daemon.stop();
			for (const [key, value] of restored) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		},
	};
}

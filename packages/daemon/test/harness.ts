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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { FAKE_AGENT } from "./helpers.ts";

/** One HOME per test process, set before the daemon module (and AppChannel) is imported. */
export const HARNESS_HOME =
	process.env["GENTLE_DOT_TEST_HOME"] ?? mkdtempSync(join(tmpdir(), "gentle-dot-test-"));
process.env["HOME"] = HARNESS_HOME;
mkdirSync(join(HARNESS_HOME, ".gentle-dot"), { recursive: true });

/** The app-channel socket for this HOME (see AppChannel.DEFAULT_SOCKET_PATH). */
export const APP_SOCKET_PATH = join(HARNESS_HOME, ".gentle-dot", "app-channel.sock");

/** The access key the daemon answers to, unless the environment names another. */
export const BRIDGE_KEY = process.env["BRIDGE_AUTH" + "_TOKEN"] ?? "test-bridge-token-12345";

/**
 * A minimal config with the same *shape* as `packages/daemon/connectors.yaml`, every connector
 * disabled, written per boot because the loader requires `daemon.data_dir` and
 * `daemon.workspace` and expands them (`expandTilde` throws on a missing value).
 *
 * The blocks and their nested fields must exist even when disabled: the daemon reads
 * `connectors.gmail|discord|whatsapp` directly, and the repo config would spawn real MCP
 * servers on every boot (npm 404s and initialize timeouts that turn 40s into minutes).
 */
export function writeTestConfig(dataDir: string, workspace: string, port: number): string {
	const configPath = join(dataDir, "connectors.yaml");
	writeFileSync(
		configPath,
		[
			"daemon:",
			`  port: ${port}`,
			'  host: "127.0.0.1"',
			'  log_level: "warn"',
			`  data_dir: "${dataDir}"`,
			`  workspace: "${workspace}"`,
			"connectors:",
			"  telegram:",
			"    enabled: false",
			'    mode: "read_only"',
			"    nickname_required: true",
			"    long_polling: false",
			'    webhook_url: ""',
			"  gmail:",
			"    enabled: false",
			'    mode: "read_only"',
			"    oauth_scopes:",
			'      - "https://www.googleapis.com/auth/gmail.readonly"',
			'    webhook_secret_env: "GMAIL_WEBHOOK_SECRET"',
			"  discord:",
			"    enabled: false",
			'    mode: "read_only"',
			'    bot_token_env: "DISCORD_BOT_TOKEN"',
			'    client_id_env: "DISCORD_CLIENT_ID"',
			"    slash_commands: false",
			"    intents:",
			'      - "Guilds"',
			"  whatsapp:",
			"    enabled: false",
			'    mode: "read_only"',
			"    modes:",
			"      baileys:",
			"        enabled: false",
			"        multi_device: false",
			'        session_store: "sqlite"',
			"      meta_cloud:",
			"        enabled: false",
			'        phone_number_id_env: "WHATSAPP_PHONE_ID"',
			'        access_token_env: "WHATSAPP_ACCESS_TOKEN"',
			'        webhook_verify_token_env: "WHATSAPP_WEBHOOK_VERIFY"',
			"",
		].join("\n"),
	);
	return configPath;
}

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
	/** The app's side of its pipe, for the lifetime tests (fd 3 in production). */
	appChannel?: Duplex;
	/** Sign-in runtime for the accounts screen; production builds one from the engine home. */
	authRuntime?: () => Promise<import('../src/auth.ts').AuthRuntime>;
	/** Another setup's profiles.json, read once for the import. */
	profilesImportPath?: string;
	/** Upload limits for the desktop app's files. */
	uploadLimits?: { fileBytes: number; messageBytes: number; files: number };
	/** OAuth runner for the connectors' own sign-in; tests inject a stand-in. */
	connectorOAuth?: NonNullable<ConstructorParameters<typeof import('../src/connectors.ts').ConnectorManager>[0]['oauth']>;
	/** Upload limits for the desktop app's files. */
	uploadLimits?: { fileBytes: number; messageBytes: number; files: number };
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

	// Port 0 means "whatever the config says", and the repo's config says 4317 — the production
	// port. A test must never be able to take it, so an unset port is resolved here and passed
	// as a concrete number, and GENTLE_DOT_PORT keeps the loader from preferring the file.
	const port = options.port ?? (await freePort());
	process.env["GENTLE_DOT_PORT"] = String(port);
	process.env["GENTLE_DOT_HOST"] = "127.0.0.1";
	process.env["BRIDGE_AUTH_TOKEN"] = "test-bridge-token-12345";

	const configPath = writeTestConfig(dataDir, workspace, port);
	const { createDaemon } = await import("../src/daemon.ts");
	const daemon = await createDaemon({
		configPath,
		port,
		host: "127.0.0.1",
		dataDir,
		workspace,
		engineCommand: options.engineCommand ?? [process.execPath, FAKE_AGENT],
		...(options.appChannel ? { appChannel: options.appChannel } : {}),
		...(options.authRuntime ? { authRuntime: options.authRuntime } : {}),
		...(options.profilesImportPath ? { profilesImportPath: options.profilesImportPath } : {}),
		...(options.uploadLimits ? { uploadLimits: options.uploadLimits } : {}),
		...(options.connectorOAuth ? { connectorOAuth: options.connectorOAuth } : {}),
		...(options.uploadLimits ? { uploadLimits: options.uploadLimits } : {}),
	});

	return {
		daemon,
		port,
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

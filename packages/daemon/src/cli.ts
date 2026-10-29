#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { inheritedAppSocket } from "./app-channel.ts";
import { serveAuthHelper } from "./auth-helper.ts";
import { loadConfig } from "./config.ts";
import { APPROVAL_GUARD, bundledMcpCli } from "./connectors.ts";
import { startDaemon, startupMessage } from "./daemon.ts";
import { resolveEngramBin, runtimeDir } from "./runtime.ts";
import { SECRETS_KEY_VAR } from "./secret-file.ts";
import { loadVpsOptions } from "./vps.ts";
import { IDENTITY_SOURCE } from "./white-label.ts";
import type { WindowsAppChannel } from "./windows-app-channel.ts";
import { finishWindowsShutdown, startWithWindowsAppChannel } from "./windows-stop.ts";

/** This file (or the bundled `cli.mjs`), which the sign-in helper runs again. */
const ENTRY = fileURLToPath(import.meta.url);
const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

/**
 * `--self-check`: resolves the files the daemon runs on, without starting anything or
 * using the network, prints them as JSON, and exits 1 when one is missing.
 */
function selfCheck(): void {
	const config = loadConfig();
	const runtime = runtimeDir();
	const report = {
		runtime,
		uiDir: config.uiDir,
		gentleShell: config.agentArgs[0],
		engineCli: bundledMcpCli().args[0],
		approvalGuard: APPROVAL_GUARD,
		identity: fileURLToPath(IDENTITY_SOURCE),
		engramBin: runtime ? resolveEngramBin(process.env, runtime) : undefined,
	};
	const required = [report.gentleShell, report.engineCli, report.approvalGuard, report.identity];
	const ok = required.every((path) => path !== undefined && existsSync(path));
	process.stdout.write(`${JSON.stringify({ ok, ...report }, null, 2)}\n`);
	process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
	const config = loadConfig();
	// The desktop app that launched the daemon hands over its private channel on fd 3 (S25.1); it is
	// opened before anything is spawned, and refused if children would inherit it.
	const appChannel = process.platform === "win32" ? undefined : inheritedAppSocket({ log });
	// Server mode only when GENTLE_DOT_VPS says so (S25.8). The secrets key is read once and removed
	// from the process environment, so no child the daemon starts can inherit it.
	const vps = loadVpsOptions(process.env, { uid: process.getuid?.() ?? -1 });
	delete process.env[SECRETS_KEY_VAR];
	const start = (channel: Duplex | undefined = appChannel) =>
		startDaemon({
			port: config.port,
			host: config.host,
			dataDir: config.dataDir,
			workspace: config.workspace,
			...(config.preferredFolder ? { preferredFolder: config.preferredFolder } : {}),
			uiDir: config.uiDir,
			agentCommand: config.agentCommand,
			agentArgs: config.agentArgs,
			...(config.agentHome ? { agentHome: config.agentHome } : {}),
			allowedOrigins: config.allowedOrigins,
			...(channel ? { appChannel: channel } : {}),
			// Sign-in runs in this same entry point as the engine's user (`--auth-helper`, B1).
			...(vps
				? { vps: { ...vps, authHelper: { command: process.execPath, args: [ENTRY, "--auth-helper"] } } }
				: {}),
			log,
		});
	// Windows requires the L98 private exact-launch record. No implicit unmanaged bypass.
	// Construction precedes startDaemon and therefore all descendant startup.
	const windows =
		process.platform === "win32"
			? await startWithWindowsAppChannel<Awaited<ReturnType<typeof start>>, WindowsAppChannel>(
					join(config.dataDir, "daemon.pid"),
					start,
				)
			: undefined;
	const daemon = windows?.daemon ?? (await start());
	process.stdout.write(`${startupMessage(daemon.url, config.dataDir, process.stdout.isTTY === true)}\n`);

	if (windows) {
		const shutdown = () => {
			void windows.close();
		};
		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);
		// Only successful daemon.close AND native drain may report success. Never use
		// daemon.closed directly here: it also settles when daemon.close rejects.
		// On failure, retain the owner and set exitCode without abandoning native
		// ownership through process.exit. No descendant completion is claimed.
		void finishWindowsShutdown(windows, process, log);
		return;
	}

	let closing = false;
	const shutdown = (signal: string) => {
		if (closing) return;
		closing = true;
		log(`received ${signal}, shutting down`);
		daemon.close().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	// A daemon the app launched stops itself when the app's channel closes (S35.2); so does the process.
	void daemon.closed.then(() => process.exit(0));
}

if (process.argv.includes("--auth-helper")) serveAuthHelper();
else {
	if (process.argv.includes("--self-check")) selfCheck();
	main().catch((error: Error) => {
		log(`failed to start: ${error.message}`);
		// Windows lets native ownership drain instead of exiting at once (`finishWindowsShutdown`).
		if (process.platform === "win32") process.exitCode = 1;
		else process.exit(1);
	});
}

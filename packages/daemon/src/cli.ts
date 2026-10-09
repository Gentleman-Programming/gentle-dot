#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inheritedAppSocket } from "./app-channel.ts";
import { loadConfig } from "./config.ts";
import { APPROVAL_GUARD, bundledMcpCli } from "./connectors.ts";
import { startDaemon, startupMessage } from "./daemon.ts";
import { resolveEngramBin, runtimeDir } from "./runtime.ts";
import { IDENTITY_SOURCE } from "./white-label.ts";

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
	const appChannel = inheritedAppSocket({ log });
	const daemon = await startDaemon({
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
		...(appChannel ? { appChannel } : {}),
		log,
	});
	process.stdout.write(`${startupMessage(daemon.url, config.dataDir, process.stdout.isTTY === true)}\n`);

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
}

if (process.argv.includes("--self-check")) selfCheck();

main().catch((error: Error) => {
	log(`failed to start: ${error.message}`);
	process.exit(1);
});

#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { startDaemon, startupMessage } from "./daemon.ts";

const log = (line: string) => process.stderr.write(`${new Date().toISOString()} ${line}\n`);

async function main(): Promise<void> {
	const config = loadConfig();
	const daemon = await startDaemon({
		port: config.port,
		host: config.host,
		dataDir: config.dataDir,
		workspace: config.workspace,
		uiDir: config.uiDir,
		agentCommand: config.agentCommand,
		agentArgs: config.agentArgs,
		...(config.agentHome ? { agentHome: config.agentHome } : {}),
		allowedOrigins: config.allowedOrigins,
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

main().catch((error: Error) => {
	log(`failed to start: ${error.message}`);
	process.exit(1);
});

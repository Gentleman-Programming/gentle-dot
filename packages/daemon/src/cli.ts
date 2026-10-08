#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { startDaemon } from "./daemon.ts";

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
		allowedOrigins: config.allowedOrigins,
		log,
	});
	process.stdout.write(`Gentle Dot is running at ${daemon.url}\n`);

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

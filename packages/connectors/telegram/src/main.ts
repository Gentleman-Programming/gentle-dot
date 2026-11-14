/**
 * Telegram Connector — Gentle Dot bridge over BaseBridge v2 (grammY).
 *
 * Entry point: loads the config, builds the bridge and starts it. The bridge
 * connects to the daemon itself (BaseBridge.connect) and then opens the
 * Telegram gateway with its own bot token.
 */

import { homedir } from "node:os";
import { TelegramBridge } from "./telegram-bridge.js";
import { ConfigError, loadConfig } from "./config.js";

const log = (message: string) => console.error(`[gentle-telegram] ${message}`);

async function main(): Promise<void> {
	let bridge: TelegramBridge;
	try {
		let config;
		try {
			config = loadConfig(process.env, homedir());
		} catch (error) {
			if (!(error instanceof ConfigError)) throw error;
			log(error.message);
			process.exit(1);
		}

		process.on("unhandledRejection", (error) =>
			log(`unexpected error: ${(error as Error)?.message ?? String(error)}`),
		);

		bridge = new TelegramBridge({ config, log });
	} catch (error) {
		log((error as Error).message);
		process.exit(1);
	}

	const shutdown = async () => {
		log("shutting down...");
		await bridge.stop();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	try {
		await bridge.start();
		log("listening");
	} catch (error) {
		log(`failed to start: ${(error as Error).message}`);
		process.exit(1);
	}
}

void main();

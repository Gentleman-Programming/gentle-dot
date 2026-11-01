import { homedir } from "node:os";
import { Bot } from "grammy";
import { Bridge } from "./bridge.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { DaemonClient } from "./daemon-client.ts";
import { daemonUploader } from "./uploads.ts";

const log = (message: string) => console.error(`[dot-telegram] ${message}`);

function main(): void {
	let config: ReturnType<typeof loadConfig>;
	try {
		config = loadConfig(process.env, homedir());
	} catch (error) {
		if (!(error instanceof ConfigError)) throw error;
		log(error.message);
		process.exit(1);
	}

	process.on("unhandledRejection", (error) => log(`unexpected error: ${(error as Error)?.message ?? String(error)}`));

	// Bot API calls give up after 60 s (long polling waits 30 s), so one stuck call cannot hold every update.
	const bot = new Bot(config.botToken, { client: { timeoutSeconds: 60 } });
	let bridge: Bridge | undefined;
	let failed = false;
	const daemon = new DaemonClient({
		url: config.daemonUrl,
		tokenFile: config.tokenFile,
		log,
		onMessage: (message) => void bridge?.handleDaemon(message),
		onConnection: (connected) => {
			log(connected ? "connected to Gentle Dot" : "disconnected from Gentle Dot, retrying");
			if (!connected) void bridge?.connectionLost();
		},
		onFatal: (reason) => {
			failed = true;
			log(reason);
			void bot.stop().finally(() => process.exit(1));
		},
	});
	bridge = new Bridge({
		bot,
		daemon,
		allowedUsers: config.allowedUsers,
		log,
		upload: daemonUploader({ daemonUrl: config.daemonUrl, tokenFile: config.tokenFile }),
	});

	const shutdown = () => {
		daemon.stop();
		void bot.stop().finally(() => process.exit(0));
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	daemon.start();
	// A missing key file fails at once; do not start polling Telegram for a bridge that cannot work.
	if (failed) return;
	void bot
		.start({
			allowed_updates: ["message", "callback_query", "stopped_message_generation"],
			onStart: (info) => {
				log(`listening as @${info.username}`);
				void bot.api
					.setMyCommands([
						{ command: "menu", description: "Menú de acciones rápidas" },
						{ command: "help", description: "Qué puede hacer este bot" },
						{ command: "stop", description: "Detener la tarea en curso" },
						{ command: "cancel", description: "Cancelar la respuesta pendiente" },
					])
					.catch((error: Error) => log(`could not set the command list: ${error.message}`));
				void bridge?.hello();
			},
		})
		.catch((error: Error) => {
			log(`Telegram polling stopped: ${error.message}`);
			daemon.stop();
			process.exit(1);
		});
}

main();

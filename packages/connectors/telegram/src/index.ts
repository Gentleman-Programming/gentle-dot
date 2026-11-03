import { Bridge } from "./bridge.js";
import { ConfigError, loadConfig } from "./config.js";
import { DaemonClient } from "./daemon-client.js";
import { daemonUploader } from "./uploads.js";

const log = (message: string) => console.error(`[dot-telegram] ${message}`);

async function main(): Promise<void> {
	let config: ReturnType<typeof loadConfig>;
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

	const nicknameStore = new NicknameStore();
	await nicknameStore.init();

	const daemon = new DaemonClient({
		url: config.daemonUrl,
		tokenFile: config.tokenFile,
		log,
		onMessage: (message) => void bridge.handleDaemon(message),
		onConnection: (connected) => log(connected ? "connected to Gentle Dot" : "disconnected from Gentle Dot, retrying"),
		onFatal: (reason) => {
			log(reason);
			process.exit(1);
		},
	});

	const bridge = new Bridge({
		bot: new Bot(config.botToken),
		daemon,
		allowedUsers: config.allowedUsers,
		log,
		download: telegramDownloader(config.botToken, { timeoutMs: 30_000 }),
		upload: daemonUploader,
	});

	await daemon.start();
	await bridge.hello();
	await bridge.bot.start({
		allowed_updates: ["message", "callback_query", "stopped_message_generation"],
	});
	log("listening");
}

void main();
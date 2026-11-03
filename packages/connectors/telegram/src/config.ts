import { join } from "node:path";

export interface Config {
	botToken: string;
	/** Telegram user ids allowed to talk to the assistant. */
	allowedUsers: Set<number>;
	/** The daemon's WebSocket address. */
	daemonUrl: string;
	/** File holding the daemon's access key. */
	tokenFile: string;
}

export class ConfigError extends Error {}

const USER_ID = /^[1-9][0-9]{0,15}$/;

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
	const botToken = env.TELEGRAM_BOT_TOKEN_ROSITA?.trim();
	if (!botToken)
		throw new ConfigError(
			"TELEGRAM_BOT_TOKEN_ROSITA is required (the token BotFather gave Rosita). Multi-bot setups use per-bot suffixed names; no bare-name fallback.",
		);

	const ids = (env.DOT_TELEGRAM_ALLOWED_USERS ?? "")
		.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	if (ids.length === 0 || !ids.every((id) => USER_ID.test(id))) {
		throw new ConfigError(
			"DOT_TELEGRAM_ALLOWED_USERS must list at least one numeric Telegram user id, separated by commas.",
		);
	}

	const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
	if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

	return {
		botToken,
		allowedUsers: new Set(ids.map(Number)),
		daemonUrl,
		tokenFile: env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token"),
	};
}
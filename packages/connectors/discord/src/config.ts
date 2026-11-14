import { join } from "node:path";

/** Discord connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Discord bot token. */
  discordToken: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** Allowed channel IDs (optional allowlist). */
  allowedChannelIds: string[];
  /** Allowed guild IDs (optional allowlist). */
  allowedGuildIds: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const token = (env.DISCORD_BOT_TOKEN?? env.DISCORD_TOKEN)?.trim();
  if (!token) throw new ConfigError("DISCORD_TOKEN environment variable required");

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const allowedChannelIds = (env.DISCORD_ALLOWED_CHANNEL_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowedGuildIds = (env.DISCORD_ALLOWED_GUILD_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_DISCORD_CONNECTOR_ID?.trim() || 'discord',
    discordToken: token,
    daemonUrl,
    tokenFile,
    allowedChannelIds,
    allowedGuildIds,
  };
}
import { join } from "node:path";

/** Slack MCP connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Slack Bot Token (starts with xoxb-). */
  botToken: string;
  /** Slack App Token for Socket Mode (starts with xapp-). */
  appToken: string;
  /** Slack Signing Secret for request verification. */
  signingSecret: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** MCP server command to run (e.g., "npx @slack/mcp-server"). */
  mcpCommand: string;
  /** MCP server arguments. */
  mcpArgs: string[];
  /** Allowed channel IDs to filter events (optional). */
  allowedChannelIds: string[];
  /** Allowed team/workspace IDs to filter events (optional). */
  allowedTeamIds: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const botToken = env.SLACK_BOT_TOKEN?.trim();
  if (!botToken) throw new ConfigError("SLACK_BOT_TOKEN environment variable required (format: xoxb-...)");
  if (!botToken.startsWith("xoxb-")) {
    throw new ConfigError("SLACK_BOT_TOKEN must be a valid Slack Bot Token (xoxb-...)");
  }

  const appToken = env.SLACK_APP_TOKEN?.trim();
  if (!appToken) throw new ConfigError("SLACK_APP_TOKEN environment variable required (format: xapp-...)");
  if (!appToken.startsWith("xapp-")) {
    throw new ConfigError("SLACK_APP_TOKEN must be a valid Slack App Token (xapp-...)");
  }

  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  if (!signingSecret) throw new ConfigError("SLACK_SIGNING_SECRET environment variable required");

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const mcpCommand = env.SLACK_MCP_COMMAND?.trim() || "npx";
  const mcpArgs = (env.SLACK_MCP_ARGS ?? "@modelcontextprotocol/server-slack").split(" ").map(s => s.trim()).filter(Boolean);

  const allowedChannelIds = (env.SLACK_ALLOWED_CHANNEL_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const allowedTeamIds = (env.SLACK_ALLOWED_TEAM_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_SLACK_CONNECTOR_ID?.trim() || 'slack',
    botToken,
    appToken,
    signingSecret,
    daemonUrl,
    tokenFile,
    mcpCommand,
    mcpArgs,
    allowedChannelIds,
    allowedTeamIds,
  };
}
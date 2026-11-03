import { join } from "node:path";

/** Atlassian MCP connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Atlassian Cloud site URL (e.g., https://your-domain.atlassian.net). */
  siteUrl: string;
  /** Atlassian API token (for email-based auth). */
  apiToken: string;
  /** Email associated with the API token. */
  email: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** MCP server command to run (e.g., "npx @atlassian/mcp-server"). */
  mcpCommand: string;
  /** MCP server arguments. */
  mcpArgs: string[];
  /** Allowed Cloud IDs to filter events (optional). */
  allowedCloudIds: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const siteUrl = env.ATLASSIAN_SITE_URL?.trim();
  if (!siteUrl) throw new ConfigError("ATLASSIAN_SITE_URL environment variable required (e.g., https://your-domain.atlassian.net)");
  if (!/^https:\/\/.+\.atlassian\.net\/?$/.test(siteUrl)) {
    throw new ConfigError("ATLASSIAN_SITE_URL must be a valid Atlassian Cloud URL");
  }

  const apiToken = env.ATLASSIAN_API_TOKEN?.trim();
  if (!apiToken) throw new ConfigError("ATLASSIAN_API_TOKEN environment variable required");

  const email = env.ATLASSIAN_EMAIL?.trim();
  if (!email) throw new ConfigError("ATLASSIAN_EMAIL environment variable required");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ConfigError("ATLASSIAN_EMAIL must be a valid email address");
  }

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const mcpCommand = env.ATLASSIAN_MCP_COMMAND?.trim() || "npx";
  const mcpArgs = (env.ATLASSIAN_MCP_ARGS ?? "mcp-atlassian").split(" ").map(s => s.trim()).filter(Boolean);

  const allowedCloudIds = (env.ATLASSIAN_ALLOWED_CLOUD_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_ATLASSIAN_CONNECTOR_ID?.trim() || 'atlassian',
    siteUrl,
    apiToken,
    email,
    daemonUrl,
    tokenFile,
    mcpCommand,
    mcpArgs,
    allowedCloudIds,
  };
}
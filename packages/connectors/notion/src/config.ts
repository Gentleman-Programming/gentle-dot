import { join } from "node:path";

/** Notion MCP connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Notion integration token (starts with secret_). */
  apiKey: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** MCP server command to run (e.g., "npx @notionhq/mcp-server"). */
  mcpCommand: string;
  /** MCP server arguments. */
  mcpArgs: string[];
  /** Allowed workspace IDs to filter events (optional). */
  allowedWorkspaceIds: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const apiKey = env.NOTION_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("NOTION_API_KEY environment variable required (format: secret_...)");
  if (!apiKey.startsWith("secret_") && !apiKey.startsWith("ntn_")) {
    throw new ConfigError("NOTION_API_KEY must be a valid Notion integration token");
  }

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const mcpCommand = env.NOTION_MCP_COMMAND?.trim() || "npx";
  const mcpArgs = (env.NOTION_MCP_ARGS ?? "@notionhq/mcp-server").split(" ").map(s => s.trim()).filter(Boolean);

  const allowedWorkspaceIds = (env.NOTION_ALLOWED_WORKSPACE_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_NOTION_CONNECTOR_ID?.trim() || 'notion',
    apiKey,
    daemonUrl,
    tokenFile,
    mcpCommand,
    mcpArgs,
    allowedWorkspaceIds,
  };
}
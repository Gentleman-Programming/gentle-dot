import { join } from "node:path";

/** Linear MCP connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Linear API key for authentication. */
  apiKey: string;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** MCP server command to run (e.g., "npx @linear/mcp-server"). */
  mcpCommand: string;
  /** MCP server arguments. */
  mcpArgs: string[];
  /** Allowed teams to filter events (optional). */
  allowedTeamIds: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const apiKey = env.LINEAR_API_KEY?.trim();
  if (!apiKey) throw new ConfigError("LINEAR_API_KEY environment variable required");

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");

  const mcpCommand = env.LINEAR_MCP_COMMAND?.trim() || "npx";
  const mcpArgs = (env.LINEAR_MCP_ARGS ?? "mcp-remote https://mcp.linear.app/sse").split(" ").map(s => s.trim()).filter(Boolean);

  const allowedTeamIds = (env.LINEAR_ALLOWED_TEAM_IDS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_LINEAR_CONNECTOR_ID?.trim() || 'linear',
    apiKey,
    daemonUrl,
    tokenFile,
    mcpCommand,
    mcpArgs,
    allowedTeamIds,
  };
}
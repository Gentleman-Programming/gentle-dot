import { join } from "node:path";

/** Gmail OAuth2 configuration */
export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

/** Gmail connector configuration */
export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Gmail OAuth2 configuration. */
  oauth: GmailOAuthConfig;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** Token storage path (for Gmail OAuth tokens). */
  tokenPath: string;
  /** Polling interval for Gmail history (ms). */
  pollIntervalMs: number;
  /** Allowed labels to trigger notifications (default: INBOX). */
  watchLabels: string[];
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  // Required OAuth2 credentials
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const redirectUri = env.GMAIL_REDIRECT_URI?.trim() || "http://localhost:4317/oauth2callback";

  if (!clientId || !clientSecret) {
    throw new ConfigError("GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set.");
  }

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const tokenFile = env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token");
  const tokenPath = env.GMAIL_TOKEN_PATH?.trim() || join(home, ".dot-gmail", "gmail-tokens.json");

  const pollIntervalRaw = env.GMAIL_POLL_INTERVAL_MS?.trim() || "5000";
  const pollIntervalMs = Number(pollIntervalRaw);
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1000) {
    throw new ConfigError("GMAIL_POLL_INTERVAL_MS must be an integer >= 1000.");
  }

  const watchLabels = (env.GMAIL_WATCH_LABELS ?? "INBOX")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  return {
    connectorId: env.DOT_GMAIL_CONNECTOR_ID?.trim() || 'gmail',
    oauth: {
      clientId,
      clientSecret,
      redirectUri,
      scopes: (env.GMAIL_SCOPES ?? DEFAULT_SCOPES.join(",")).split(",").map(s => s.trim()),
    },
    daemonUrl,
    tokenFile,
    tokenPath,
    pollIntervalMs,
    watchLabels,
  };
}
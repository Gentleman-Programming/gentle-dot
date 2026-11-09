import { join } from "node:path";

/** The Meta Cloud API settings, required only when provider is "meta-cloud". */
export interface MetaCloudConfig {
  phoneNumberId: string;
  token: string;
  verifyToken: string;
  appSecret: string;
  webhookPort: number;
  webhookHost: string;
  graphUrl: string;
  graphVersion: string;
}

export interface Config {
  /** Unique identifier for this connector instance. */
  connectorId?: string;
  /** Where Baileys keeps its own credential files (must be mode 700). Never in Engram. */
  authDir: string;
  /** E.164 numbers (digits only) allowed to talk to the assistant. */
  allowedNumbers: Set<string>;
  /** The daemon's WebSocket address. */
  daemonUrl: string;
  /** File holding the daemon's access key. */
  tokenFile: string;
  /** WhatsApp provider to use: "baileys" (default) or "meta-cloud". */
  provider: "baileys" | "meta-cloud";
  /** Meta Cloud API settings; null for the baileys provider. */
  meta: MetaCloudConfig | null;
  /** Local admin API port (Channels panel); the server always binds 127.0.0.1. */
  adminPort: number;
  /** File holding the admin API bearer token (0600, created if absent). */
  adminTokenFile: string;
  /** The allowlist persistence file (0600): the source of truth once it exists. */
  allowlistFile: string;
}

/** A configuration problem; the message names the variable and never repeats its value. */
export class ConfigError extends Error {}

const NUMBER = /^[1-9][0-9]{6,14}$/;

/** True for a valid E.164 number in digits-only form (no leading +). */
export function isValidE164(value: string): boolean {
  return NUMBER.test(value);
}

export function loadConfig(env: Record<string, string | undefined>, home: string): Config {
  const numbers = (env.DOT_WHATSAPP_ALLOWED_NUMBERS ?? "")
    .split(",")
    .map((n) => n.trim().replace(/^\+/, ""))
    .filter((n) => n !== "");
  if (numbers.length === 0 || !numbers.every((n) => NUMBER.test(n))) {
    throw new ConfigError(
      "DOT_WHATSAPP_ALLOWED_NUMBERS must list at least one E.164 number, digits only, separated by commas.",
    );
  }

  const daemonUrl = env.GENTLE_DOT_URL?.trim() || "ws://127.0.0.1:4317/ws";
  if (!/^wss?:\/\//.test(daemonUrl)) throw new ConfigError("GENTLE_DOT_URL must start with ws:// or wss://.");

  const adminPortRaw = env.DOT_WHATSAPP_ADMIN_PORT?.trim() || "4407";
  const adminPort = Number(adminPortRaw);
  if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
    throw new ConfigError("DOT_WHATSAPP_ADMIN_PORT must be an integer between 1 and 65535.");
  }

  const provider = (env.DOT_WHATSAPP_PROVIDER ?? "baileys") as "baileys" | "meta-cloud";
  let meta: MetaCloudConfig | null = null;
  if (provider === "meta-cloud") {
    const phoneNumberId = env.DOT_WHATSAPP_META_PHONE_NUMBER_ID?.trim() || "";
    const token = env.DOT_WHATSAPP_META_TOKEN?.trim() || "";
    const verifyToken = env.DOT_WHATSAPP_META_VERIFY_TOKEN?.trim() || "";
    const appSecret = env.DOT_WHATSAPP_META_APP_SECRET?.trim() || "";
    const missing = [
      ["DOT_WHATSAPP_META_PHONE_NUMBER_ID", phoneNumberId],
      ["DOT_WHATSAPP_META_TOKEN", token],
      ["DOT_WHATSAPP_META_VERIFY_TOKEN", verifyToken],
      ["DOT_WHATSAPP_META_APP_SECRET", appSecret],
    ].filter(([, v]) => v === "");
    if (missing.length > 0) {
      throw new ConfigError(`provider meta-cloud requires ${missing.map(([name]) => name).join(", ")}.`);
    }
    const webhookPortRaw = env.DOT_WHATSAPP_META_WEBHOOK_PORT?.trim() || "4408";
    const webhookPort = Number(webhookPortRaw);
    if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
      throw new ConfigError("DOT_WHATSAPP_META_WEBHOOK_PORT must be an integer between 1 and 65535.");
    }
    meta = {
      phoneNumberId,
      token,
      verifyToken,
      appSecret,
      webhookPort,
      webhookHost: env.DOT_WHATSAPP_META_WEBHOOK_HOST?.trim() || "0.0.0.0",
      graphUrl: env.DOT_WHATSAPP_META_GRAPH_URL?.trim() || "https://graph.facebook.com",
      graphVersion: env.DOT_WHATSAPP_META_GRAPH_VERSION?.trim() || "v21.0",
    };
  }

  return {
    connectorId: env.DOT_WHATSAPP_CONNECTOR_ID?.trim() || 'whatsapp',
    authDir: env.DOT_WHATSAPP_AUTH_DIR?.trim() || join(home, ".dot-whatsapp", "auth"),
    allowedNumbers: new Set(numbers),
    daemonUrl,
    tokenFile: env.GENTLE_DOT_TOKEN_FILE?.trim() || join(home, ".gentle-dot", "token"),
    provider,
    meta,
    adminPort,
    adminTokenFile: env.DOT_WHATSAPP_ADMIN_TOKEN_FILE?.trim() || join(home, ".dot-whatsapp", "admin-token"),
    allowlistFile: env.DOT_WHATSAPP_ALLOWLIST_FILE?.trim() || join(home, ".dot-whatsapp", "allowlist.json"),
  };
}
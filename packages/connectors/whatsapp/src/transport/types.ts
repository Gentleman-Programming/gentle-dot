/**
 * WhatsApp Transport Interface
 * Abstracts the WhatsApp provider (Baileys or Meta Cloud)
 */

export interface ChannelInbound {
  /** E.164 digits of the sender. */
  from: string;
  /** The provider's unique message id (the bridge's idempotency anchor). */
  id: string;
  text: string;
}

/** Connectivity events for admin surfaces; the relay behavior never depends on them. */
export type TransportStateEvent =
  | { kind: "qr"; qr: string }
  | { kind: "open"; number?: string }
  | { kind: "activity" }
  | { kind: "close"; reason: "logged_out" | "reconnecting" | "stopped" }
  | { kind: "error"; message: string };

export interface ChannelTransport {
  /** Starts the provider (QR pairing on first run) and resolves when listening. */
  start(): Promise<void>;
  /** Register the inbound handler for allowlisted direct texts (anti-loop already applied). */
  onMessage(handler: (message: ChannelInbound) => void): void;
  /** Sends plain text; throws when the socket is down (the bridge retries via daemon backoff). */
  sendText(toNumber: string, text: string): Promise<void>;
  /** Stops the socket; process exit is owned by main. */
  stop(): Promise<void>;
  /** Registers a connectivity observer for admin surfaces; optional for simple providers. */
  onState?(handler: (event: TransportStateEvent) => void): void;
}

export type ProviderType = "baileys" | "meta-cloud";

export interface TransportFactoryOptions {
  authDir: string;
  allowedNumbers: Set<string>;
  log?(m: string): void;
  provider?: ProviderType;
  meta?: MetaCloudConfig | null;
}

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
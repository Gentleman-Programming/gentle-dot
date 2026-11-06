/**
 * WhatsApp Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Meta Cloud API provider only (Baileys has git dependency issues)
 */

import { BaseBridge, brandInbound, type BridgeConfig, type BridgeMessage, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type MetaCloudConfig } from './config.js';
import { createTransportFactory, type ChannelTransport, type ChannelInbound, type TransportStateEvent, type TransportFactoryOptions } from './transport/factory.js';
import { RateLimiter } from './rate-limit.js';

const WHATSAPP_TEXT_LIMIT = 4000;
const SOURCE_LABEL = "📱 [Gentle Dot] ";

const SEND_REFUSALS = new Set(["no_account", "agent_unavailable", "command_failed", "unsupported"]);
const BUSY_STATES = ["thinking", "working", "needs_you"];
const UNREACHABLE = "Gentle Dot no está disponible ahora.";

function splitMessage(text: string, limit = WHATSAPP_TEXT_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const breakAt = rest.lastIndexOf("\n", limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest !== "") chunks.push(rest);
  return chunks;
}

export interface WhatsAppBridgeOptions {
  config: Config;
  log(message: string): void;
}

interface Turn {
  buffer: string;
  requestId: string;
}

interface PendingAsk {
  ask: {
    requestId: string;
    method: string;
    title: string;
    message?: string;
    options?: string[];
  };
  from: string;
}

export class WhatsAppBridge extends BaseBridge {
  private transport: ChannelTransport;
  private options: WhatsAppBridgeOptions;
  private logFn: (message: string) => void;
  private rateLimiter: RateLimiter;

  // State
  private turn: Turn | undefined;
  private ask: PendingAsk | undefined;
  private agentState = "idle";
  private lastFrom: string | undefined;

  constructor(options: WhatsAppBridgeOptions) {
    if (!options.config.meta) throw new Error("Meta Cloud configuration is required");
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'whatsapp',
      connectorType: 'whatsapp',
      token: options.config.meta.token,
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'allowlist_management',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'meta-cloud',
        features: ['allowlist_management', 'meta_cloud_support'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;

    // Create Meta Cloud transport
    const transportOptions: TransportFactoryOptions = {
      authDir: options.config.authDir,
      allowedNumbers: options.config.allowedNumbers,
      log: options.log,
      provider: options.config.provider,
      meta: options.config.meta,
    };
    this.transport = createTransportFactory(transportOptions);
    this.rateLimiter = new RateLimiter(this.transport, options.log);

    this.setupTransport();
  }

  private setupTransport(): void {
    this.transport.onMessage((message) => void this.onInbound(message));
    this.transport.onState?.((event) => void this.onTransportState(event));
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('WhatsApp bridge ready - Meta Cloud transport started');
  }

  async onStop(): Promise<void> {
    this.logFn('WhatsApp bridge stopping');
    this.turn = undefined;
    this.ask = undefined;
    this.agentState = "idle";
    await this.transport.stop();
  }

  // ============ BaseBridge Overrides ============

  protected override sendHello(): void {
    const payload: HelloPayload = {
      token: this.config.token,
      protocol: 1,
      capabilities: this.config.capabilities,
      connectorType: this.config.connectorType,
      connectorId: this.config.connectorId,
      metadata: this.config.metadata,
    };
    this.send('hello', payload);
  }

  protected override handleConnectorMessage(message: BridgeMessage): void {
    this.dispatch(message);
  }

  private dispatch(message: { type: string; payload: unknown }): void {
    switch (message.type) {
      case 'ready': {
        const ready = message.payload as ReadyPayload;
        this.agentState = ready.agentState;
        break;
      }
      case 'agent_state': {
        const payload = message.payload as { state: string };
        this.agentState = payload.state;
        return;
      }
      case 'message_delta': {
        if (this.turn && message.payload && typeof message.payload === 'object' && 'messageId' in message.payload && 'delta' in message.payload) {
          this.turn.buffer += (message.payload as any).delta;
        }
        return;
      }
      case 'message_done': {
        const payload = message.payload as { text?: string; error?: string; stopped?: boolean; messageId?: string };
        const text = payload.text ?? this.turn?.buffer ?? "";
        this.turn = undefined;
        if (text.trim() !== "") void this.replyBroadcast(text);
        return;
      }
      case 'ask': {
        const payload = message.payload as { requestId: string; method: string; title: string; message?: string; options?: string[] };
        void this.showAsk(payload);
        return;
      }
      case 'ask_resolved': {
        const payload = message.payload as { requestId: string };
        if (this.ask?.ask.requestId === payload.requestId) this.ask = undefined;
        return;
      }
      case 'error': {
        const payload = message.payload as { code: string; message: string };
        if (SEND_REFUSALS.has(payload.code)) {
          this.turn = undefined;
          void this.replyBroadcast(`No pude llegar al asistente: ${payload.message}`);
        }
        return;
      }
      case 'channel_notify': {
        const payload = message.payload as { to: string; text: string; requestId?: string };
        const { to, text } = payload;
        if (!to || !text) {
          this.logFn("channel_notify ignored: missing to or text");
          return;
        }
        if (!this.options.config.allowedNumbers.has(to)) {
          this.logFn(`channel_notify ignored: number not allowlisted (…${to.slice(-4)})`);
          return;
        }
        void this.reply(to, text);
        return;
      }
      default:
        return;
    }
  }

  // ============ WhatsApp-Specific Methods ============

  private async onInbound(message: ChannelInbound): Promise<void> {
    const { from, id, text } = message;
    if (!this.options.config.allowedNumbers.has(from)) {
      this.logFn(`ignored: number not allowlisted (…${from.slice(-4)})`);
      return;
    }
    this.lastFrom = from;
    const trimmed = text.trim();
    if (trimmed === "") return;

    if (trimmed === "/stop") {
      await this.stopChat(from);
      return;
    }
    if (this.ask) {
      const answered = this.answerAsk(this.ask, trimmed);
      if (answered) {
        this.ask = undefined;
        return;
      }
    }
    if (BUSY_STATES.includes(this.agentState)) {
      await this.reply(from, "Sigo trabajando en lo anterior; si querés frenar, mandá /stop.");
      return;
    }
    this.send('send', { text: brandInbound(SOURCE_LABEL, trimmed) });
  }

  private async onTransportState(event: TransportStateEvent): Promise<void> {
    switch (event.kind) {
      case "open":
        this.logFn(`WhatsApp Meta Cloud connected`);
        break;
      case "close":
        this.logFn(`WhatsApp disconnected: ${event.reason}`);
        break;
      case "error":
        this.logFn(`WhatsApp error: ${event.message}`);
        break;
    }
  }

  private answerAsk(pending: PendingAsk, text: string): boolean {
    const { ask } = pending;
    const msg: { type: string; requestId: string; confirmed?: boolean; cancelled?: boolean; value?: string } = { type: "ui_response", requestId: ask.requestId };
    if (ask.method === "confirm") {
      const yes = /^(si|sí|s|y|yes|ok|dale|1)$/i.test(text);
      const no = /^(no|n|2)$/i.test(text);
      if (!yes && !no) return false;
      msg.confirmed = yes;
      msg.value = yes ? "confirm" : "cancel";
    } else if (ask.method === "select" && ask.options) {
      const byNumber = /^\d+$/.test(text) ? ask.options[Number(text) - 1] : undefined;
      const byText = ask.options.find((o) => o.toLowerCase() === text.toLowerCase());
      const choice = byNumber ?? byText;
      if (!choice) return false;
      msg.value = choice;
    } else if (ask.method === "input") {
      msg.value = text;
    } else {
      return false;
    }
    this.send(msg.type, msg);
    return true;
  }

  private async showAsk(ask: { requestId: string; method: string; title: string; message?: string; options?: string[] }): Promise<void> {
    const to = this.lastFrom ?? "";
    this.ask = { ask, from: to };
    const lines = [`✋ El asistente pregunta: *${ask.title}*`];
    if (ask.message) lines.push(ask.message);
    if (ask.method === "select" && ask.options)
      ask.options.forEach((option, i) => lines.push(`${i + 1}. ${option}`));
    if (ask.method === "confirm") lines.push("Respondé 1= sí, 2= no.");
    else if (ask.method === "select") lines.push("Respondé con el número o el texto.");
    else if (ask.method === "input") lines.push("Respondé con el texto pedido.");
    else lines.push("Esta acción se responde en la app de escritorio.");
    if (to) await this.reply(to, lines.join("\n"));
  }

  private async stopChat(from: string): Promise<void> {
    this.send('abort', {});
    this.turn = undefined;
    await this.reply(from, "🛑 Detenido.");
  }

  private async replyBroadcast(text: string): Promise<void> {
    if (!this.lastFrom) return;
    await this.reply(this.lastFrom, text);
  }

  private async reply(to: string, text: string): Promise<void> {
    try {
      await this.rateLimiter.send(to, text);
    } catch (error) {
      this.logFn(`rate limit send failed: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  async connectionLost(): Promise<void> {
    this.turn = undefined;
    this.agentState = "idle";
  }

  // ============ Public API ============

  async start(): Promise<void> {
    await this.connect();
    await this.transport.start();
  }

  async shutdown(): Promise<void> {
    await this.onStop();
    await this.disconnect();
  }

  async getBridgeStatus(): Promise<{ uptime: number; allowedNumbers: number; provider: string }> {
    return {
      uptime: process.uptime(),
      allowedNumbers: this.options.config.allowedNumbers.size,
      provider: 'meta-cloud',
    };
  }
}

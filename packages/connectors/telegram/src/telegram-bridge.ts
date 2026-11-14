/**
 * Telegram Bridge — Extends BaseBridge from @gentle-dot/bridges-base
 * Uses grammY for Telegram Bot API communication
 */

import { readFileSync } from "node:fs";
import { BaseBridge, type BridgeConfig, type BridgeMessage, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig } from './config.js';
import { Bot, type Context, session, type SessionFlavor } from 'grammy';
import { NicknameStore } from './storage/nickname-store.js';

const SOURCE_LABEL = "📬 [Telegram] ";
const UNREACHABLE = "Gentle Dot no está disponible ahora.";
const MAX_NOTIFY_TEXT = 4000;

interface MySession {
  state: string;
  data: unknown;
}

interface MyContext extends Context {
  session?: MySession;
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

export interface TelegramBridgeOptions {
  config: {
    botToken: string;
    daemonUrl: string;
    tokenFile: string;
    allowedUsers: Set<number>;
    nicknameDb: string;
  };
  log(message: string): void;
  upload(file: Buffer, name: string, mime: string): Promise<string>;
}

export class TelegramBridge extends BaseBridge {
  private botToken: string;
  private bot: any;
  private nicknameStore: any;
  private uploadFn: (file: Buffer, name: string, mime: string) => Promise<string>;
  private options: any;
  private logFn: (message: string) => void;

  // State
  private chatId: number = 0;
  private historyId: string | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private connected = false;
  private shouldPoll = true;

  // Turn management
  private turns = new Map<string, { buffer: string; requestId: string }>();

  // Pending asks
  private asks = new Map<string, { ask: any; from: string }>();

  constructor(options: any) {
    // Read daemon's access token from token file for WebSocket authentication
    let daemonToken = '';
    try {
      daemonToken = require('node:fs').readFileSync(options.config.tokenFile, 'utf8').trim();
    } catch {
      // logFn not available yet, will log after super()
    }

    const bridgeConfig: any = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'telegram',
      connectorType: 'telegram',
      token: daemonToken, // Use daemon token for WebSocket auth
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'nickname_management',
        'multi_chat',
        'voice_transcription',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'telegram-bot-api',
        features: ['long_polling', 'send_message', 'nickname_management', 'multi_chat'],
      },
    };

    // @ts-ignore
    super({ ...bridgeConfig, token: daemonToken });

    this.options = options;
    this.logFn = options.log;
    this.uploadFn = options.upload ?? (async () => { throw new Error('Upload not implemented'); });
    this.botToken = options.config.botToken;

    this.bot = new Bot(options.config.botToken, {
      client: { timeoutSeconds: 60 },
    });

    this.nicknameStore = new NicknameStore(options.config.nicknameDb);
    this.chatId = [...options.config.allowedUsers][0] ?? 0;
    this.setupBot();

    if (!daemonToken) {
      this.logFn(`Warning: could not read daemon token from ${options.config.tokenFile}`);
    }
  }

  // ============ BaseBridge Abstract Methods ============

  override async onReady(): Promise<void> {
    this.logFn('Telegram bridge ready - starting long polling');
    this.startPolling();
  }

  override async onStop(): Promise<void> {
    this.logFn('Telegram bridge stopping');
    this.stopPolling();
    if (this.bot) {
      await this.bot.stop();
    }
  }

  // ============ BaseBridge Overrides ============

  // @ts-ignore
  protected sendHello(): void {
    const payload = {
      token: this.config.token,
      protocol: 1,
      capabilities: this.config.capabilities,
      connectorType: this.config.connectorType,
      connectorId: this.config.connectorId,
      metadata: this.config.metadata,
    };
    this.send('hello', payload);
  }

  protected handleConnectorMessage(message: any): void {
    this.dispatch(message);
  }

  private dispatch(message: { type: string; payload: unknown }): void {
    switch (message.type) {
      case 'ready': {
        const ready = message.payload as { sessionId: string };
        this.logFn(`Daemon ready, session: ${ready.sessionId}`);
        break;
      }
      case 'agent_state': {
        break;
      }
      case 'channel_notify': {
        break;
      }
      case 'command': {
        const payload = message.payload as { action: string; commandId: string; params: Record<string, unknown> };
        void this.handleCommand(payload);
        break;
      }
      case 'error': {
        const payload = message.payload as { code: string; message: string };
        if (payload.code === 'unauthorized') {
          this.logFn('Daemon rejected token, attempting re-auth');
          this.disconnect().then(() => this.connect());
        }
        break;
      }
      default:
        return;
    }
  }

  // ============ Telegram-Specific Methods ============

  private startPolling(): void {
    this.bot.start().catch((error: Error) => {
      this.logFn(`Polling error: ${error.message}`);
    });
  }

  private stopPolling(): void {
    this.bot.stop();
  }

  private setupBot(): void {
    this.bot.command('start', async (ctx: any) => {
      await ctx.reply('¡Hola! Soy tu bot de Gentle Dot. Usa /menu para ver las opciones.');
    });

    this.bot.command('menu', async (ctx: any) => {
      await ctx.reply('Menú principal:\n/start - Iniciar\n/menu - Este menú\n/stop - Detener\n/help - Ayuda');
    });

    this.bot.command('help', async (ctx: any) => {
      await ctx.reply('Comandos disponibles:\n/menu - Menú principal\n/stop - Detener\n/help - Esta ayuda');
    });

    this.bot.on('message:text', async (ctx: any) => {
      const text = ctx.message.text;
      if (text.startsWith('/')) return;
      
      this.send('channel_notify', {
        channelId: 'telegram',
        text: `📬 [Telegram] ${ctx.from?.first_name || 'Usuario'}: ${text}`,
      });
    });
  }

  // ============ Command Handling ============

  protected override async handleCommand(payload: any): Promise<void> {
    let result: any = {
      commandId: payload.commandId,
      success: false,
    };

    try {
      switch (payload.action) {
        case 'send_message': {
          const { chatId, text, parseMode } = payload.params as {
            chatId: string | number;
            text: string;
            parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
          };
          await this.bot.api.sendMessage(chatId, text, { parse_mode: parseMode });
          result = { commandId: payload.commandId, success: true };
          break;
        }
        case 'get_updates': {
          result = { commandId: payload.commandId, success: true, result: { updates: [] } };
          break;
        }
        case 'get_me': {
          const me = await this.bot.api.getMe();
          result = { commandId: payload.commandId, success: true, result: me };
          break;
        }
        default:
          result = {
            commandId: payload.commandId,
            success: false,
            error: `Unknown action: ${payload.action}`,
          };
      }
    } catch (e) {
      result = {
        commandId: payload.commandId,
        success: false,
        error: (e as Error).message,
      };
    }

    this.send('command_result', result);
  }

  // ============ Public API ============

  async start(): Promise<void> {
    // Ensure daemon token is current (read from token file)
    try {
      this.config.token = require('node:fs').readFileSync(this.options.config.tokenFile, 'utf8').trim();
    } catch {
      this.logFn(`Warning: could not read daemon token from ${this.options.config.tokenFile}`);
    }
    await this.connect();
  }

  async stop(): Promise<void> {
    await this.onStop();
    await this.disconnect();
  }

  async getBridgeStatus(): Promise<{
    uptime: number;
    connected: boolean;
    hasTokens: boolean;
    botUsername: string | null;
  }> {
    let botUsername: string | null = null;
    try {
      const me = await this.bot.api.getMe();
      return { uptime: process.uptime(), connected: true, hasTokens: true, botUsername: me.username };
    } catch {
      return { uptime: process.uptime(), connected: false, hasTokens: false, botUsername: null };
    }
  }
}

/**
 * Gmail Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Uses Gmail API with OAuth2 for real-time email notifications via history polling
 */

import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig } from './config.js';
import { GmailClient, extractTextFromMessage, getHeader } from './gmail-client.js';
import { GmailTokenStore, createOAuth2Client, getValidAccessToken, generateAuthUrl, exchangeCodeForTokens } from './auth/token-store.js';

const SOURCE_LABEL = "📧 [Gmail] ";
const UNREACHABLE = "Gentle Dot no está disponible ahora.";
const MAX_NOTIFY_TEXT = 4000;

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

export interface GmailBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class GmailBridge extends BaseBridge {
  private gmailClient: GmailClient;
  private tokenStore: GmailTokenStore;
  private oauth2Client: ReturnType<typeof createOAuth2Client>;
  private options: GmailBridgeOptions;
  private logFn: (message: string) => void;

  // State
  private historyId: string | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private connected = false;
  private shouldPoll = true;

  constructor(options: GmailBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'gmail',
      connectorType: 'gmail',
      token: '', // Will be set after OAuth
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'gmail_watch',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'gmail-api',
        features: ['history_polling', 'send_message', 'watch_labels'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
    this.tokenStore = new GmailTokenStore(options.config.tokenPath);
    this.oauth2Client = createOAuth2Client({
      clientId: options.config.oauth.clientId,
      clientSecret: options.config.oauth.clientSecret,
      redirectUri: options.config.oauth.redirectUri,
    });
    this.gmailClient = new GmailClient(
      {
        clientId: options.config.oauth.clientId,
        clientSecret: options.config.oauth.clientSecret,
        redirectUri: options.config.oauth.redirectUri,
      },
      this.tokenStore
    );
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Gmail bridge ready - starting history polling');
    this.connected = true;
    await this.startHistoryPolling();
  }

  async onStop(): Promise<void> {
    this.logFn('Gmail bridge stopping');
    this.connected = false;
    this.shouldPoll = false;
    this.stopHistoryPolling();
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

  protected override handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString()) as { type: string; payload: unknown; seq?: number; timestamp: number };
      this.dispatch(msg);
    } catch (e) {
      this.logFn(`Parse error: ${(e as Error).message}`);
    }
  }

  private dispatch(message: { type: string; payload: unknown }): void {
    switch (message.type) {
      case 'ready': {
        const ready = message.payload as ReadyPayload;
        this.logFn(`Daemon ready, session: ${ready.sessionId}`);
        this.updateDaemonToken();
        break;
      }
      case 'agent_state': {
        break;
      }
      case 'channel_notify': {
        break;
      }
      case 'command': {
        const payload = message.payload as CommandPayload;
        void this.handleCommand(payload);
        break;
      }
      case 'error': {
        const payload = message.payload as { code: string; message: string };
        if (payload.code === 'unauthorized') {
          this.logFn('Daemon rejected token, attempting re-auth');
          this.updateDaemonToken();
        }
        break;
      }
      default:
        return;
    }
  }

  private async updateDaemonToken(): Promise<void> {
    try {
      const accessToken = await getValidAccessToken(this.tokenStore, this.oauth2Client);
      this.config.token = accessToken;
      this.sendHello();
    } catch (e) {
      this.logFn(`Failed to update daemon token: ${(e as Error).message}`);
    }
  }

  // ============ Gmail-Specific Methods ============

  private async startHistoryPolling(): Promise<void> {
    this.shouldPoll = true;
    
    // Initial history ID fetch
    await this.fetchInitialHistoryId();
    
    // Start polling
    this.pollInterval = setInterval(() => {
      if (this.shouldPoll && this.connected) {
        void this.pollGmailHistory();
      }
    }, this.options.config.pollIntervalMs);

    // Initial poll
    await this.pollGmailHistory();
  }

  private stopHistoryPolling(): void {
    this.shouldPoll = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private async fetchInitialHistoryId(): Promise<void> {
    try {
      const accessToken = await getValidAccessToken(this.tokenStore, this.oauth2Client);
      this.oauth2Client.setCredentials({ access_token: accessToken });
      const gmail = (await import("googleapis")).google.gmail({ version: "v1", auth: this.oauth2Client });

      const profile = await gmail.users.getProfile({ userId: "me" });
      this.historyId = profile.data.historyId || null;

      if (!this.historyId) {
        this.logFn("No history ID available, will start from current");
      } else {
        this.logFn(`Initial historyId: ${this.historyId}`);
      }
    } catch (e) {
      this.logFn(`Failed to fetch initial historyId: ${(e as Error).message}`);
    }
  }

  private async pollGmailHistory(): Promise<void> {
    if (!this.historyId || !this.connected) return;

    try {
      const history = await this.gmailClient.getHistory(this.historyId);
      
      for (const event of history) {
        if (event.messagesAdded) {
          for (const msgAdded of event.messagesAdded) {
            if (msgAdded.message?.id) {
              await this.handleNewMessage(msgAdded.message.id);
            }
          }
        }
      }
      
      // Update historyId to latest
      if (history.length > 0) {
        const lastEvent = history[history.length - 1];
        if (lastEvent && 'historyId' in lastEvent) {
          this.historyId = lastEvent.historyId as string;
        }
      }
    } catch (e) {
      this.logFn(`Error polling Gmail history: ${(e as Error).message}`);
    }
  }

  private async handleNewMessage(messageId: string): Promise<void> {
    try {
      const message = await this.gmailClient.getMessage(messageId);
      if (!message) {
        this.logFn(`Failed to get message: ${messageId}`);
        return;
      }

      const text = extractTextFromMessage(message);
      const from = getHeader(message, "From") || "Unknown";
      const subject = getHeader(message, "Subject") || "(No subject)";
      const date = new Date(parseInt(message.internalDate)).toLocaleString();

      // Truncate if too long
      const notifyText = text.length > MAX_NOTIFY_TEXT 
        ? text.substring(0, MAX_NOTIFY_TEXT) + "..."
        : text;

      const channelNotify = {
        type: 'channel_notify',
        channelId: 'gmail',
        text: `${SOURCE_LABEL}${from}\n📅 ${date}\n📌 ${subject}\n\n${notifyText}`,
      };

      this.send(channelNotify.type, channelNotify);
      this.logFn(`Sent channel_notify for message: ${messageId}`);
    } catch (e) {
      this.logFn(`Error handling new message: ${(e as Error).message}`);
    }
  }

  // ============ Command Handling ============

  protected async handleCommand(payload: CommandPayload): Promise<void> {
    let result: CommandResultPayload = {
      commandId: payload.commandId,
      success: false,
    };

    try {
      switch (payload.action) {
        case 'send_message': {
          const { to, subject, body, threadId, inReplyTo } = payload.params as {
            to: string;
            subject: string;
            body: string;
            threadId?: string;
            inReplyTo?: string;
          };
          const messageId = await this.gmailClient.sendMessage({ to, subject, body, threadId, inReplyTo });
          result = {
            commandId: payload.commandId,
            success: !!messageId,
            result: { messageId },
          };
          break;
        }
        case 'list_messages': {
          const { query, maxResults } = payload.params as { query: string; maxResults?: number };
          const messages = await this.gmailClient.listMessages(query, maxResults);
          result = {
            commandId: payload.commandId,
            success: true,
            result: { messages },
          };
          break;
        }
        case 'get_message': {
          const { id } = payload.params as { id: string };
          const message = await this.gmailClient.getMessage(id);
          result = {
            commandId: payload.commandId,
            success: !!message,
            result: { message },
          };
          break;
        }
        case 'setup_watch': {
          const { webhookUrl, labelIds } = payload.params as { webhookUrl: string; labelIds?: string[] };
          const watchResult = await this.gmailClient.watch(webhookUrl, labelIds);
          result = {
            commandId: payload.commandId,
            success: true,
            result: watchResult,
          };
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

  // ============ OAuth2 Helpers ============

  /** Get authorization URL for OAuth2 flow */
  getAuthUrl(): string {
    return generateAuthUrl(this.oauth2Client, this.options.config.oauth.scopes);
  }

  /** Exchange authorization code for tokens */
  async handleOAuthCallback(code: string): Promise<void> {
    const tokens = await exchangeCodeForTokens(this.oauth2Client, code);
    this.tokenStore.save(tokens);
    this.logFn('OAuth tokens saved successfully');
    await this.updateDaemonToken();
  }

  // ============ Public API ============

  async start(): Promise<void> {
    // Load existing tokens if any
    const existingTokens = this.tokenStore.load();
    if (existingTokens) {
      this.oauth2Client.setCredentials(existingTokens);
      this.config.token = existingTokens.access_token;
    } else {
      this.logFn('No tokens found. OAuth flow required.');
      this.logFn(`Auth URL: ${this.getAuthUrl()}`);
    }

    await this.connect();
  }

  async shutdown(): Promise<void> {
    await this.onStop();
    await this.disconnect();
  }

  async getBridgeStatus(): Promise<{ 
    uptime: number; 
    connected: boolean; 
    hasTokens: boolean;
    historyId: string | null;
  }> {
    const tokens = this.tokenStore.load();
    return {
      uptime: process.uptime(),
      connected: this.connected,
      hasTokens: !!tokens,
      historyId: this.historyId,
    };
  }

  /** Manually trigger a history poll (for testing) */
  async triggerPoll(): Promise<void> {
    await this.pollGmailHistory();
  }
}
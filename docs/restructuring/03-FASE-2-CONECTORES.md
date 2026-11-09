# 🔌 Fase 2: 4 Conectores Nativos (via MCP)

## 🎯 Objetivo

Implementar 4 conectores que se conectan al daemon vía WebSocket (Bridge Protocol v1). **Los conectores usan MCP servers** - el daemon proxyea el tráfico MCP y maneja approvals via dialogs nativos (S25). No son daemons independientes.

---

## 📦 Estructura de Paquetes

```text
packages/
├── connectors/
│   ├── telegram/     # Conector Telegram (MCP server o bridge nativo)
│   ├── gmail/        # Conector Gmail (MCP server oficial)
│   ├── discord/      # Conector Discord (MCP server community)
│   └── whatsapp/     # Conector WhatsApp (2 modos: Baileys + Meta Cloud)
└── bridges/
    └── base/         # BaseBridge class reutilizable
```

> **Nota**: Según S18/S19, los conectores se gestionan via MCP servers en `<agentHome>/mcp.json`. El daemon proxyea el tráfico (S25.4) y maneja approvals via dialogs nativos (S25.3).

---

## 🏗️ BaseBridge (Compartido)

```typescript
// packages/bridges/base/src/base-bridge.ts

import { WebSocket } from 'ws';
import { BridgeToDaemon, DaemonToBridge } from '../../protocol';

export interface BridgeConfig {
  connectorId: string;
  type: 'telegram' | 'gmail' | 'discord' | 'whatsapp';
  daemonUrl: string;
  token: string;
  capabilities: string[];
  metadata?: Record<string, any>;
}

export abstract class BaseBridge {
  protected ws: WebSocket | null = null;
  protected config: BridgeConfig;
  protected reconnectAttempts = 0;
  protected maxReconnectAttempts = 10;
  protected reconnectDelay = 5000;
  protected seq = 0;
  protected pendingRequests = new Map<number, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }>();

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${this.config.daemonUrl}/ws?token=${this.config.token}`);

      this.ws.on('open', () => {
        console.log(`[${this.config.connectorId}] WebSocket connected`);
        this.sendHello();
      });

      this.ws.on('message', (data) => this.handleMessage(data));
      this.ws.on('close', () => this.handleClose());
      this.ws.on('error', (err) => this.handleError(err));

      const timeout = setTimeout(() => reject(new Error('Handshake timeout')), 10000);
      this.once('ready', () => {
        clearTimeout(timeout);
        this.startHeartbeat();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  protected sendHello(): void {
    this.send({
      type: 'hello',
      token: this.config.token,
      protocol: 1,
      capabilities: this.config.capabilities,
      connectorId: this.config.connectorId,
      connectorType: this.config.type,
      metadata: this.config.metadata
    });
  }

  protected startHeartbeat(): void {
    setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping', seq: this.seq++, timestamp: Date.now() });
      }
    }, 30000);
  }

  protected send(message: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  protected handleMessage(data: Buffer): void {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'ready':
          this.emit('ready', msg);
          break;
        case 'pong':
          break;
        case 'command_result':
          this.handleCommandResult(msg);
          break;
        case 'connector_event':
          this.handleConnectorEvent(msg);
          break;
        case 'error':
          console.error(`[${this.config.connectorId}] Error:`, msg);
          break;
      }
    } catch (e) {
      console.error('Parse error:', e);
    }
  }

  protected handleCommandResult(msg: any): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(msg.requestId);
      if (msg.success) {
        pending.resolve(msg.data);
      } else {
        pending.reject(new Error(msg.error?.message || 'Command failed'));
      }
    }
  }

  protected handleConnectorEvent(msg: any): void {
    console.log(`[${this.config.connectorId}] Event: ${msg.event}`);
  }

  protected sendCommand(command: string, params: any, timeout = 30000): Promise<any> {
    const requestId = Date.now() + Math.random();
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('Command timeout'));
      }, timeout);

      this.pendingRequests.set(requestId, { resolve, reject, timeout: timeoutHandle });

      this.send({
        type: 'connector_command',
        connectorId: this.config.connectorId,
        command,
        params,
        requestId
      });
    });
  }

  protected sendChannelNotify(channelId: string, text: string, requestId?: string): void {
    this.send({
      type: 'channel_notify',
      channelId,
      text,
      requestId
    });
  }

  protected sendConnectorEvent(event: string, payload: any): void {
    this.send({
      type: 'connector_event',
      event,
      payload,
      timestamp: Date.now()
    });
  }

  protected sendMessageSend(connectorId: string, message: any): void {
    this.send({
      type: 'message_send',
      connectorId,
      message
    });
  }

  protected handleClose(): void {
    console.log(`[${this.config.connectorId}] Disconnected, scheduling reconnect...`);
    this.scheduleReconnect();
  }

  protected handleError(err: Error): void {
    console.error(`[${this.config.connectorId}] Error:`, err);
  }

  protected scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[${this.config.connectorId}] Max reconnect attempts reached`);
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts) + Math.random() * 1000;
    this.reconnectAttempts++;

    setTimeout(() => {
      console.log(`[${this.config.connectorId}] Reconnecting... (attempt ${this.reconnectAttempts})`);
      this.start().catch(console.error);
    }, delay);
  }

  // Event emitter methods
  private listeners = new Map<string, Function[]>();
  on(event: string, listener: Function): void {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event)!.push(listener);
  }
  once(event: string, listener: Function): void {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    this.on(event, wrapper);
  }
  off(event: string, listener: Function): void {
    const arr = this.listeners.get(event);
    if (arr) this.listeners.set(event, arr.filter(l => l !== listener));
  }
  protected emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach(l => l(...args));
  }
}
```

---

## 📱 Conector Telegram

> **Enfoque**: Bridge nativo (no hay MCP oficial de Telegram). Usa Telegraf. El daemon lo ve como un bridge más.

### Archivos

```text
packages/connectors/telegram/
├── src/
│   ├── index.ts              # Entry point
│   ├── telegram-bridge.ts    # Extends BaseBridge
│   ├── bot/
│   │   ├── bot.ts            # Telegraf instance
│   │   ├── middleware.ts     # Logging, error handling
│   │   └── session.ts        # Session management
│   ├── commands/
│   │   ├── index.ts          # Command registry
│   │   ├── nickname.ts       # /nickname <name>
│   │   ├── status.ts         # /status
│   │   └── help.ts           # /help
│   ├── storage/
│   │   ├── nickname-store.ts # SQLite persistence
│   │   └── schema.sql        # DB schema
│   ├── handlers/
│   │   ├── message.ts        # messageCreate handler
│   │   ├── callback.ts       # callbackQuery handler
│   │   └── error.ts          # Error handler
│   └── types.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 1. index.ts (Entry Point)

```typescript
#!/usr/bin/env node
// packages/connectors/telegram/src/index.ts

import { TelegramBridge } from './telegram-bridge';
import { loadConfig } from '../config';

const config = loadConfig('telegram');

const bridge = new TelegramBridge({
  connectorId: 'telegram-1',
  type: 'telegram',
  daemonUrl: process.env.DAEMON_URL || 'ws://localhost:4317',
  token: process.env.TELEGRAM_BRIDGE_TOKEN || 'telegram-bridge-token',
  capabilities: [
    'channel_notify',
    'message_send',
    'connector_command',
    'nickname_management',
    'multi_chat'
  ]
});

bridge.start().catch(console.error);

process.on('SIGINT', async () => {
  console.log('[Telegram] Shutting down...');
  await bridge.stop();
  process.exit(0);
});
```

### 2. telegram-bridge.ts

```typescript
// packages/connectors/telegram/src/telegram-bridge.ts

import { Telegraf, Context, Markup } from 'telegraf';
import { BaseBridge } from '../../bridges/base/base-bridge';
import { NicknameStore } from './storage/nickname-store';
import { registerCommands } from './commands';

export class TelegramBridge extends BaseBridge {
  private bot: Telegraf;
  private nicknameStore: NicknameStore;

  constructor(config: any) {
    super({
      connectorId: 'telegram-1',
      type: 'telegram',
      daemonUrl: config.daemonUrl,
      token: config.token,
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'nickname_management',
        'multi_chat'
      ]
    });

    this.bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
    this.nicknameStore = new NicknameStore();
    this.setupBot();
  }

  private setupBot(): void {
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      console.log(`[Telegram] ${ctx.updateType} - ${Date.now() - start}ms`);
    });

    this.bot.catch((err, ctx) => {
      console.error('[Telegram] Error:', err);
    });

    registerCommands(this.bot, this.nicknameStore, this);

    this.bot.on('message', async (ctx) => await this.handleMessage(ctx));
    this.bot.on('callback_query', async (ctx) => await this.handleCallback(ctx));
  }

  async start(): Promise<void> {
    await this.nicknameStore.init();
    await super.start();
    await this.bot.launch();
    console.log('[Telegram] Bot started');
  }

  async stop(): Promise<void> {
    this.bot.stop();
    await super.stop();
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) return;

    const userId = ctx.from?.id.toString();
    const chatId = ctx.chat.id.toString();
    const text = ctx.message.text;

    const nickname = await this.nicknameStore.getByUserId(userId) || userId;

    this.sendConnectorEvent('message_received', {
      userId,
      chatId,
      nickname,
      text,
      timestamp: Date.now()
    });
  }

  private async handleCallback(ctx: Context): Promise<void> {
    await ctx.answerCbQuery();
  }

  async sendMessage(params: { chatId: string; text: string; parseMode?: string }): Promise<any> {
    try {
      const result = await this.bot.telegram.sendMessage(params.chatId, params.text, {
        parse_mode: params.parseMode
      });
      return { messageId: result.message_id, success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  async broadcast(params: { text: string; excludeChats?: string[] }): Promise<any> {
    return { sentCount: 0, failedChats: [] };
  }

  async getStatus(): Promise<any> {
    return {
      uptime: process.uptime(),
      chats: 0,
      users: this.nicknameStore.count(),
      memory: process.memoryUsage().heapUsed
    };
  }

  async getChats(): Promise<any[]> {
    return [];
  }

  async setNickname(userId: string, nickname: string): Promise<any> {
    try {
      await this.nicknameStore.set(userId, nickname);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}
```

---

## 📧 Conector Gmail (via MCP Oficial)

> **Enfoque**: Usar **MCP server oficial de Gmail** (S18). El daemon proxyea el MCP. El bridge solo maneja OAuth y webhook push.

### Archivos

```text
packages/connectors/gmail/
├── src/
│   ├── index.ts              # Entry point
│   ├── gmail-bridge.ts       # Extends BaseBridge (solo OAuth + webhook)
│   ├── auth/
│   │   ├── oauth.ts          # OAuth 2.0 flow + token refresh
│   │   ├── token-store.ts    # Persistencia refresh token
│   │   └── scopes.ts         # Definición de scopes
│   ├── webhook/
│   │   ├── handler.ts        # Express handler para webhook
│   │   ├── verification.ts   # Verificación webhook
│   │   └── parser.ts         # Parse notification
│   ├── storage/
│   │   └── token-store.ts    # SQLite/JSON para tokens
│   └── types.ts
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 1. index.ts (Entry Point)

```typescript
#!/usr/bin/env node
// packages/connectors/gmail/src/index.ts

import { GmailBridge } from './gmail-bridge';
import { loadConfig } from '../config';

const config = loadConfig('gmail');

const bridge = new GmailBridge({
  connectorId: 'gmail-1',
  type: 'gmail',
  daemonUrl: process.env.DAEMON_URL || 'ws://localhost:4317',
  token: process.env.GMAIL_BRIDGE_TOKEN || 'gmail-bridge-token',
  capabilities: [
    'channel_notify',    // Push notifications de emails
    'message_send',      // Enviar emails via daemon→MCP
    'connector_command', // OAuth, watch, labels
    'oauth_management'   // Refresh token, revoke
  ]
});

bridge.start().catch(console.error);

process.on('SIGINT', async () => {
  console.log('[Gmail] Shutting down...');
  await bridge.stop();
  process.exit(0);
});
```

### 2. gmail-bridge.ts (OAuth + Webhook únicamente)

```typescript
// packages/connectors/gmail/src/gmail-bridge.ts

import express from 'express';
import { BaseBridge } from '../../bridges/base/base-bridge';
import { OAuthManager } from './auth/oauth';
import { WebhookHandler } from './webhook/handler';
import { TokenStore } from './storage/token-store';

export class GmailBridge extends BaseBridge {
  private oauth: OAuthManager;
  private webhook: WebhookHandler;
  private tokenStore: TokenStore;
  private app: express.Express;

  constructor(config: any) {
    super({
      connectorId: 'gmail-1',
      type: 'gmail',
      daemonUrl: config.daemonUrl,
      token: config.token,
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'oauth_management'
      ]
    });

    this.tokenStore = new TokenStore();
    this.oauth = new OAuthManager(this.tokenStore);
    this.webhook = new WebhookHandler(this);
    this.app = express();
    this.setupWebhook();
  }

  private setupWebhook(): void {
    this.app.use(express.json());
    this.app.post('/webhook/gmail', this.webhook.handle.bind(this.webhook));
  }

  async start(): Promise<void> {
    await this.tokenStore.init();
    await this.oauth.ensureValidTokens();
    
    // Start webhook server
    const port = process.env.GMAIL_WEBHOOK_PORT || 3001;
    this.app.listen(port, () => {
      console.log(`[Gmail] Webhook server on port ${port}`);
    });

    // Setup Gmail API watch
    await this.setupWatch();
    
    await super.start();
  }

  private async setupWatch(): Promise<void> {
    // Daemon will call connector_command 'renew_watch' via MCP proxy
    // This bridge just ensures tokens are valid
    setInterval(async () => {
      await this.oauth.ensureValidTokens();
    }, 5 * 60 * 1000); // Check every 5 min
  }

  async stop(): Promise<void> {
    await super.stop();
  }

  // Called by daemon via MCP proxy for sending emails
  async sendEmail(params: any): Promise<any> {
    // Forward to daemon via connector_command
    return this.sendCommand('send_email', params);
  }

  // Called by daemon to renew watch
  async renewWatch(): Promise<any> {
    return this.sendCommand('renew_watch', {});
  }

  // Handle webhook notification from Gmail
  async handleNotification(notification: any): Promise<void> {
    const email = await this.fetchEmail(notification);
    this.sendChannelNotify(
      `gmail-${notification.emailAddress}`,
      this.formatEmailNotification(email),
      notification.historyId
    );
  }

  private async fetchEmail(notification: any) { /* ... */ }
  private formatEmailNotification(email: any) { /* ... */ }
}
```

### 3. auth/oauth.ts

```typescript
// packages/connectors/gmail/src/auth/oauth.ts

import { google } from 'googleapis';
import { TokenStore } from '../storage/token-store';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify'
];

export class OAuthManager {
  private oauth2Client: any;
  private tokenStore: TokenStore;

  constructor(tokenStore: TokenStore) {
    this.tokenStore = tokenStore;
    this.oauth2Client = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
      process.env.GMAIL_REDIRECT_URI || 'http://localhost:4317/oauth2callback'
    );
  }

  async ensureValidTokens(): Promise<void> {
    const emails = await this.tokenStore.list();
    for (const email of emails) {
      const tokens = await this.tokenStore.load(email);
      if (tokens && this.isExpired(tokens)) {
        await this.refreshToken(email, tokens.refresh_token);
      }
    }
  }

  private isExpired(tokens: any): boolean {
    return !tokens.expiry_date || tokens.expiry_date < Date.now() + 60000; // 1 min buffer
  }

  async refreshToken(email: string, refreshToken: string): Promise<void> {
    this.oauth2Client.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.oauth2Client.refreshAccessToken();
    
    await this.tokenStore.save(email, {
      ...credentials,
      refresh_token: refreshToken // Keep original refresh token
    });
    
    this.emit('oauth_refreshed', { email, expiry: credentials.expiry_date });
  }

  getAuthUrl(): string {
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
  }

  async handleCallback(code: string): Promise<void> {
    const { tokens } = await this.oauth2Client.getToken(code);
    await this.tokenStore.save(tokens);
  }
}
```

---

## 🎮 Conector Discord (via MCP Community)

> **Enfoque**: Usar **MCP server community de Discord** (S18). El daemon proxyea. Bridge maneja Slash Commands y eventos.

### Archivos

```text
packages/connectors/discord/
├── src/
│   ├── index.ts
│   ├── discord-bridge.ts
│   ├── bot/
│   │   ├── client.ts
│   │   ├── deploy-commands.ts
│   │   └── events.ts
│   ├── commands/
│   │   ├── status.ts
│   │   ├── send.ts
│   │   ├── connector.ts
│   │   └── help.ts
│   ├── permissions/
│   │   ├── roles.ts
│   │   └── checker.ts
│   └── handlers/
│       ├── interaction.ts
│       ├── message.ts
│       ├── ready.ts
│       └── error.ts
```

### Slash Commands (registrados via Discord.js)

```typescript
// packages/connectors/discord/src/commands/status.ts
import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { DiscordBridge } from '../discord-bridge';

export async function statusCommand(interaction: ChatInputCommandInteraction, bridge: DiscordBridge) {
  const status = await bridge.getSystemStatus();
  
  const embed = new EmbedBuilder()
    .setTitle('🤖 Gentle System Status')
    .setColor(status.daemon.connected ? 0x00ff00 : 0xff0000)
    .addFields(
      { name: '🔗 Daemon', value: status.daemon.connected ? 'Conectado' : 'Desconectado', inline: true },
      { name: '⏱️ Uptime', value: formatUptime(status.daemon.uptime), inline: true },
      { name: '🧠 Memoria', value: `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`, inline: true },
      { name: '🌐 Conectores', value: status.connectors.map(c => `${c.type}: ${c.status}`).join('\n') }
    )
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}
```

---

## 📱 Conector WhatsApp (2 Modos)

> **Modo 1**: Baileys (WebSocket auto-hosted, multi-device, QR)
> **Modo 2**: Meta Cloud API (Business API oficial, webhooks, plantillas HSM)

### Arquitectura Dual

```typescript
// packages/connectors/whatsapp/src/index.ts
export async function createWhatsAppBridge(config: WhatsAppConfig): Promise<WhatsAppBridge> {
  const modes = [];
  
  if (config.modes.baileys?.enabled) {
    const { BaileysBridge } = await import('./modes/baileys/baileys-bridge');
    modes.push(new BaileysBridge(config.modes.baileys));
  }
  
  if (config.modes.meta_cloud?.enabled) {
    const { MetaCloudBridge } = await import('./modes/meta-cloud/meta-bridge');
    modes.push(new MetaCloudBridge(config.modes.meta_cloud));
  }
  
  return new WhatsAppBridge(modes, config);
}

class WhatsAppBridge extends BaseBridge {
  private modes: Map<string, any> = new Map();
  
  async sendText(to: string, text: string): Promise<any> {
    // Prioridad: Meta Cloud > Baileys
    const primary = this.modes.get('meta-cloud') || this.modes.get('baileys');
    return primary.sendText(to, text);
  }
}
```

---

## ✅ Checklist Fase 2

| Conector | Build | Tests | Conecta Daemon | MCP Proxy | Funcionalidad Core |
| ---------- | ------- | ------- | ---------------- | ----------- | ------------------- |
| Telegram | ⬜ | ⬜ | ⬜ | N/A (bridge nativo) | Nickname + Multi-chat |
| Gmail | ⬜ | ⬜ | ⬜ | ✅ MCP Oficial | OAuth + Webhook + Send |
| Discord | ⬜ | ⬜ | ⬜ | ✅ MCP Community | Slash Commands + Events |
| WhatsApp Baileys | ⬜ | ⬜ | ⬜ | N/A (bridge nativo) | QR + Multi-device |
| WhatsApp Meta | ⬜ | ⬜ | ⬜ | ✅ MCP Oficial | Webhooks + Templates |

---

## 🚫 Reglas de Oro (ver 15-REGLAS-ORO.md)

- **Conectores = Bridges, no Daemons** → clientes WebSocket al daemon:4317
- **MCP donde exista** → daemon proxyea tráfico (S25.4)
- **Approvals via daemon** → dialogs nativos (S25.3)
- **Tokens en Keychain/Env** → nunca en código
- **No modificar Gentle Shell** → solo bridges conectan al daemon
- **Engram global** → project `gentle-dot`

---

## 🔗 Próximo Paso

→ [04-FASE-3-INTEGRACION.md](./04-FASE-3-INTEGRACION.md)

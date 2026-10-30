/**
 * Discord Webhook integration for Gentle Dot.
 * Sends notifications to Discord channels via webhook URLs.
 */

import { randomUUID } from 'node:crypto';

export interface DiscordWebhookConfig {
  /** Webhook URL from Discord channel settings */
  webhookUrl: string;
  /** Default username for messages */
  username?: string;
  /** Default avatar URL */
  avatarUrl?: string;
  /** Whether this webhook is enabled */
  enabled: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  footer?: {
    text: string;
    icon_url?: string;
  };
  author?: {
    name: string;
    url?: string;
    icon_url?: string;
  };
  fields?: Array<{
    name: string;
    value: string;
    inline?: boolean;
  }>;
  thumbnail?: { url: string };
  image?: { url: string };
}

export interface DiscordWebhookMessage {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse?: ('roles' | 'users' | 'everyone')[];
    roles?: string[];
    users?: string[];
  };
  components?: unknown[];
}

export interface DiscordWebhookResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

const DEFAULT_USERNAME = 'Gentle Dot';
const DEFAULT_AVATAR = 'https://gentlemanprogramming.com/favicon.ico';

/**
 * DiscordWebhook class for sending messages to Discord via webhook.
 */
export class DiscordWebhook {
  private config: DiscordWebhookConfig;
  private abortController: AbortController | null = null;

  constructor(config: DiscordWebhookConfig) {
    this.config = {
      username: DEFAULT_USERNAME,
      avatarUrl: DEFAULT_AVATAR,
      ...config,
    };
  }

  /**
   * Send a simple text message.
   */
  async send(content: string, options?: {
    username?: string;
    avatarUrl?: string;
  }): Promise<DiscordWebhookResult> {
    return this.sendRaw({
      content,
      username: options?.username || this.config.username,
      avatar_url: options?.avatarUrl || this.config.avatarUrl,
    });
  }

  /**
   * Send an embed message (rich formatting).
   */
  async sendEmbed(embed: DiscordEmbed, options?: {
    content?: string;
    username?: string;
    avatarUrl?: string;
  }): Promise<DiscordWebhookResult> {
    return this.sendRaw({
      content: options?.content,
      username: options?.username || this.config.username,
      avatar_url: options?.avatarUrl || this.config.avatarUrl,
      embeds: [embed],
    });
  }

  /**
   * Send multiple embeds.
   */
  async sendEmbeds(embeds: DiscordEmbed[], options?: {
    content?: string;
    username?: string;
    avatarUrl?: string;
  }): Promise<DiscordWebhookResult> {
    return this.sendRaw({
      content: options?.content,
      username: options?.username || this.config.username,
      avatar_url: options?.avatarUrl || this.config.avatarUrl,
      embeds,
    });
  }

  /**
   * Send a notification with standardized format for Gentle Dot.
   */
  async notify(notification: {
    title: string;
    description: string;
    level: 'info' | 'success' | 'warning' | 'error';
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    url?: string;
  }): Promise<DiscordWebhookResult> {
    const colors = {
      info: 0x3498db,     // blue
      success: 0x2ecc71,  // green
      warning: 0xf39c12,  // orange
      error: 0xe74c3c,    // red
    };

    const emojis = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌',
    };

    const embed: DiscordEmbed = {
      title: `${emojis[notification.level]} ${notification.title}`,
      description: notification.description,
      color: colors[notification.level],
      timestamp: new Date().toISOString(),
      url: notification.url,
      footer: {
        text: 'Gentle Dot',
        icon_url: this.config.avatarUrl || DEFAULT_AVATAR,
      },
      fields: notification.fields?.map(f => ({
        name: f.name,
        value: f.value,
        inline: f.inline ?? true,
      })),
    };

    return this.sendEmbed(embed);
  }

  /**
   * Send a task/system status update.
   */
  async sendStatus(status: {
    service: string;
    status: 'online' | 'offline' | 'degraded' | 'maintenance';
    message?: string;
    details?: Record<string, string>;
  }): Promise<DiscordWebhookResult> {
    const statusEmojis = {
      online: '🟢',
      offline: '🔴',
      degraded: '🟡',
      maintenance: '🔧',
    };

    const statusColors = {
      online: 0x2ecc71,
      offline: 0xe74c3c,
      degraded: 0xf39c12,
      maintenance: 0x3498db,
    };

    const fields = [
      { name: 'Service', value: status.service, inline: true },
      { name: 'Status', value: `${statusEmojis[status.status]} ${status.status}`, inline: true },
    ];

    if (status.message) {
      fields.push({ name: 'Message', value: status.message, inline: false });
    }

    if (status.details) {
      for (const [key, value] of Object.entries(status.details)) {
        fields.push({ name: key, value, inline: true });
      }
    }

    return this.sendEmbed({
      title: `${statusEmojis[status.status]} Service Status: ${status.service}`,
      color: statusColors[status.status],
      timestamp: new Date().toISOString(),
      fields,
      footer: { text: 'Gentle Dot Monitoring' },
    });
  }

  /**
   * Low-level send with full control.
   */
  private async sendRaw(message: DiscordWebhookMessage): Promise<DiscordWebhookResult> {
    if (!this.config.enabled || !this.config.webhookUrl) {
      return { success: false, error: 'Webhook not configured or disabled' };
    }

    this.abortController = new AbortController();
    const timeoutId = setTimeout(() => this.abortController?.abort(), 10000);

    try {
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Gentle-Dot/1.0',
        },
        body: JSON.stringify(message),
        signal: this.abortController.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Discord API error ${response.status}: ${errorText}`,
        };
      }

      // Discord returns 204 No Content on success, but sometimes includes message ID in headers
      const messageId = response.headers.get('x-discord-message-id') || undefined;
      return { success: true, messageId };
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        return { success: false, error: 'Request timeout' };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Test the webhook connection.
   */
  async test(): Promise<DiscordWebhookResult> {
    return this.send('🔧 Gentle Dot webhook test — connection successful!');
  }

  /**
   * Update configuration.
   */
  updateConfig(config: Partial<DiscordWebhookConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration (without sensitive data).
   */
  getConfig(): Omit<DiscordWebhookConfig, 'webhookUrl'> & { hasWebhook: boolean } {
    return {
      username: this.config.username,
      avatarUrl: this.config.avatarUrl,
      enabled: this.config.enabled,
      hasWebhook: !!this.config.webhookUrl,
    };
  }
}

/**
 * Create a DiscordWebhook from environment variables.
 * Expected env vars:
 * - DISCORD_WEBHOOK_URL (required)
 * - DISCORD_WEBHOOK_USERNAME (optional)
 * - DISCORD_WEBHOOK_AVATAR (optional)
 * - DISCORD_WEBHOOK_ENABLED (optional, default true)
 */
export function createDiscordWebhookFromEnv(): DiscordWebhook | null {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[DiscordWebhook] DISCORD_WEBHOOK_URL not set, webhook disabled');
    return null;
  }

  return new DiscordWebhook({
    webhookUrl,
    username: process.env.DISCORD_WEBHOOK_USERNAME,
    avatarUrl: process.env.DISCORD_WEBHOOK_AVATAR,
    enabled: process.env.DISCORD_WEBHOOK_ENABLED !== 'false',
  });
}

/**
 * Multi-webhook manager for sending to multiple channels.
 */
export class DiscordWebhookManager {
  private webhooks: Map<string, DiscordWebhook> = new Map();

  add(name: string, webhook: DiscordWebhook): void {
    this.webhooks.set(name, webhook);
  }

  remove(name: string): boolean {
    return this.webhooks.delete(name);
  }

  get(name: string): DiscordWebhook | undefined {
    return this.webhooks.get(name);
  }

  async sendToAll(message: DiscordWebhookMessage): Promise<Map<string, DiscordWebhookResult>> {
    const results = new Map<string, DiscordWebhookResult>();
    for (const [name, webhook] of this.webhooks) {
      results.set(name, await webhook['sendRaw'](message));
    }
    return results;
  }

  async notifyAll(notification: {
    title: string;
    description: string;
    level: 'info' | 'success' | 'warning' | 'error';
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    url?: string;
  }): Promise<Map<string, DiscordWebhookResult>> {
    const results = new Map<string, DiscordWebhookResult>();
    for (const [name, webhook] of this.webhooks) {
      results.set(name, await webhook.notify(notification));
    }
    return results;
  }

  async testAll(): Promise<Map<string, DiscordWebhookResult>> {
    const results = new Map<string, DiscordWebhookResult>();
    for (const [name, webhook] of this.webhooks) {
      results.set(name, await webhook.test());
    }
    return results;
  }

  list(): string[] {
    return Array.from(this.webhooks.keys());
  }
}

export const globalWebhookManager = new DiscordWebhookManager();
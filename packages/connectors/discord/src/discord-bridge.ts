/**
 * Discord Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Uses discord.js to connect to Discord and forwards events to the daemon
 */

import { Client, GatewayIntentBits, Partials, Events, Message, TextChannel, ThreadChannel, GuildMember, User, ThreadAutoArchiveDuration, type MessageReaction, type PartialMessageReaction, type PartialUser, type PartialMessage, type MessageReactionEventDetails } from "discord.js";
import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "💬 [Discord] ";
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

export interface DiscordBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class DiscordBridge extends BaseBridge {
  private discord: Client;
  private options: DiscordBridgeOptions;
  private logFn: (message: string) => void;

  // State
  private turn: Turn | undefined;
  private ask: PendingAsk | undefined;
  private agentState = "idle";
  private lastFrom: string | undefined;
  private connected = false;

  constructor(options: DiscordBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'discord',
      connectorType: 'discord',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'discord_events',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'discord-js',
        features: ['message_events', 'reaction_events', 'thread_events', 'member_events'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;

    this.discord = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.ThreadMember],
    });

    this.setupDiscordEvents();
  }

  private setupDiscordEvents(): void {
    this.discord.on(Events.ClientReady, (client) => {
      this.logFn(`Discord connected as ${client.user.tag}`);
      this.connected = true;
    });

    this.discord.on(Events.MessageCreate, (message: Message) => this.onMessageCreate(message));
    this.discord.on(Events.MessageUpdate, (oldMessage: Message | PartialMessage | null, newMessage: Message) => this.onMessageUpdate(oldMessage, newMessage));
    this.discord.on(Events.MessageDelete, (message: Message | PartialMessage | null) => this.onMessageDelete(message));

    // Reaction events have 3 parameters in discord.js v14
    this.discord.on(Events.MessageReactionAdd, (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, _details: MessageReactionEventDetails) => this.onReactionAdd(reaction, user));
    this.discord.on(Events.MessageReactionRemove, (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser, _details: MessageReactionEventDetails) => this.onReactionRemove(reaction, user));

    this.discord.on(Events.ThreadCreate, (thread: ThreadChannel) => this.onThreadCreate(thread));

    this.discord.on(Events.GuildMemberAdd, (member: GuildMember) => this.onGuildMemberAdd(member));

    this.discord.on(Events.Error, (error) => this.logFn(`Discord error: ${(error as Error).message}`));
    this.discord.on(Events.Warn, (warning) => this.logFn(`Discord warning: ${warning}`));
  }

  async onReady(): Promise<void> {
    this.logFn('Discord bridge ready - Discord client connected');
    this.connected = true;
    await this.discord.login(this.options.config.discordToken);
  }

  async onStop(): Promise<void> {
    this.logFn('Discord bridge stopping');
    this.connected = false;
    await this.discord.destroy();
  }

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
          // Re-auth: clean reconnect re-hello after the daemon cleaned up the old registration.
          void this.disconnect().then(() => this.connect());
        }
        break;
      }
      default:
        return;
    }
  }


  // ============ Discord Event Handlers ============

  private onMessageCreate(message: Message): void {
    if (!this.shouldForward(message)) return;
    this.forwardMessage('message_create', message);
  }

  private onMessageUpdate(oldMessage: Message | PartialMessage | null, newMessage: Message): void {
    if (!oldMessage || !this.shouldForward(newMessage)) return;
    if (oldMessage.content === newMessage.content) return;
    this.forwardMessage('message_update', newMessage, { oldContent: oldMessage.content ?? "" });
  }

  private onMessageDelete(message: Message | PartialMessage | null): void {
    if (!message || !this.shouldForward(message)) return;
    const channelId = message.channelId;
    const guildId = message.guildId ?? undefined;
    this.sendConnectorEvent('message_delete', { messageId: message.id, channelId, guildId });
  }

  private onReactionAdd(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): void {
    if (reaction.partial || user.bot) return;
    const message = reaction.message;
    if (!message || !this.shouldForward(message)) return;
    this.sendConnectorEvent('reaction_add', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      userId: user.id,
      emoji: {
        name: reaction.emoji.name,
        id: reaction.emoji.id,
        animated: reaction.emoji.animated,
      },
    });
  }

  private onReactionRemove(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): void {
    if (reaction.partial || user.bot) return;
    const message = reaction.message;
    if (!message || !this.shouldForward(message)) return;
    this.sendConnectorEvent('reaction_remove', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      userId: user.id,
      emoji: {
        name: reaction.emoji.name,
        id: reaction.emoji.id,
        animated: reaction.emoji.animated,
      },
    });
  }

  private onThreadCreate(thread: ThreadChannel): void {
    if (!this.shouldForward(thread)) return;
    const channelId = thread.parentId || thread.id;
    this.sendConnectorEvent('thread_create', {
      id: thread.id,
      channelId,
      guildId: thread.guildId,
      name: thread.name,
      type: thread.type,
      ownerId: thread.ownerId,
      parentId: thread.parentId,
    });
  }

  private onGuildMemberAdd(member: GuildMember): void {
    if (!this.shouldForward(member)) return;
    this.sendConnectorEvent('guild_member_add', {
      user: {
        id: member.user.id,
        username: member.user.username,
        discriminator: member.user.discriminator,
        bot: member.user.bot,
      },
      guildId: member.guild.id,
      joinedAt: member.joinedAt?.toISOString() || new Date().toISOString(),
      roles: Array.from(member.roles.cache.keys()),
    });
  }

  private shouldForward(messageOrChannel: Message | PartialMessage | ThreadChannel | GuildMember | null): boolean {
    if (!messageOrChannel) return false;

    let channelId: string | undefined;
    let guildId: string | undefined;

    if (messageOrChannel instanceof Message) {
      channelId = messageOrChannel.channelId;
      guildId = messageOrChannel.guildId ?? undefined;
      if (messageOrChannel.author.bot) return false;
    } else if (messageOrChannel instanceof ThreadChannel) {
      channelId = messageOrChannel.parentId || messageOrChannel.id;
      guildId = messageOrChannel.guildId;
    } else if (messageOrChannel instanceof GuildMember) {
      guildId = messageOrChannel.guild.id;
    }

    if (channelId && this.options.config.allowedChannelIds.length > 0) {
      if (!this.options.config.allowedChannelIds.includes(channelId)) return false;
    }
    if (guildId && this.options.config.allowedGuildIds.length > 0) {
      if (!this.options.config.allowedGuildIds.includes(guildId)) return false;
    }

    return true;
  }

  private forwardMessage(type: string, message: Message, extra?: { oldContent?: string }): void {
    const channelId = message.channelId;
    const guildId = message.guildId ?? undefined;
    const author = message.author;

    const payload = {
      type,
      message: {
        id: message.id,
        channelId,
        guildId,
        author: {
          id: author.id,
          username: author.username,
          discriminator: author.discriminator,
          bot: author.bot,
          avatar: author.avatar,
        },
        content: message.content,
        timestamp: message.createdTimestamp.toString(),
        editedTimestamp: message.editedTimestamp?.toString() || null,
        attachments: Array.from(message.attachments.values()).map(a => ({
          id: a.id,
          filename: a.name,
          contentType: a.contentType,
          size: a.size,
          url: a.url,
          proxyUrl: a.proxyURL,
          width: a.width,
          height: a.height,
        })),
        embeds: message.embeds,
        reactions: Array.from(message.reactions.cache.values()).map(r => ({
          emoji: {
            name: r.emoji.name,
            id: r.emoji.id,
            animated: r.emoji.animated,
          },
          count: r.count,
          me: r.me,
        })),
        replyTo: message.reference?.messageId || null,
      },
      ...extra,
    };

    this.sendConnectorEvent(type, payload);
  }

  public sendConnectorEvent(event: string, data: unknown): void {
    const payload: ChannelNotifyPayload = {
      channelId: 'discord',
      event,
      data,
    };
    this.send('channel_notify', payload);
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
          const { channelId, content } = payload.params as { channelId: string; content: string };
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
          const sent = await channel.send(content);
          result = { commandId: payload.commandId, success: true, result: { messageId: sent.id } };
          break;
        }
        case 'send_embed': {
          const { channelId, embed } = payload.params as { channelId: string; embed: any };
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
          const sent = await channel.send({ embeds: [embed] });
          result = { commandId: payload.commandId, success: true, result: { messageId: sent.id } };
          break;
        }
        case 'get_channel': {
          const { channelId } = payload.params as { channelId: string };
          const channel = await this.discord.channels.fetch(channelId);
          result = { commandId: payload.commandId, success: true, result: { channel: channel?.toJSON() } };
          break;
        }
        case 'get_guild': {
          const { guildId } = payload.params as { guildId: string };
          const guild = await this.discord.guilds.fetch(guildId);
          result = { commandId: payload.commandId, success: true, result: { guild: guild?.toJSON() } };
          break;
        }
        case 'create_thread': {
          const { channelId, name, autoArchiveDuration } = payload.params as {
            channelId: string;
            name: string;
            autoArchiveDuration?: ThreadAutoArchiveDuration;
          };
          const channel = await this.discord.channels.fetch(channelId) as TextChannel;
          if (!channel || !channel.isTextBased()) throw new Error('Channel not found or not text-based');
          const thread = await channel.threads.create({ name, autoArchiveDuration: autoArchiveDuration || ThreadAutoArchiveDuration.OneHour });
          result = { commandId: payload.commandId, success: true, result: { threadId: thread.id } };
          break;
        }
        default:
          result = { commandId: payload.commandId, success: false, error: `Unknown action: ${payload.action}` };
      }
    } catch (e) {
      result = { commandId: payload.commandId, success: false, error: (e as Error).message };
    }

    this.send('command_result', result);
  }

  // ============ Public API ============

  async start(): Promise<void> {
    try {
      const fs = await import("fs");
      const token = fs.readFileSync(this.options.config.tokenFile, "utf8").trim();
      this.config.token = token;
    } catch (e) {
      this.logFn(`Warning: Could not read daemon token file: ${(e as Error).message}`);
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
    discordConnected: boolean;
    guilds: number;
    channels: number;
  }> {
    return {
      uptime: process.uptime(),
      connected: this.connected,
      discordConnected: this.discord.isReady(),
      guilds: this.discord.guilds.cache.size,
      channels: this.discord.channels.cache.size,
    };
  }
}
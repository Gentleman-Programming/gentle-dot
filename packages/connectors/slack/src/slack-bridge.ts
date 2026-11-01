/**
 * Slack Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Connects to Slack via official MCP server (Socket Mode)
 */

import { spawn, ChildProcess } from "node:child_process";
import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "💬 [Slack] ";
const UNREACHABLE = "Gentle Dot no está disponible ahora.";

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

export interface SlackBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class SlackBridge extends BaseBridge {
  private mcpProcess: ChildProcess | null = null;
  private options: SlackBridgeOptions;
  private logFn: (message: string) => void;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private connected = false;

  constructor(options: SlackBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'slack',
      connectorType: 'slack',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'slack_events',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'slack-mcp',
        features: ['message_events', 'reaction_events', 'channel_events', 'member_events', 'file_events'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Slack bridge ready - starting MCP server');
    this.connected = true;
    await this.startMcpServer();
  }

  async onStop(): Promise<void> {
    this.logFn('Slack bridge stopping');
    this.connected = false;
    await this.stopMcpServer();
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
      this.sendHello();
    } catch (e) {
      this.logFn(`Failed to update daemon token: ${(e as Error).message}`);
    }
  }

  // ============ MCP Server Management ============

  private async startMcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { mcpCommand, mcpArgs } = this.options.config;
      this.logFn(`Starting Slack MCP server: ${mcpCommand} ${mcpArgs.join(" ")}`);

      this.mcpProcess = spawn(mcpCommand, mcpArgs, {
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: this.options.config.botToken,
          SLACK_APP_TOKEN: this.options.config.appToken,
          SLACK_SIGNING_SECRET: this.options.config.signingSecret,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';

      this.mcpProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        this.processMcpBuffer(buffer);
      });

      this.mcpProcess.stderr?.on('data', (data: Buffer) => {
        this.logFn(`[Slack MCP] ${data.toString().trim()}`);
      });

      this.mcpProcess.on('error', (error) => {
        this.logFn(`MCP server error: ${error.message}`);
        this.connected = false;
        reject(error);
      });

      this.mcpProcess.on('exit', (code, signal) => {
        this.logFn(`MCP server exited: code=${code}, signal=${signal}`);
        this.connected = false;
        this.mcpProcess = null;
      });

      // Give the server time to start
      setTimeout(() => {
        this.logFn('Slack MCP server started');
        resolve();
      }, 2000);
    });
  }

  private processMcpBuffer(buffer: string): string {
    const lines = buffer.split('\n');
    const incomplete = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);
        this.handleMcpMessage(message);
      } catch (e) {
        this.logFn(`MCP parse error: ${(e as Error).message}`);
      }
    }

    return incomplete;
  }

  private handleMcpMessage(message: any): void {
    // Handle MCP responses
    if (message.id && this.pendingRequests.has(message.id)) {
      const { resolve, reject, timeout } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      clearTimeout(timeout);

      if (message.error) {
        reject(new Error(message.error.message || 'MCP error'));
      } else {
        resolve(message.result);
      }
      return;
    }

    // Handle MCP notifications (events from Slack)
    if (message.method) {
      this.handleMcpNotification(message);
    }
  }

  private handleMcpNotification(message: { method: string; params?: any }): void {
    const { method, params } = message;

    // Map Slack MCP notifications to channel_notify events
    switch (method) {
      case 'slack/message_posted':
      case 'slack/message_updated':
      case 'slack/message_deleted': {
        const event = params?.event;
        if (event && this.shouldForwardChannel(event.channel)) {
          const action = (method.split('_').pop() || '').toUpperCase();
          this.sendConnectorEvent('message_event', {
            action,
            message: {
              ts: event.ts,
              channel: event.channel,
              user: event.user,
              text: event.text,
              thread_ts: event.thread_ts,
              subtype: event.subtype,
              blocks: event.blocks,
            },
          });
        }
        break;
      }
      case 'slack/reaction_added':
      case 'slack/reaction_removed': {
        const event = params?.event;
        if (event && this.shouldForwardChannel(event.item?.channel)) {
          this.sendConnectorEvent('reaction_event', {
            action: method.includes('added') ? 'added' : 'removed',
            reaction: {
              name: event.reaction,
              item: event.item,
              user: event.user,
            },
          });
        }
        break;
      }
      case 'slack/channel_created':
      case 'slack/channel_deleted':
      case 'slack/channel_archive':
      case 'slack/channel_unarchive': {
        const channel = params?.channel;
        if (channel && this.shouldForwardChannel(channel.id)) {
          const action = (method.split('_').pop() || '').toUpperCase();
          this.sendConnectorEvent('channel_event', {
            action: action === 'ARCHIVE' ? 'archived' : action === 'UNARCHIVE' ? 'unarchived' : action.toLowerCase(),
            channel: {
              id: channel.id,
              name: channel.name,
              is_private: channel.is_private,
              is_shared: channel.is_shared,
              creator: channel.creator,
            },
          });
        }
        break;
      }
      case 'slack/member_joined_channel':
      case 'slack/member_left_channel': {
        const event = params?.event;
        if (event && this.shouldForwardChannel(event.channel)) {
          this.sendConnectorEvent('member_event', {
            action: method.includes('joined') ? 'joined' : 'left',
            member: {
              user: event.user,
              channel: event.channel,
            },
          });
        }
        break;
      }
      case 'slack/file_shared':
      case 'slack/file_created':
      case 'slack/file_deleted': {
        const file = params?.file;
        if (file && this.shouldForwardChannel(file.channels?.[0])) {
          const action = (method.split('_').pop() || '').toUpperCase();
          this.sendConnectorEvent('file_event', {
            action,
            file: {
              id: file.id,
              name: file.name,
              title: file.title,
              mimetype: file.mimetype,
              size: file.size,
              url: file.url_private,
              channels: file.channels,
            },
          });
        }
        break;
      }
      case 'slack/team_join': {
        const user = params?.user;
        if (user) {
          this.sendConnectorEvent('team_event', {
            action: 'joined',
            user: {
              id: user.id,
              name: user.name,
              real_name: user.real_name,
              email: user.profile?.email,
            },
          });
        }
        break;
      }
      case 'slack/user_change': {
        const user = params?.user;
        if (user) {
          this.sendConnectorEvent('user_event', {
            action: 'updated',
            user: {
              id: user.id,
              name: user.name,
              real_name: user.real_name,
              email: user.profile?.email,
              status_text: user.profile?.status_text,
            },
          });
        }
        break;
      }
      default:
        this.logFn(`Unhandled Slack MCP notification: ${method}`);
    }
  }

  private shouldForwardChannel(channelId: string | undefined): boolean {
    if (!channelId) return true;
    if (this.options.config.allowedChannelIds.length === 0) return true;
    return this.options.config.allowedChannelIds.includes(channelId);
  }

  private async stopMcpServer(): Promise<void> {
    if (this.mcpProcess) {
      this.mcpProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        this.mcpProcess!.once('exit', () => resolve());
        setTimeout(resolve, 5000);
      });
      this.mcpProcess = null;
    }
  }

  // ============ MCP Request/Response ============


  private mcpRequest(method: string, params: any): Promise<any> {
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, 30000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      this.mcpProcess?.stdin?.write(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      }) + '\n');
    });
  }

  // ============ Command Handling ============

  protected async handleCommand(payload: CommandPayload): Promise<void> {
    let result: CommandResultPayload = {
      commandId: payload.commandId,
      success: false,
    };

    try {
      switch (payload.action) {
        // Message commands
        case 'slack_post_message': {
          const { channel, text, blocks, thread_ts } = payload.params as {
            channel: string;
            text?: string;
            blocks?: any[];
            thread_ts?: string;
          };
          const message = await this.mcpRequest('slack/post_message', { channel, text, blocks, thread_ts });
          result = { commandId: payload.commandId, success: true, result: { message } };
          break;
        }
        case 'slack_update_message': {
          const { channel, ts, text, blocks } = payload.params as {
            channel: string;
            ts: string;
            text?: string;
            blocks?: any[];
          };
          const message = await this.mcpRequest('slack/update_message', { channel, ts, text, blocks });
          result = { commandId: payload.commandId, success: true, result: { message } };
          break;
        }
        case 'slack_delete_message': {
          const { channel, ts } = payload.params as { channel: string; ts: string };
          await this.mcpRequest('slack/delete_message', { channel, ts });
          result = { commandId: payload.commandId, success: true, result: { deleted: true } };
          break;
        }
        case 'slack_get_message': {
          const { channel, ts } = payload.params as { channel: string; ts: string };
          const message = await this.mcpRequest('slack/get_message', { channel, ts });
          result = { commandId: payload.commandId, success: true, result: { message } };
          break;
        }
        case 'slack_get_thread_replies': {
          const { channel, ts, limit } = payload.params as { channel: string; ts: string; limit?: number };
          const replies = await this.mcpRequest('slack/get_thread_replies', { channel, ts, limit });
          result = { commandId: payload.commandId, success: true, result: { messages: replies } };
          break;
        }

        // Reaction commands
        case 'slack_add_reaction': {
          const { channel, timestamp, name } = payload.params as { channel: string; timestamp: string; name: string };
          await this.mcpRequest('slack/add_reaction', { channel, timestamp, name });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }
        case 'slack_remove_reaction': {
          const { channel, timestamp, name } = payload.params as { channel: string; timestamp: string; name: string };
          await this.mcpRequest('slack/remove_reaction', { channel, timestamp, name });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }

        // Channel commands
        case 'slack_create_channel': {
          const { name, is_private } = payload.params as { name: string; is_private?: boolean };
          const channel = await this.mcpRequest('slack/create_channel', { name, is_private });
          result = { commandId: payload.commandId, success: true, result: { channel } };
          break;
        }
        case 'slack_archive_channel': {
          const { channel } = payload.params as { channel: string };
          await this.mcpRequest('slack/archive_channel', { channel });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }
        case 'slack_unarchive_channel': {
          const { channel } = payload.params as { channel: string };
          await this.mcpRequest('slack/unarchive_channel', { channel });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }
        case 'slack_get_channel': {
          const { channel } = payload.params as { channel: string };
          const channelInfo = await this.mcpRequest('slack/get_channel', { channel });
          result = { commandId: payload.commandId, success: true, result: { channel: channelInfo } };
          break;
        }
        case 'slack_list_channels': {
          const { exclude_archived, limit, cursor } = payload.params as { exclude_archived?: boolean; limit?: number; cursor?: string };
          const channels = await this.mcpRequest('slack/list_channels', { exclude_archived, limit, cursor });
          result = { commandId: payload.commandId, success: true, result: { channels } };
          break;
        }
        case 'slack_join_channel': {
          const { channel } = payload.params as { channel: string };
          await this.mcpRequest('slack/join_channel', { channel });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }
        case 'slack_leave_channel': {
          const { channel } = payload.params as { channel: string };
          await this.mcpRequest('slack/leave_channel', { channel });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }
        case 'slack_invite_to_channel': {
          const { channel, users } = payload.params as { channel: string; users: string[] };
          await this.mcpRequest('slack/invite_to_channel', { channel, users });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }

        // User commands
        case 'slack_get_user': {
          const { user } = payload.params as { user: string };
          const userInfo = await this.mcpRequest('slack/get_user', { user });
          result = { commandId: payload.commandId, success: true, result: { user: userInfo } };
          break;
        }
        case 'slack_list_users': {
          const { limit, cursor } = payload.params as { limit?: number; cursor?: string };
          const users = await this.mcpRequest('slack/list_users', { limit, cursor });
          result = { commandId: payload.commandId, success: true, result: { users } };
          break;
        }

        // File commands
        case 'slack_upload_file': {
          const { channels, content, filename, title, initial_comment } = payload.params as {
            channels: string[];
            content: string;
            filename: string;
            title?: string;
            initial_comment?: string;
          };
          const file = await this.mcpRequest('slack/upload_file', { channels, content, filename, title, initial_comment });
          result = { commandId: payload.commandId, success: true, result: { file } };
          break;
        }
        case 'slack_get_file': {
          const { file } = payload.params as { file: string };
          const fileInfo = await this.mcpRequest('slack/get_file', { file });
          result = { commandId: payload.commandId, success: true, result: { file: fileInfo } };
          break;
        }
        case 'slack_delete_file': {
          const { file } = payload.params as { file: string };
          await this.mcpRequest('slack/delete_file', { file });
          result = { commandId: payload.commandId, success: true, result: { ok: true } };
          break;
        }

        // Search commands
        case 'slack_search_messages': {
          const { query, sort, sort_dir, limit } = payload.params as { query: string; sort?: string; sort_dir?: string; limit?: number };
          const messages = await this.mcpRequest('slack/search_messages', { query, sort, sort_dir, limit });
          result = { commandId: payload.commandId, success: true, result: { messages } };
          break;
        }
        case 'slack_search_files': {
          const { query, limit } = payload.params as { query: string; limit?: number };
          const files = await this.mcpRequest('slack/search_files', { query, limit });
          result = { commandId: payload.commandId, success: true, result: { files } };
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
    mcpConnected: boolean;
  }> {
    return {
      uptime: process.uptime(),
      connected: this.connected,
      mcpConnected: this.mcpProcess !== null && !this.mcpProcess.killed,
    };
  }
}
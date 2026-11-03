/**
 * Notion Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Connects to Notion via official MCP server
 */

import { spawn, ChildProcess } from "node:child_process";
import { BaseBridge, type BridgeConfig, type BridgeMessage, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "📝 [Notion] ";
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

export interface NotionBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class NotionBridge extends BaseBridge {
  private mcpProcess: ChildProcess | null = null;
  private options: NotionBridgeOptions;
  private logFn: (message: string) => void;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private connected = false;

  constructor(options: NotionBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'notion',
      connectorType: 'notion',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'notion_events',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'notion-mcp',
        features: ['page_events', 'database_events', 'comment_events', 'workspace_events'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Notion bridge ready - starting MCP server');
    this.connected = true;
    await this.startMcpServer();
  }

  async onStop(): Promise<void> {
    this.logFn('Notion bridge stopping');
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

  protected override handleConnectorMessage(message: BridgeMessage): void {
    this.dispatch(message);
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


  // ============ MCP Server Management ============

  private async startMcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { mcpCommand, mcpArgs } = this.options.config;
      this.logFn(`Starting Notion MCP server: ${mcpCommand} ${mcpArgs.join(" ")}`);

      this.mcpProcess = spawn(mcpCommand, mcpArgs, {
        env: {
          ...process.env,
          // The official stdio server reads the integration token from
          // OPENAPI_MCP_HEADERS (JSON), not from a plain env var.
          OPENAPI_MCP_HEADERS: JSON.stringify({
            Authorization: `Bearer ${this.options.config.apiKey}`,
            'Notion-Version': '2022-06-28',
          }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';

      this.mcpProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        this.processMcpBuffer(buffer);
      });

      this.mcpProcess.stderr?.on('data', (data: Buffer) => {
        this.logFn(`[Notion MCP] ${data.toString().trim()}`);
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
        this.logFn('Notion MCP server started');
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

    // Handle MCP notifications (events from Notion)
    if (message.method) {
      this.handleMcpNotification(message);
    }
  }

  private handleMcpNotification(message: { method: string; params?: any }): void {
    const { method, params } = message;

    // Map Notion MCP notifications to channel_notify events
    switch (method) {
      case 'notion/page_created':
      case 'notion/page_updated':
      case 'notion/page_deleted': {
        const page = params?.page;
        if (page && this.shouldForwardWorkspace(page.workspace_id)) {
          const action = method.split('_').pop()?.toUpperCase();
          this.sendConnectorEvent('page_event', {
            action,
            page: {
              id: page.id,
              title: this.extractTitle(page),
              url: page.url,
              created_time: page.created_time,
              last_edited_time: page.last_edited_time,
              parent: page.parent,
              properties: page.properties,
            },
          });
        }
        break;
      }
      case 'notion/database_created':
      case 'notion/database_updated': {
        const database = params?.database;
        if (database && this.shouldForwardWorkspace(database.workspace_id)) {
          const action = method.includes('created') ? 'created' : 'updated';
          this.sendConnectorEvent('database_event', {
            action,
            database: {
              id: database.id,
              title: this.extractTitle(database),
              url: database.url,
              properties: database.properties,
            },
          });
        }
        break;
      }
      case 'notion/comment_created':
      case 'notion/comment_updated': {
        const comment = params?.comment;
        if (comment && this.shouldForwardWorkspace(comment.workspace_id)) {
          this.sendConnectorEvent('comment_event', {
            action: method.includes('created') ? 'created' : 'updated',
            comment: {
              id: comment.id,
              rich_text: comment.rich_text,
              created_time: comment.created_time,
              created_by: comment.created_by,
              page_id: comment.page_id,
            },
          });
        }
        break;
      }
      case 'notion/block_created':
      case 'notion/block_updated':
      case 'notion/block_deleted': {
        const block = params?.block;
        if (block && this.shouldForwardWorkspace(block.workspace_id)) {
          const action = method.split('_').pop()?.toUpperCase();
          this.sendConnectorEvent('block_event', {
            action,
            block: {
              id: block.id,
              type: block.type,
              created_time: block.created_time,
              has_children: block.has_children,
            },
          });
        }
        break;
      }
      default:
        this.logFn(`Unhandled Notion MCP notification: ${method}`);
    }
  }

  private extractTitle(item: { properties?: Record<string, any>; title?: any }): string {
    if (item.title) {
      if (Array.isArray(item.title)) {
        return item.title.map((t: any) => t.plain_text || t.text?.content || '').join('');
      }
      return item.title.plain_text || item.title.text?.content || '';
    }
    if (item.properties) {
      for (const [key, prop] of Object.entries(item.properties)) {
        if (prop.type === 'title' && prop.title) {
          if (Array.isArray(prop.title)) {
            return prop.title.map((t: any) => t.plain_text || t.text?.content || '').join('');
          }
          return prop.title.plain_text || prop.title.text?.content || '';
        }
      }
    }
    return 'Untitled';
  }

  private shouldForwardWorkspace(workspaceId: string | undefined): boolean {
    if (!workspaceId) return true;
    if (this.options.config.allowedWorkspaceIds.length === 0) return true;
    return this.options.config.allowedWorkspaceIds.includes(workspaceId);
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
        case 'get_page': {
          const { pageId } = payload.params as { pageId: string };
          const page = await this.mcpRequest('notion/get_page', { pageId });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'search_pages': {
          const { query, filter, limit } = payload.params as { query?: string; filter?: any; limit?: number };
          const results = await this.mcpRequest('notion/search_pages', { query, filter, limit });
          result = { commandId: payload.commandId, success: true, result: { pages: results } };
          break;
        }
        case 'create_page': {
          const { parent, properties, children } = payload.params as {
            parent: { type: 'page_id' | 'database_id'; id: string };
            properties: Record<string, any>;
            children?: any[];
          };
          const page = await this.mcpRequest('notion/create_page', { parent, properties, children });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'update_page': {
          const { pageId, properties } = payload.params as { pageId: string; properties: Record<string, any> };
          const page = await this.mcpRequest('notion/update_page', { pageId, properties });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'get_database': {
          const { databaseId } = payload.params as { databaseId: string };
          const database = await this.mcpRequest('notion/get_database', { databaseId });
          result = { commandId: payload.commandId, success: true, result: { database } };
          break;
        }
        case 'query_database': {
          const { databaseId, filter, sorts, limit } = payload.params as {
            databaseId: string;
            filter?: any;
            sorts?: any[];
            limit?: number;
          };
          const results = await this.mcpRequest('notion/query_database', { databaseId, filter, sorts, limit });
          result = { commandId: payload.commandId, success: true, result: { pages: results } };
          break;
        }
        case 'create_database': {
          const { parent, title, properties } = payload.params as {
            parent: { type: 'page_id'; page_id: string };
            title: string;
            properties: Record<string, any>;
          };
          const database = await this.mcpRequest('notion/create_database', { parent, title, properties });
          result = { commandId: payload.commandId, success: true, result: { database } };
          break;
        }
        case 'get_block': {
          const { blockId } = payload.params as { blockId: string };
          const block = await this.mcpRequest('notion/get_block', { blockId });
          result = { commandId: payload.commandId, success: true, result: { block } };
          break;
        }
        case 'get_block_children': {
          const { blockId, limit } = payload.params as { blockId: string; limit?: number };
          const children = await this.mcpRequest('notion/get_block_children', { blockId, limit });
          result = { commandId: payload.commandId, success: true, result: { blocks: children } };
          break;
        }
        case 'append_block_children': {
          const { blockId, children } = payload.params as { blockId: string; children: any[] };
          const result_ = await this.mcpRequest('notion/append_block_children', { blockId, children });
          result = { commandId: payload.commandId, success: true, result: result_ };
          break;
        }
        case 'get_users': {
          const users = await this.mcpRequest('notion/get_users', {});
          result = { commandId: payload.commandId, success: true, result: { users } };
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
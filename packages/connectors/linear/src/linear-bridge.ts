/**
 * Linear Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Connects to Linear via official MCP server
 */

import { spawn, ChildProcess } from "node:child_process";
import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "📋 [Linear] ";
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

export interface LinearBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class LinearBridge extends BaseBridge {
  private mcpProcess: ChildProcess | null = null;
  private options: LinearBridgeOptions;
  private logFn: (message: string) => void;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private connected = false;

  constructor(options: LinearBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'linear',
      connectorType: 'linear',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'linear_events',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'linear-mcp',
        features: ['issue_events', 'project_events', 'comment_events', 'team_events'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Linear bridge ready - starting MCP server');
    this.connected = true;
    await this.startMcpServer();
  }

  async onStop(): Promise<void> {
    this.logFn('Linear bridge stopping');
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
      this.logFn(`Starting Linear MCP server: ${mcpCommand} ${mcpArgs.join(" ")}`);

      this.mcpProcess = spawn(mcpCommand, mcpArgs, {
        env: {
          ...process.env,
          LINEAR_API_KEY: this.options.config.apiKey,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';

      this.mcpProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        this.processMcpBuffer(buffer);
      });

      this.mcpProcess.stderr?.on('data', (data: Buffer) => {
        this.logFn(`[Linear MCP] ${data.toString().trim()}`);
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
        this.logFn('Linear MCP server started');
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

    // Handle MCP notifications (events from Linear)
    if (message.method) {
      this.handleMcpNotification(message);
    }
  }

  private handleMcpNotification(message: { method: string; params?: any }): void {
    const { method, params } = message;

    // Map Linear MCP notifications to channel_notify events
    switch (method) {
      case 'linear/issue_created':
      case 'linear/issue_updated':
      case 'linear/issue_deleted': {
        const issue = params?.issue;
        if (issue && this.shouldForwardTeam(issue.team?.id)) {
          const action = method.split('_').pop()?.toUpperCase();
          this.sendConnectorEvent('issue_event', {
            action,
            issue: {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              state: issue.state?.name,
              priority: issue.priority,
              assignee: issue.assignee?.name,
              team: issue.team?.name,
              url: issue.url,
            },
          });
        }
        break;
      }
      case 'linear/comment_created':
      case 'linear/comment_updated': {
        const comment = params?.comment;
        if (comment && this.shouldForwardTeam(comment.issue?.team?.id)) {
          this.sendConnectorEvent('comment_event', {
            action: method.includes('created') ? 'created' : 'updated',
            comment: {
              id: comment.id,
              body: comment.body,
              user: comment.user?.name,
              issue: comment.issue?.identifier,
              createdAt: comment.createdAt,
            },
          });
        }
        break;
      }
      case 'linear/project_created':
      case 'linear/project_updated': {
        const project = params?.project;
        if (project && this.shouldForwardTeam(project.team?.id)) {
          this.sendConnectorEvent('project_event', {
            action: method.includes('created') ? 'created' : 'updated',
            project: {
              id: project.id,
              name: project.name,
              description: project.description,
              state: project.state,
              url: project.url,
            },
          });
        }
        break;
      }
      default:
        this.logFn(`Unhandled Linear MCP notification: ${method}`);
    }
  }

  private shouldForwardTeam(teamId: string | undefined): boolean {
    if (!teamId) return true;
    if (this.options.config.allowedTeamIds.length === 0) return true;
    return this.options.config.allowedTeamIds.includes(teamId);
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
        case 'get_issue': {
          const { id } = payload.params as { id: string };
          const issue = await this.mcpRequest('linear/get_issue', { id });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'list_issues': {
          const { teamId, state, limit } = payload.params as { teamId?: string; state?: string; limit?: number };
          const issues = await this.mcpRequest('linear/list_issues', { teamId, state, limit });
          result = { commandId: payload.commandId, success: true, result: { issues } };
          break;
        }
        case 'create_issue': {
          const { teamId, title, description, priority, assigneeId, labels } = payload.params as {
            teamId: string;
            title: string;
            description?: string;
            priority?: number;
            assigneeId?: string;
            labels?: string[];
          };
          const issue = await this.mcpRequest('linear/create_issue', { teamId, title, description, priority, assigneeId, labels });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'update_issue': {
          const { id, ...updates } = payload.params as { id: string; [key: string]: any };
          const issue = await this.mcpRequest('linear/update_issue', { id, ...updates });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'get_project': {
          const { id } = payload.params as { id: string };
          const project = await this.mcpRequest('linear/get_project', { id });
          result = { commandId: payload.commandId, success: true, result: { project } };
          break;
        }
        case 'list_projects': {
          const { teamId, state, limit } = payload.params as { teamId?: string; state?: string; limit?: number };
          const projects = await this.mcpRequest('linear/list_projects', { teamId, state, limit });
          result = { commandId: payload.commandId, success: true, result: { projects } };
          break;
        }
        case 'get_teams': {
          const teams = await this.mcpRequest('linear/get_teams', {});
          result = { commandId: payload.commandId, success: true, result: { teams } };
          break;
        }
        case 'search_issues': {
          const { query, limit } = payload.params as { query: string; limit?: number };
          const issues = await this.mcpRequest('linear/search_issues', { query, limit });
          result = { commandId: payload.commandId, success: true, result: { issues } };
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
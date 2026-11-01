/**
 * Atlassian Bridge - Extends BaseBridge from @gentle-dot/bridges-base
 * Connects to Atlassian (Jira/Confluence) via official MCP server
 */

import { spawn, ChildProcess } from "node:child_process";
import { BaseBridge, type BridgeConfig, type BridgeStatus, type HelloPayload, type ReadyPayload, type ChannelNotifyPayload, type ConnectorEventPayload, type CommandPayload, type CommandResultPayload } from '@gentle-dot/bridges-base';
import { type Config, loadConfig, type ConfigError } from './config.js';

const SOURCE_LABEL = "🔧 [Atlassian] ";
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

export interface AtlassianBridgeOptions {
  config: Config;
  log(message: string): void;
}

export class AtlassianBridge extends BaseBridge {
  private mcpProcess: ChildProcess | null = null;
  private options: AtlassianBridgeOptions;
  private logFn: (message: string) => void;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }>();
  private connected = false;

  constructor(options: AtlassianBridgeOptions) {
    const bridgeConfig: BridgeConfig = {
      daemonUrl: options.config.daemonUrl,
      connectorId: (options.config as any).connectorId ?? 'atlassian',
      connectorType: 'atlassian',
      token: '',
      capabilities: [
        'channel_notify',
        'message_send',
        'connector_command',
        'atlassian_events',
      ],
      metadata: {
        version: '1.0.0',
        provider: 'atlassian-mcp',
        features: ['jira_issue_events', 'confluence_page_events', 'jira_project_events'],
      },
    };

    super(bridgeConfig);

    this.options = options;
    this.logFn = options.log;
  }

  // ============ BaseBridge Abstract Methods ============

  async onReady(): Promise<void> {
    this.logFn('Atlassian bridge ready - starting MCP server');
    this.connected = true;
    await this.startMcpServer();
  }

  async onStop(): Promise<void> {
    this.logFn('Atlassian bridge stopping');
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
      this.logFn(`Starting Atlassian MCP server: ${mcpCommand} ${mcpArgs.join(" ")}`);

      this.mcpProcess = spawn(mcpCommand, mcpArgs, {
        env: {
          ...process.env,
          ATLASSIAN_SITE_URL: this.options.config.siteUrl,
          ATLASSIAN_API_TOKEN: this.options.config.apiToken,
          ATLASSIAN_EMAIL: this.options.config.email,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';

      this.mcpProcess.stdout?.on('data', (data: Buffer) => {
        buffer += data.toString();
        this.processMcpBuffer(buffer);
      });

      this.mcpProcess.stderr?.on('data', (data: Buffer) => {
        this.logFn(`[Atlassian MCP] ${data.toString().trim()}`);
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
        this.logFn('Atlassian MCP server started');
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

    // Handle MCP notifications (events from Atlassian)
    if (message.method) {
      this.handleMcpNotification(message);
    }
  }

  private handleMcpNotification(message: { method: string; params?: any }): void {
    const { method, params } = message;

    // Map Atlassian MCP notifications to channel_notify events
    switch (method) {
      case 'jira/issue_created':
      case 'jira/issue_updated':
      case 'jira/issue_deleted': {
        const issue = params?.issue;
        if (issue && this.shouldForwardCloudId(issue.cloudId)) {
          const action = method.split('_').pop()?.toUpperCase();
          this.sendConnectorEvent('jira_issue_event', {
            action,
            issue: {
              id: issue.id,
              key: issue.key,
              summary: issue.fields?.summary,
              status: issue.fields?.status?.name,
              priority: issue.fields?.priority?.name,
              assignee: issue.fields?.assignee?.displayName,
              project: issue.fields?.project?.key,
              url: `${this.options.config.siteUrl}/browse/${issue.key}`,
            },
          });
        }
        break;
      }
      case 'jira/comment_created':
      case 'jira/comment_updated':
      case 'jira/comment_deleted': {
        const comment = params?.comment;
        if (comment && this.shouldForwardCloudId(comment.cloudId)) {
          this.sendConnectorEvent('jira_comment_event', {
            action: method.split('_').pop()?.toLowerCase(),
            comment: {
              id: comment.id,
              body: comment.body?.content || comment.body,
              author: comment.author?.displayName,
              issueKey: comment.issueKey,
              createdAt: comment.created,
            },
          });
        }
        break;
      }
      case 'jira/project_created':
      case 'jira/project_updated': {
        const project = params?.project;
        if (project && this.shouldForwardCloudId(project.cloudId)) {
          this.sendConnectorEvent('jira_project_event', {
            action: method.includes('created') ? 'created' : 'updated',
            project: {
              id: project.id,
              key: project.key,
              name: project.name,
              projectTypeKey: project.projectTypeKey,
              url: `${this.options.config.siteUrl}/projects/${project.key}`,
            },
          });
        }
        break;
      }
      case 'confluence/page_created':
      case 'confluence/page_updated':
      case 'confluence/page_deleted': {
        const page = params?.page;
        if (page && this.shouldForwardCloudId(page.cloudId)) {
          const action = method.split('_').pop()?.toUpperCase();
          this.sendConnectorEvent('confluence_page_event', {
            action,
            page: {
              id: page.id,
              title: page.title,
              spaceKey: page.space?.key,
              version: page.version?.number,
              url: `${this.options.config.siteUrl}/wiki${page._links?.webui}`,
            },
          });
        }
        break;
      }
      case 'confluence/space_created':
      case 'confluence/space_updated': {
        const space = params?.space;
        if (space && this.shouldForwardCloudId(space.cloudId)) {
          this.sendConnectorEvent('confluence_space_event', {
            action: method.includes('created') ? 'created' : 'updated',
            space: {
              id: space.id,
              key: space.key,
              name: space.name,
              type: space.type,
              url: `${this.options.config.siteUrl}/wiki/spaces/${space.key}`,
            },
          });
        }
        break;
      }
      default:
        this.logFn(`Unhandled Atlassian MCP notification: ${method}`);
    }
  }

  private shouldForwardCloudId(cloudId: string | undefined): boolean {
    if (!cloudId) return true;
    if (this.options.config.allowedCloudIds.length === 0) return true;
    return this.options.config.allowedCloudIds.includes(cloudId);
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
        // Jira Issue commands
        case 'jira_get_issue': {
          const { issueIdOrKey } = payload.params as { issueIdOrKey: string };
          const issue = await this.mcpRequest('jira/get_issue', { issueIdOrKey });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'jira_search_issues': {
          const { jql, maxResults, fields } = payload.params as { jql: string; maxResults?: number; fields?: string[] };
          const issues = await this.mcpRequest('jira/search_issues', { jql, maxResults, fields });
          result = { commandId: payload.commandId, success: true, result: { issues } };
          break;
        }
        case 'jira_create_issue': {
          const { projectKey, summary, description, issueType, priority, assignee, labels } = payload.params as {
            projectKey: string;
            summary: string;
            description?: string;
            issueType?: string;
            priority?: string;
            assignee?: string;
            labels?: string[];
          };
          const issue = await this.mcpRequest('jira/create_issue', { projectKey, summary, description, issueType, priority, assignee, labels });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'jira_update_issue': {
          const { issueIdOrKey, fields, update } = payload.params as { issueIdOrKey: string; fields?: any; update?: any };
          const issue = await this.mcpRequest('jira/update_issue', { issueIdOrKey, fields, update });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'jira_transition_issue': {
          const { issueIdOrKey, transitionId } = payload.params as { issueIdOrKey: string; transitionId: string };
          const issue = await this.mcpRequest('jira/transition_issue', { issueIdOrKey, transitionId });
          result = { commandId: payload.commandId, success: true, result: { issue } };
          break;
        }
        case 'jira_add_comment': {
          const { issueIdOrKey, body } = payload.params as { issueIdOrKey: string; body: string };
          const comment = await this.mcpRequest('jira/add_comment', { issueIdOrKey, body });
          result = { commandId: payload.commandId, success: true, result: { comment } };
          break;
        }
        case 'jira_get_transitions': {
          const { issueIdOrKey } = payload.params as { issueIdOrKey: string };
          const transitions = await this.mcpRequest('jira/get_transitions', { issueIdOrKey });
          result = { commandId: payload.commandId, success: true, result: { transitions } };
          break;
        }

        // Jira Project commands
        case 'jira_get_project': {
          const { projectIdOrKey } = payload.params as { projectIdOrKey: string };
          const project = await this.mcpRequest('jira/get_project', { projectIdOrKey });
          result = { commandId: payload.commandId, success: true, result: { project } };
          break;
        }
        case 'jira_list_projects': {
          const projects = await this.mcpRequest('jira/list_projects', {});
          result = { commandId: payload.commandId, success: true, result: { projects } };
          break;
        }

        // Confluence commands
        case 'confluence_get_page': {
          const { pageId } = payload.params as { pageId: string };
          const page = await this.mcpRequest('confluence/get_page', { pageId });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'confluence_search_pages': {
          const { cql, limit } = payload.params as { cql?: string; limit?: number };
          const pages = await this.mcpRequest('confluence/search_pages', { cql, limit });
          result = { commandId: payload.commandId, success: true, result: { pages } };
          break;
        }
        case 'confluence_create_page': {
          const { spaceKey, title, body, parentId } = payload.params as {
            spaceKey: string;
            title: string;
            body: string;
            parentId?: string;
          };
          const page = await this.mcpRequest('confluence/create_page', { spaceKey, title, body, parentId });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'confluence_update_page': {
          const { pageId, title, body, version } = payload.params as {
            pageId: string;
            title?: string;
            body?: string;
            version: number;
          };
          const page = await this.mcpRequest('confluence/update_page', { pageId, title, body, version });
          result = { commandId: payload.commandId, success: true, result: { page } };
          break;
        }
        case 'confluence_get_space': {
          const { spaceKey } = payload.params as { spaceKey: string };
          const space = await this.mcpRequest('confluence/get_space', { spaceKey });
          result = { commandId: payload.commandId, success: true, result: { space } };
          break;
        }
        case 'confluence_list_spaces': {
          const spaces = await this.mcpRequest('confluence/list_spaces', {});
          result = { commandId: payload.commandId, success: true, result: { spaces } };
          break;
        }

        // User commands
        case 'atlassian_get_user': {
          const { accountId } = payload.params as { accountId: string };
          const user = await this.mcpRequest('atlassian/get_user', { accountId });
          result = { commandId: payload.commandId, success: true, result: { user } };
          break;
        }
        case 'atlassian_search_users': {
          const { query, maxResults } = payload.params as { query?: string; maxResults?: number };
          const users = await this.mcpRequest('atlassian/search_users', { query, maxResults });
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
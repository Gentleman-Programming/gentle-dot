/**
 * MCP Proxy - Proxies MCP servers, filters tools by mode, requests approvals for write operations
 * Implements Fase 3: MCP Proxy (S25.4) + Native Approvals (S25.3)
 */

import { EventEmitter } from 'events';
import { ChildProcess, spawn } from 'child_process';

export type McpMode = 'read_only' | 'read_write';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  // Custom metadata for filtering
  isWrite?: boolean;
  requiresApproval?: boolean;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  mode: McpMode;
  // Tools that should be filtered in read_only mode
  writeTools?: string[];
  // Tools that require explicit approval even in read_write mode
  approvalTools?: string[];
}

export interface ApprovalRequest {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  connectorId: string;
  timestamp: number;
}

export interface ApprovalResponse {
  id: string;
  approved: boolean;
  reason?: string;
}

export class McpProxy extends EventEmitter {
  private servers = new Map<string, McpServerInstance>();
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private approvalTimeout = 30000; // 30 seconds

  /**
   * Register and start an MCP server
   */
  async registerServer(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      throw new Error(`MCP server ${config.name} already registered`);
    }

    const instance = new McpServerInstance(config, this);
    await instance.start();
    this.servers.set(config.name, instance);
  }

  /**
   * Unregister and stop an MCP server
   */
  async unregisterServer(name: string): Promise<void> {
    const instance = this.servers.get(name);
    if (!instance) {
      return;
    }

    await instance.stop();
    this.servers.delete(name);
  }

  /**
   * Get all available tools across all servers (filtered by mode)
   */
  getAvailableTools(connectorId: string, mode: McpMode): McpTool[] {
    const tools: McpTool[] = [];

    for (const [name, instance] of this.servers.entries()) {
      const serverTools = instance.getTools();

      for (const tool of serverTools) {
        // Filter write tools in read_only mode
        if (mode === 'read_only' && tool.isWrite) {
          continue;
        }

        // Mark tools that require approval
        const requiresApproval = mode === 'read_write' &&
          instance.config.approvalTools?.includes(tool.name);

        tools.push({
          ...tool,
          requiresApproval,
        });
      }
    }

    return tools;
  }

  /**
   * Call a tool on the appropriate server
   */
  async callTool(
    connectorId: string,
    toolName: string,
    args: Record<string, unknown>,
    mode: McpMode
  ): Promise<unknown> {
    // Find server that has this tool
    let targetInstance: McpServerInstance | null = null;

    for (const instance of this.servers.values()) {
      if (instance.hasTool(toolName)) {
        targetInstance = instance;
        break;
      }
    }

    if (!targetInstance) {
      throw new Error(`Tool ${toolName} not found in any MCP server`);
    }

    // Check if tool is allowed in current mode
    const tool = targetInstance.getTool(toolName);
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    if (mode === 'read_only' && tool.isWrite) {
      throw new Error(`Tool ${toolName} is a write operation, not allowed in read_only mode`);
    }

    // Check if approval is required
    if (tool.requiresApproval) {
      const approval = await this.requestApproval(connectorId, toolName, args);
      if (!approval.approved) {
        throw new Error(`Approval denied for ${toolName}: ${approval.reason || 'No reason provided'}`);
      }
    }

    // Emit tool call event
    this.emit('tool_call', toolName, args, connectorId);

    try {
      const result = await targetInstance.callTool(toolName, args);
      this.emit('tool_result', toolName, result, connectorId);
      return result;
    } catch (error) {
      this.emit('tool_result', toolName, { error: (error as Error).message }, connectorId);
      throw error;
    }
  }

  /**
   * Request approval for a write operation
   */
  private async requestApproval(
    connectorId: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ApprovalResponse> {
    const requestId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const request: ApprovalRequest = {
      id: requestId,
      toolName,
      args,
      connectorId,
      timestamp: Date.now(),
    };

    this.pendingApprovals.set(requestId, request);
    this.emit('approval_requested', request);

    return new Promise((resolve) => {
      // Set timeout for approval
      const timeout = setTimeout(() => {
        this.pendingApprovals.delete(requestId);
        resolve({ id: requestId, approved: false, reason: 'Approval timeout' });
      }, this.approvalTimeout);

      // Wait for approval response
      const handler = (response: ApprovalResponse) => {
        if (response.id === requestId) {
          clearTimeout(timeout);
          this.off('approval_responded', handler);
          this.pendingApprovals.delete(requestId);
          resolve(response);
        }
      };

      this.on('approval_responded', handler);
    });
  }

  /**
   * Respond to an approval request (called by native approval dialog)
   */
  respondToApproval(response: ApprovalResponse): void {
    this.emit('approval_responded', response);
  }

  /**
   * Get pending approval requests
   */
  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  /**
   * Get server status
   */
  getServerStatus(): Record<string, { running: boolean; tools: number }> {
    const status: Record<string, { running: boolean; tools: number }> = {};

    for (const [name, instance] of this.servers.entries()) {
      status[name] = {
        running: instance.isRunning(),
        tools: instance.getTools().length,
      };
    }

    return status;
  }

  /**
   * Stop all servers
   */
  async stopAll(): Promise<void> {
    for (const [name, instance] of this.servers.entries()) {
      await instance.stop();
    }
    this.servers.clear();
  }
}

/**
 * Individual MCP Server Instance
 */
class McpServerInstance {
  config: McpServerConfig;
  process: ChildProcess | null = null;
  tools: McpTool[] = [];
  running = false;
  private requestId = 0;
  private pendingRequests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private proxy: McpProxy;
  private buffer = '';

  constructor(config: McpServerConfig, proxy: McpProxy) {
    this.config = config;
    this.proxy = proxy;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...this.config.env };

      this.process = spawn(this.config.command, this.config.args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      this.process.stdout?.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.process.stderr?.on('data', (data: Buffer) => {
        console.error(`[MCP:${this.config.name}]`, data.toString().trim());
      });

      this.process.on('error', (error) => {
        this.running = false;
        this.proxy.emit('server_error', this.config.name, error);
        reject(error);
      });

      this.process.on('exit', (code, signal) => {
        this.running = false;
        console.log(`[MCP:${this.config.name}] Exited:`, code, signal);
      });

      // Initialize MCP connection
      this.sendRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gentle-dot-daemon', version: '0.1.0' },
      }).then(() => {
        // List tools
        return this.sendRequest('tools/list', {});
      }).then((result) => {
        if (result && typeof result === 'object' && 'tools' in result) {
          this.tools = (result as { tools: McpTool[] }).tools.map(t => ({
            ...t,
            isWrite: this.config.writeTools?.includes(t.name) || false,
            requiresApproval: this.config.approvalTools?.includes(t.name) || false,
          }));
        }
        this.running = true;
        this.proxy.emit('server_ready', this.config.name, this.tools);
        resolve();
      }).catch(reject);
    });
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        this.process!.once('exit', () => resolve());
        setTimeout(resolve, 5000); // Force timeout
      });
      this.process = null;
    }
    this.running = false;
  }

  isRunning(): boolean {
    return this.running && this.process !== null && !this.process.killed;
  }

  getTools(): McpTool[] {
    return [...this.tools];
  }

  hasTool(name: string): boolean {
    return this.tools.some(t => t.name === name);
  }

  getTool(name: string): McpTool | undefined {
    return this.tools.find(t => t.name === name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.process) {
      throw new Error('MCP server not running');
    }

    const result = await this.sendRequest('tools/call', { name, arguments: args });

    if (result && typeof result === 'object' && 'isError' in result && (result as any).isError) {
      throw new Error((result as any).content?.[0]?.text || 'Tool call failed');
    }

    return result;
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const message = { jsonrpc: '2.0', id, method, params };
      this.process!.stdin!.write(JSON.stringify(message) + '\n');

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line);

        if (response.id && this.pendingRequests.has(response.id)) {
          const { resolve, reject } = this.pendingRequests.get(response.id)!;
          this.pendingRequests.delete(response.id);

          if (response.error) {
            reject(new Error(response.error.message || 'MCP error'));
          } else {
            resolve(response.result);
          }
        }
      } catch (error) {
        console.error(`[MCP:${this.config.name}] Parse error:`, error);
      }
    }
  }
}
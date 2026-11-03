/**
 * Daemon - Main orchestrator for the single daemon on port 4317
 * Coordinates: Config Loader, WebSocket Server, Connector Registry, Gentle Shell Spawner, MCP Proxy, App Channel
 */

import { loadAndValidateConfig, watchConfig, AppConfig } from './config-loader.js';
import { WsServer } from './ws-server.js';
import { ConnectorRegistry, connectorRegistry, ConnectorInfo, ConnectorType } from './connector-registry.js';
import { GentleShellSpawner, gentleShellSpawner, ShellConfig } from './gentle-shell-spawner.js';
import { McpProxy, McpServerConfig, McpMode, ApprovalRequest, ApprovalResponse } from './mcp-proxy.js';
import { AppChannel, AppMessage } from './app-channel.js';
import * as path from 'path';

export interface DaemonOptions {
  configPath?: string;
  port?: number;
  host?: string;
  dataDir?: string;
  workspace?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;
}

export class Daemon {
  private config: AppConfig;
  private wsServer: WsServer;
  private registry: ConnectorRegistry;
  private shellSpawner: GentleShellSpawner;
  private mcpProxy: McpProxy;
  private appChannel: AppChannel;
  private configWatcher: ReturnType<typeof watchConfig> | null = null;
  private shutdown = false;
  private options: DaemonOptions;

  constructor(options: DaemonOptions = {}) {
    this.options = options;

    // Load initial config
    const configPath = options.configPath || path.join(process.cwd(), 'packages', 'daemon', 'connectors.yaml');
    this.config = loadAndValidateConfig(configPath);

    // Override config with CLI options
    if (options.port) this.config.daemon.port = options.port;
    if (options.host) this.config.daemon.host = options.host;
    if (options.dataDir) this.config.daemon.data_dir = options.dataDir;
    if (options.workspace) this.config.daemon.workspace = options.workspace;
    if (options.logLevel) this.config.daemon.log_level = options.logLevel;

    // Initialize components
    this.registry = connectorRegistry;
    this.wsServer = new WsServer(this.registry, this.config);
    this.shellSpawner = gentleShellSpawner;
    this.mcpProxy = new McpProxy();
    this.appChannel = new AppChannel({ daemonPort: this.config.daemon.port });

    this.setupEventHandlers();
  }

  /**
   * Setup event handlers between components
   */
  private setupEventHandlers(): void {
    // Registry events
    this.registry.on('onConnectorRegistered', (info: ConnectorInfo) => {
      console.log(`[Daemon] Connector registered: ${info.connectorId} (${info.type})`);
      this.appChannel.broadcast('connector_connected', {
        connectorId: info.connectorId,
        type: info.type,
        status: info.status,
      });
    });

    this.registry.on('onConnectorUnregistered', (connectorId: string) => {
      console.log(`[Daemon] Connector unregistered: ${connectorId}`);
      this.appChannel.broadcast('connector_disconnected', { connectorId });
    });

    this.registry.on('onConnectorStatusChange', (connectorId: string, status: string) => {
      console.log(`[Daemon] Connector status change: ${connectorId} -> ${status}`);
      this.appChannel.broadcast('connector_status', { connectorId, status });
    });

    // WebSocket server events
    this.wsServer.on('onMessage', (connectorId: string, message: any) => {
      this.handleBridgeMessage(connectorId, message);
    });

    this.wsServer.on('onConnection', (ws, connectorId) => {
      console.log(`[Daemon] Bridge connected: ${connectorId}`);
    });

    this.wsServer.on('onDisconnection', (connectorId, code, reason) => {
      console.log(`[Daemon] Bridge disconnected: ${connectorId} (${code}: ${reason})`);
    });

    // MCP Proxy events
    this.mcpProxy.on('approval_requested', (request: ApprovalRequest) => {
      console.log(`[Daemon] Approval requested: ${request.toolName} for ${request.connectorId}`);
      // Forward to app channel for native approval dialog
      this.appChannel.broadcast('approval_requested', request);
    });

    this.mcpProxy.on('server_ready', (serverName: string, tools: any[]) => {
      console.log(`[Daemon] MCP server ready: ${serverName} (${tools.length} tools)`);
    });

    this.mcpProxy.on('server_error', (serverName: string, error: Error) => {
      console.error(`[Daemon] MCP server error (${serverName}):`, error);
    });

    // App Channel events
    this.appChannel.on('onMessage', (clientId: string, message: AppMessage) => {
      this.handleAppMessage(clientId, message);
    });
  }

  /**
   * Handle messages from bridges (WebSocket)
   */
  private async handleBridgeMessage(connectorId: string, message: any): Promise<void> {
    switch (message.type) {
      case 'channel_notify': {
        const payload = message.payload as { channelId: string; event: string; data: unknown };
        console.log(`[Daemon] Channel notify from ${connectorId}: ${payload.event} on ${payload.channelId}`);
        // Forward to app channel
        this.appChannel.broadcast('channel_notify', {
          connectorId,
          ...payload,
        });
        break;
      }

      case 'connector_event': {
        const payload = message.payload as { event: string; data: unknown };
        console.log(`[Daemon] Connector event from ${connectorId}: ${payload.event}`);
        this.appChannel.broadcast('connector_event', {
          connectorId,
          ...payload,
        });
        break;
      }

      case 'command': {
        const payload = message.payload as { commandId: string; action: string; params: Record<string, unknown> };
        await this.handleCommand(connectorId, payload);
        break;
      }

      case 'command_result': {
        // Forward to app channel
        this.appChannel.broadcast('command_result', {
          connectorId,
          ...message.payload,
        });
        break;
      }
    }
  }

  /**
   * Handle command from bridge
   */
  private async handleCommand(connectorId: string, payload: { commandId: string; action: string; params: Record<string, unknown> }): Promise<void> {
    const { commandId, action, params } = payload;

    try {
      let result: unknown;

      switch (action) {
        case 'mcp_call_tool': {
          const { toolName, args, mode } = params as { toolName: string; args: Record<string, unknown>; mode: McpMode };
          result = await this.mcpProxy.callTool(connectorId, toolName, args, mode);
          break;
        }

        case 'get_connectors': {
          result = this.registry.list().map(c => ({
            connectorId: c.connectorId,
            type: c.type,
            status: c.status,
            capabilities: c.capabilities,
          }));
          break;
        }

        case 'get_connector': {
          const { targetId } = params as { targetId: string };
          const connector = this.registry.get(targetId);
          result = connector ? {
            connectorId: connector.connectorId,
            type: connector.type,
            status: connector.status,
            capabilities: connector.capabilities,
            metadata: connector.metadata,
          } : null;
          break;
        }

        default:
          throw new Error(`Unknown command: ${action}`);
      }

      // Send result back to bridge
      this.wsServer.sendToConnector(connectorId, 'command_result', {
        commandId,
        success: true,
        result,
      });

    } catch (error) {
      this.wsServer.sendToConnector(connectorId, 'command_result', {
        commandId,
        success: false,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Handle messages from app channel (desktop app)
   */
  private async handleAppMessage(clientId: string, message: AppMessage): Promise<void> {
    switch (message.type) {
      case 'approval_response': {
        const response = message.payload as ApprovalResponse;
        this.mcpProxy.respondToApproval(response);
        break;
      }

      case 'get_status': {
        // Handled by default handler
        break;
      }

      case 'get_connectors': {
        // Handled by default handler
        break;
      }

      case 'restart_connector': {
        const { connectorId } = message.payload as { connectorId: string };
        // TODO: Implement connector restart logic
        console.log(`[Daemon] Restart connector requested: ${connectorId}`);
        break;
      }
    }
  }

  /**
   * Start the daemon
   */
  async start(): Promise<void> {
    console.log('[Daemon] Starting Gentle Dot Daemon...');
    console.log(`[Daemon] Config: ${this.config.daemon.host}:${this.config.daemon.port}`);

    // Start WebSocket server
    await this.wsServer.start();
    console.log('[Daemon] WebSocket server started');

    // Start App Channel
    await this.appChannel.start();
    console.log('[Daemon] App Channel started');

    // Start Gentle Shell in RPC mode
    // Dev/smoke: skip the engine entirely (bridges and WS still work).
    if (process.env['GENTLE_DOT_NO_SHELL'] === '1') {
      console.log('[Daemon] GENTLE_DOT_NO_SHELL=1 — skipping Gentle Shell spawn');
    } else {
    const shellConfig: ShellConfig = {
      home: this.config.daemon.workspace,
      engramProject: 'gentle-dot',
      mode: 'rpc',
      logLevel: this.config.daemon.log_level as any,
      noAutoSetup: this.options.noAutoSetup,
    };

    await this.shellSpawner.start({
      config: shellConfig,
      onReady: () => console.log('[Daemon] Gentle Shell RPC ready'),
      onError: (error) => console.error('[Daemon] Gentle Shell error:', error),
      onExit: (code, signal) => console.log('[Daemon] Gentle Shell exited:', code, signal),
    });

    } // end GENTLE_DOT_NO_SHELL skip

    // Register MCP servers based on config
    await this.registerMcpServers();

    // Watch config for hot reload
    this.configWatcher = watchConfig(this.options.configPath || '', (newConfig) => {
      console.log('[Daemon] Config reloaded');
      this.config = newConfig;
      // TODO: Apply config changes (port changes require restart)
    });

    // Setup graceful shutdown
    this.setupSignalHandlers();

    console.log('[Daemon] Daemon started successfully');
  }

  /**
   * Register MCP servers based on connector configuration
   */
  private async registerMcpServers(): Promise<void> {
    const connectors = this.config.connectors;

    // Gmail MCP (official)
    if (connectors.gmail.enabled) {
      const mode: McpMode = connectors.gmail.mode;
      try {
        await this.mcpProxy.registerServer({
                name: 'gmail',
                command: 'npx',
                args: ['-y', '@google/mcp-gmail'],
                env: {
                  GMAIL_WEBHOOK_SECRET: process.env[connectors.gmail.webhook_secret_env] || '',
                },
                mode,
                writeTools: ['send_email', 'modify_labels', 'trash_message'],
                approvalTools: ['send_email', 'trash_message'],
              });
      } catch (error) {
        // Fail-soft: a broken/unreachable MCP server must not kill the daemon
        // (the connectors themselves are the integration in the BaseBridge v2 architecture).
        console.error(`[Daemon] MCP server 'gmail' failed to register (continuing):`, (error as Error).message);
      }
    }

    // Discord MCP (community)
    if (connectors.discord.enabled) {
      const mode: McpMode = connectors.discord.mode;
      try {
        await this.mcpProxy.registerServer({
                name: 'discord',
                command: 'npx',
                args: ['-y', 'mcp-discord'],
                env: {
                  DISCORD_BOT_TOKEN: process.env[connectors.discord.bot_token_env] || '',
                  DISCORD_CLIENT_ID: process.env[connectors.discord.client_id_env] || '',
                },
                mode,
                writeTools: ['send_message', 'create_channel', 'ban_user', 'kick_user'],
                approvalTools: ['ban_user', 'kick_user', 'delete_channel'],
              });
      } catch (error) {
        // Fail-soft: a broken/unreachable MCP server must not kill the daemon
        // (the connectors themselves are the integration in the BaseBridge v2 architecture).
        console.error(`[Daemon] MCP server 'discord' failed to register (continuing):`, (error as Error).message);
      }
    }

    // WhatsApp Meta Cloud MCP (official)
    if (connectors.whatsapp.enabled && connectors.whatsapp.modes.meta_cloud.enabled) {
      const mode: McpMode = connectors.whatsapp.mode;
      try {
        await this.mcpProxy.registerServer({
                name: 'whatsapp-meta',
                command: 'npx',
                args: ['-y', '@meta/mcp-whatsapp'],
                env: {
                  WHATSAPP_PHONE_ID: process.env[connectors.whatsapp.modes.meta_cloud.phone_number_id_env] || '',
                  WHATSAPP_ACCESS_TOKEN: process.env[connectors.whatsapp.modes.meta_cloud.access_token_env] || '',
                  WHATSAPP_WEBHOOK_VERIFY: process.env[connectors.whatsapp.modes.meta_cloud.webhook_verify_token_env] || '',
                },
                mode,
                writeTools: ['send_message', 'send_template'],
                approvalTools: ['send_template'],
              });
      } catch (error) {
        // Fail-soft: a broken/unreachable MCP server must not kill the daemon
        // (the connectors themselves are the integration in the BaseBridge v2 architecture).
        console.error(`[Daemon] MCP server 'whatsapp-meta' failed to register (continuing):`, (error as Error).message);
      }
    }
  }

  /**
   * Setup signal handlers for graceful shutdown
   */
  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

    for (const signal of signals) {
      process.on(signal, () => {
        console.log(`[Daemon] Received ${signal}, shutting down...`);
        this.shutdown = true;
        this.stop().catch(console.error);
      });
    }
  }

  /**
   * Stop the daemon
   */
  async stop(): Promise<void> {
    if (this.shutdown) {
      console.log('[Daemon] Shutting down...');
    }

    // Stop config watcher
    if (this.configWatcher) {
      this.configWatcher.close();
      this.configWatcher = null;
    }

    // Stop components in reverse order
    await this.mcpProxy.stopAll();
    console.log('[Daemon] MCP Proxy stopped');

    await this.shellSpawner.stop();
    console.log('[Daemon] Gentle Shell stopped');

    await this.appChannel.stop();
    console.log('[Daemon] App Channel stopped');

    await this.wsServer.stop();
    console.log('[Daemon] WebSocket server stopped');

    // Clear registry
    this.registry.clear();
    console.log('[Daemon] Registry cleared');

    console.log('[Daemon] Daemon stopped');
    process.exit(0);
  }

  /**
   * Get daemon status
   */
  getStatus(): object {
    return {
      running: !this.shutdown,
      config: {
        port: this.config.daemon.port,
        host: this.config.daemon.host,
      },
      connectors: this.registry.list().map(c => ({
        connectorId: c.connectorId,
        type: c.type,
        status: c.status,
        connectedAt: c.connectedAt,
      })),
      mcpServers: this.mcpProxy.getServerStatus(),
      shell: {
        ready: this.shellSpawner.isReady(),
        pid: this.shellSpawner.getPid(),
      },
      appChannel: {
        clients: this.appChannel.getClientCount(),
      },
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }
}

/**
 * Create and start daemon from CLI options
 */
export async function createDaemon(options: DaemonOptions): Promise<Daemon> {
  const daemon = new Daemon(options);
  await daemon.start();
  return daemon;
}
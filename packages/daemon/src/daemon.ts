/**
 * Daemon - Main orchestrator for the single daemon on port 4317
 * Coordinates: Config Loader, WebSocket Server, Connector Registry, Gentle Shell Spawner, MCP Proxy, App Channel
 */

import { loadAndValidateConfig, watchConfig, type AppConfig } from './config-loader.ts';
import { WsServer } from './ws-server.ts';
import { ConnectorRegistry, connectorRegistry, type ConnectorInfo, type ConnectorType } from './connector-registry.ts';
import { GentleShellSpawner, type ShellConfig } from './gentle-shell-spawner.ts';
import { McpProxy, type McpServerConfig, type McpMode, type ApprovalRequest, type ApprovalResponse } from './mcp-proxy.ts';
import { AppChannel, type AppMessage } from './app-channel.ts';
import { childGuardFile, installChildGuardFile, watchChildGuard } from './child-guard.ts';
import { Transcript } from './transcript.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as path from 'path';
import type { Duplex } from 'node:stream';

export interface DaemonOptions {
  configPath?: string;
  port?: number;
  host?: string;
  dataDir?: string;
  workspace?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  noAutoSetup?: boolean;
  /**
   * Engine argv override (`[bin, ...args]`), for tests and for pointing the daemon at a
   * specific engine build. Defaults to `gentle-shell` resolved from PATH, with the usual
   * rpc arguments appended.
   */
  engineCommand?: string[];
  /**
   * The app's side of its pipe (fd 3). A daemon launched by the app lives as long as that pipe:
   * when it closes, the daemon stops. Without it the daemon runs on its own.
   */
  appChannel?: Duplex;
}

/** Las peticiones de UI que son preguntas para el usuario; `setStatus`/`notify` no lo son. */
const ASK_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

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
    // One spawner per daemon: a shared singleton makes a second daemon in the same process
    // fail with "Gentle Shell already running", which is how tests boot several.
    this.shellSpawner = new GentleShellSpawner();
    this.mcpProxy = new McpProxy();
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve;
    });
    // A pipe from the app replaces the socket server: one class, two transports.
    this.appChannel = this.options.appChannel
      ? new AppChannel(this.options.appChannel)
      : new AppChannel({ daemonPort: this.config.daemon.port });

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

    // Windows speak the client protocol: their frames are flat, so they get their own switch
    // instead of the bridge envelope one.
    this.wsServer.on('onAppMessage', (clientId: string, message: any) => {
      switch (message?.type) {
        case 'send':
          this.chatSend(clientId, String(message.text ?? ''));
          break;
        case 'get_history': {
          const { messages, hasEarlier } = this.transcript.page(undefined);
          this.wsServer.deliver(clientId, 'history', { messages, hasEarlier });
          break;
        }
        case 'get_earlier': {
          const { messages, hasEarlier } = this.transcript.page(String(message.before ?? ''));
          this.wsServer.deliver(clientId, 'earlier', {
            before: String(message.before ?? ''),
            messages,
            hasEarlier,
          });
          break;
        }
        case 'ui_response': {
          const requestId = String(message.requestId ?? '');
          if (!requestId) break;
          const sent = this.shellSpawner.uiRespond(requestId, {
            value: message.value,
            confirmed: message.confirmed,
            cancelled: message.cancelled,
          });
          if (sent) this.wsServer.deliver(clientId, 'ask_resolved', { requestId });
          break;
        }
        case 'abort':
          this.shellSpawner.rpc('abort', {}, 60_000).catch((error) =>
            console.error(`[Daemon] abort falló: ${(error as Error).message}`),
          );
          break;
        default:
          break;
      }
    });

    this.wsServer.on('onConnection', (ws, connectorId) => {
      console.log(`[Daemon] Bridge connected: ${connectorId}`);
    });

    this.wsServer.on('onDisconnection', (connectorId, code, reason) => {
      console.log(`[Daemon] Bridge disconnected: ${connectorId} (${code}: ${reason})`);
      // Si el conector origen del run activo se cae, cerramos el run:
      // la respuesta no tendría destino. El steer de otros conectores sigue vivo.
      const run = this.activeRun;
      if (run && run.connectorId === connectorId) {
        console.log(`[Daemon] run activo ${run.messageId} abandonado (conector ${connectorId} desconectado)`);
        this.activeRun = null;
        this.shellSpawner.rpc('abort', {}, 60_000).catch(() => {});
      }
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

    // The daemon lives as long as the app that launched it (S35.2, #22): when its pipe goes,
    // there is nobody left to talk to.
    this.appChannel.on('disconnect', () => {
      if (this.stopped || this.stopping) return;
      console.log('[Daemon] The app channel closed, stopping');
      void this.stop();
    });

    // App Channel events
    this.appChannel.on('onMessage', (clientId: string, message: AppMessage) => {
      this.handleAppMessage(clientId, message);
    });
  }

  /** The approval guard module the engine loads with `-e`, next to this daemon's sources. */
  private approvalGuardPath(): string {
    return fileURLToPath(new URL('./extensions/approval-guard.ts', import.meta.url));
  }

  /** Removes the workspace `mcp.json` the engine writes, when the guard cannot be enforced. */
  private removePlantedMcpJson(): void {
    const file = path.join(this.config.daemon.workspace, '.pi', 'mcp.json');
    try {
      if (!existsSync(file)) return;
      rmSync(file, { force: true });
      console.log(`[Daemon] Removed a planted mcp.json with the guard unenforceable: ${file}`);
    } catch (error) {
      console.log(`[Daemon] Could not remove the planted mcp.json (${file}): ${(error as Error).message}`);
    }
  }

  /**
   * The policy the approval guard reads: which connectors are approved and in which mode, the
   * files only the daemon may touch, and which servers its proxy already fronts. The lead entry
   * is the workspace's own `mcp.json`, because the engine writes it and the assistant must not.
   */
  private connectorPolicy(agentHome: string | undefined): Record<string, unknown> {
    const connectors: Record<string, { name: string; mode: string; readOnlyTools: string[] }> = {};
    const proxied: string[] = [];
    for (const [name, entry] of Object.entries(this.config.connectors ?? {})) {
      const connector = entry as { enabled?: boolean; mode?: string };
      if (!connector?.enabled) continue;
      connectors[name] = {
        name: name.charAt(0).toUpperCase() + name.slice(1),
        mode: connector.mode ?? 'read_only',
        readOnlyTools: [],
      };
      proxied.push(name);
    }

    const protectedPaths = [path.join(this.config.daemon.workspace, '.pi', 'mcp.json'), this.approvalGuardPath()];
    if (agentHome) protectedPaths.push(childGuardFile(agentHome));

    return { connectors, protectedPaths, proxied, builtin: ['computer'] };
  }

  /**
   * Puts the child guard in place and keeps it there while the engine runs. Returns false when it
   * cannot, so the caller starts the engine with subagents off instead of unprotected.
   */
  private superviseChildGuard(agentHome: string | undefined, guardPath: string): boolean {
    if (!agentHome) return false;
    const install = installChildGuardFile(agentHome, guardPath);
    if (!install.ok) {
      if (install.reason === 'cannot-be-written')
        console.log(`[Daemon] The child guard folder cannot be written (${install.file}), subagents are off`);
      else console.log(`[Daemon] The child guard cannot be put in place (${install.file}), subagents are off`);
      return false;
    }
    console.log(`[Daemon] Child guard installed: ${install.file}`);
    this.stopChildGuardWatch?.();
    this.stopChildGuardWatch = watchChildGuard(
      agentHome,
      guardPath,
      (line) => console.log(line),
      // With the guard unenforceable, a planted project mcp.json would reach the engine with no
      // one checking it: drop it and say why, once.
      () => this.removePlantedMcpJson(),
    );
    return true;
  }

  /** The conversation as this daemon saw it, for windows that connect later. */
  private transcript = new Transcript('');

  /** Resolves once stop() finished, so a caller can wait for the daemon to be gone. */
  readonly closed: Promise<void>;
  private resolveClosed!: () => void;
  private stopping: Promise<void> | null = null;
  private stopped = false;

  /** Stops the child-guard watcher; set when the guard is in place. */
  private stopChildGuardWatch: (() => void) | null = null;

  /** Run activo: el conector que originó el prompt actual y su messageId. */
  private activeRun: { connectorId: string; messageId: string } | null = null;

  /** Fija el modelo del engine (GENTLE_DOT_ENGINE_MODEL, default nan/glm5.3-flash). */
  private configureEngineModel(): void {
    const model = process.env['GENTLE_DOT_ENGINE_MODEL'] ?? 'nan/glm5.3-flash';
    const slash = model.indexOf('/');
    if (slash <= 0) {
      console.warn(`[Daemon] GENTLE_DOT_ENGINE_MODEL inválido: ${model} (se espera provider/model)`);
      return;
    }
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    this.shellSpawner
      .rpc('set_model', { provider, modelId })
      .then(() => console.log(`[Daemon] Engine model: ${model}`))
      .catch((error) => console.error(`[Daemon] set_model falló: ${(error as Error).message}`));
  }

  /**
   * Eventos del engine (pi RPC) → protocolo de conectores:
   * text_delta → message_delta · message_end (assistant) → message_done ·
   * tool_execution_start → activity · agent_settled → agent_state idle.
   * Todo se espeja al appChannel; lo dirigido al chat va al conector de origen.
   */
  private wireEngineEvents(): void {
    this.shellSpawner.on('engine-event', (event: Record<string, unknown>) => {
      const type = event['type'] as string;
      const origin = this.activeRun?.connectorId;

      switch (type) {
        case 'agent_start':
          if (origin) this.wsServer.deliver(origin, 'agent_state', { state: 'working' });
          this.appChannel.broadcast('agent_state', { state: 'working' });
          break;

        case 'message_update': {
          const nested = event['assistantMessageEvent'] as { type?: string; delta?: string } | undefined;
          if (nested?.type === 'text_delta' && nested.delta && origin && this.activeRun) {
            const payload = { messageId: this.activeRun.messageId, delta: nested.delta };
            this.wsServer.deliver(origin, 'message_delta', payload);
            // Las ventanas necesitan el texto en vivo, no solo el mensaje final.
            this.appChannel.broadcast('message_delta', { ...payload, connectorId: origin });
          }
          break;
        }

        case 'message_end': {
          const message = event['message'] as { role?: string; content?: unknown } | undefined;
          if (message?.role !== 'assistant' || !origin || !this.activeRun) break;
          const text = this.extractText(message.content);
          this.transcript.add('assistant', text);
          if (text.trim() !== '') {
            this.wsServer.deliver(origin, 'message_done', {
              messageId: this.activeRun.messageId,
              text,
            });
            this.appChannel.broadcast('message_done', {
              messageId: this.activeRun.messageId,
              connectorId: origin,
              text,
            });
          }
          break;
        }

        case 'extension_ui_request': {
          const requestId = event['id'] as string | undefined;
          const method = event['method'] as string | undefined;
          // Only real questions travel; a status line or a toast has nothing to answer.
          if (!requestId || !method || !origin || !ASK_METHODS.has(method)) break;
          const ask = {
            requestId,
            method,
            title: String(event['title'] ?? ''),
            ...(event['message'] !== undefined ? { message: String(event['message']) } : {}),
            ...(Array.isArray(event['options']) ? { options: event['options'] as string[] } : {}),
            ...(event['placeholder'] !== undefined ? { placeholder: String(event['placeholder']) } : {}),
            ...(event['prefill'] !== undefined ? { prefill: String(event['prefill']) } : {}),
          };
          this.wsServer.deliver(origin, 'ask', ask);
          break;
        }

        case 'tool_execution_start': {
          const toolName = event['toolName'] as string | undefined;
          const toolCallId = event['toolCallId'] as string | undefined;
          if (toolName && origin && this.activeRun) {
            this.wsServer.deliver(origin, 'activity', {
              messageId: this.activeRun.messageId,
              activity: { id: toolCallId, kind: 'run', title: toolName, status: 'running' },
            });
          }
          break;
        }

        case 'agent_settled': {
          if (origin) this.wsServer.deliver(origin, 'agent_state', { state: 'idle' });
          this.appChannel.broadcast('agent_state', { state: 'idle' });
          this.activeRun = null;
          break;
        }

        default:
          break;
      }

      // Espejo completo para la app de escritorio.
      this.appChannel.broadcast('engine_event', event);
    });
  }

  /** Extrae el texto de los content blocks de un mensaje del engine. */
  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((block) => (typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : ''))
      .join('');
  }

  /**
   * Handle messages from bridges (WebSocket)
   */
  private async handleBridgeMessage(connectorId: string, message: any): Promise<void> {
    switch (message.type) {
      case 'send': {
        const payload = message.payload as { text?: string; attachments?: unknown };
        const text = payload?.text?.trim();
        if (!text) return;
        this.chatSend(connectorId, text);
        break;
      }

      case 'abort': {
        this.shellSpawner.rpc('abort', {}, 60_000).catch((error) =>
          console.error(`[Daemon] abort falló: ${(error as Error).message}`));
        break;
      }

      case 'ui_response': {
        const payload = message.payload as { requestId?: string; value?: string; confirmed?: boolean; cancelled?: boolean };
        const requestId = payload?.requestId;
        if (!requestId) return;
        const sent = this.shellSpawner.uiRespond(requestId, {
          value: payload.value,
          confirmed: payload.confirmed,
          cancelled: payload.cancelled,
        });
        if (sent) this.wsServer.deliver(connectorId, 'ask_resolved', { requestId });
        break;
      }

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
   * Un prompt de un conector al engine. Con run activo de OTRO origen, el
   * mensaje va como steer (influye la corrida; la respuesta sigue yendo al
   * origen original). El 'send' rechazado por ocupado lo resuelve el bridge.
   */
  private chatSend(connectorId: string, text: string): void {
    if (!this.shellSpawner.isReady()) {
      this.wsServer.deliver(connectorId, 'error', {
        code: 'engine_unavailable',
        message: 'El asistente no está disponible ahora.',
      });
      return;
    }

    this.transcript.add('user', text);

    const params: Record<string, unknown> = { message: text };
    if (this.activeRun) {
      params['streamingBehavior'] = 'steer';
      console.log(`[Daemon] steer desde ${connectorId} (run activo de ${this.activeRun.connectorId})`);
    } else {
      this.activeRun = {
        connectorId,
        messageId: `msg-${Date.now().toString(36)}`,
      };
      console.log(`[Daemon] prompt desde ${connectorId} (run ${this.activeRun.messageId})`);
    }

    this.shellSpawner.rpc('prompt', params).catch((error) => {
      console.error(`[Daemon] prompt falló: ${(error as Error).message}`);
      this.activeRun = null;
      this.wsServer.deliver(connectorId, 'error', {
        code: 'prompt_failed',
        message: (error as Error).message,
      });
    });
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
   * Marks a fresh default engine home as the engine's own, before the first spawn (S35.3, #13).
   * The engine writes the same record itself; a home that already has one is left untouched, and
   * one that only holds the daemon's earlier files is recovered by writing the marker.
   */
  private markEngineHome(agentHome: string): void {
    const marker = path.join(agentHome, '.gentle-shell-home');
    if (existsSync(marker)) return;
    try {
      mkdirSync(agentHome, { recursive: true, mode: 0o700 });
      const require = createRequire(import.meta.url);
      const version = (require('gentle-pi/package.json') as { version: string }).version;
      writeFileSync(marker, `${JSON.stringify({ createdBy: 'gentle-shell', version })}\n`);
    } catch (error) {
      // Never keep the engine from starting over a marker.
      console.error(`[Daemon] Could not mark the engine home (${agentHome}):`, error);
    }
  }

  /** The port the daemon listens on, for callers that health-check it. */
  get port(): number {
    return this.config.daemon.port;
  }

  /** The engine process this daemon supervises: its pid and whether it is still running. */
  get supervisor(): { pid: number | undefined; state: 'ready' | 'stopped' } {
    return { pid: this.shellSpawner.pid, state: this.stopped ? 'stopped' : 'ready' };
  }

  /** Same as stop(), for callers that think in terms of closing: idempotent. */
  close(): Promise<void> {
    return this.stop();
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

    this.transcript = new Transcript(path.join(this.config.daemon.data_dir, 'transcript.jsonl'));
    this.transcript.load();

    // Start Gentle Shell in RPC mode
    // Dev/smoke: skip the engine entirely (bridges and WS still work).
    if (process.env['GENTLE_DOT_NO_SHELL'] === '1') {
      console.log('[Daemon] GENTLE_DOT_NO_SHELL=1 — skipping Gentle Shell spawn');
    } else {
    // The engine's own home: the operator's choice when named, <data_dir>/agent otherwise. Only
    // the default is claimed for the engine (S35.3) — an overridden home is not ours to mark.
    const chosenHome = process.env['GENTLE_DOT_AGENT_HOME'];
    const engineHome = chosenHome ?? path.join(this.config.daemon.data_dir, 'agent');
    if (!chosenHome) this.markEngineHome(engineHome);

    const shellConfig: ShellConfig = {
      home: this.config.daemon.workspace,
      agentHome: engineHome,
      engramProject: 'gentle-dot',
      mode: 'rpc',
      logLevel: this.config.daemon.log_level as any,
      noAutoSetup: this.options.noAutoSetup,
      engineCommand: this.options.engineCommand,
      // Sessions live next to the daemon's data so history survives an engine restart.
      sessionDir: path.join(this.config.daemon.data_dir, 'sessions'),
      extensions: [this.approvalGuardPath()],
    };
    shellConfig.policy = this.connectorPolicy(shellConfig.agentHome);

    // The subagents of the assistant's engine load the guard from its extensions folder. If it
    // cannot be put there (or kept there), the engine runs with subagents off rather than
    // unprotected.
    const guardPath = shellConfig.extensions?.[0] ?? this.approvalGuardPath();
    if (!this.superviseChildGuard(shellConfig.agentHome, guardPath)) shellConfig.subagentsOn = false;

    await this.shellSpawner.start({
      config: shellConfig,
      onReady: () => {
        console.log('[Daemon] Gentle Shell RPC ready');
        this.configureEngineModel();
        this.wireEngineEvents();
      },
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
  /**
   * Stops the daemon. Idempotent: closing twice, or closing while the app quits, stops it once
   * and every caller waits for the same promise.
   */
  async stop(): Promise<void> {
    this.stopping ??= this.doStop().finally(() => {
      this.stopped = true;
      this.resolveClosed();
    });
    return this.stopping;
  }

  private async doStop(): Promise<void> {
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

    this.stopChildGuardWatch?.();
    this.stopChildGuardWatch = null;

    await this.appChannel.stop();
    console.log('[Daemon] App Channel stopped');

    await this.wsServer.stop();
    console.log('[Daemon] WebSocket server stopped');

    // Clear registry
    this.registry.clear();
    console.log('[Daemon] Registry cleared');

    console.log('[Daemon] Daemon stopped');
    // The caller owns the process: exiting here made stop() unusable in tests (and in any
    // host that embeds the daemon) because it killed the whole process group.
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
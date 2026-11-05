/**
 * WebSocket Server - Bridge Protocol v1 implementation
 * Implements Regla de Oro #5: Handshake obligatorio hello→ready
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { CONNECTOR_TYPES, ConnectorRegistry, type ConnectorInfo, type ConnectorType } from './connector-registry.ts';
import type { AppConfig } from './config-loader.ts';

export type BridgeMessageType =
  | 'hello'
  | 'ready'
  | 'ping'
  | 'pong'
  | 'channel_notify'
  | 'connector_event'
  | 'command'
  | 'command_result'
  | 'error'
  | 'disconnect'
  | 'agent_state'
  | 'message_delta'
  | 'message_done'
  | 'activity'
  | 'send'
  | 'abort'
  | 'ui_response';

export interface BridgeMessage {
  type: BridgeMessageType;
  payload: unknown;
  seq?: number;
  timestamp: number;
}

export interface HelloPayload {
  token: string;
  protocol: number;
  capabilities: string[];
  connectorType: ConnectorType;
  connectorId: string;
  metadata?: Record<string, unknown>;
}

export interface ReadyPayload {
  sessionId: string;
  agentState: string;
  features: string[];
  daemonVersion: string;
}

export interface PingPayload {
  seq: number;
  ts: number;
}

export interface PongPayload {
  seq: number;
}

export interface ChannelNotifyPayload {
  channelId: string;
  event: string;
  data: unknown;
}

export interface ConnectorEventPayload {
  connectorId: string;
  event: string;
  data: unknown;
}

export interface CommandPayload {
  commandId: string;
  connectorId: string;
  action: string;
  params: Record<string, unknown>;
}

export interface CommandResultPayload {
  commandId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface WsServerEvents {
  onConnection: (ws: WebSocket, connectorId: string) => void;
  onDisconnection: (connectorId: string, code: number, reason: string) => void;
  onMessage: (connectorId: string, message: BridgeMessage) => void;
  onError: (connectorId: string | null, error: Error) => void;
}

const DAEMON_VERSION = '0.1.0';
const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL = 30000; // 30 seconds
const HEARTBEAT_TIMEOUT = 60000; // 60 seconds

interface ConnectorWithWs extends ConnectorInfo {
  ws?: WebSocket;
}

interface ConnectionState {
  connectorId: string | null;
  authenticated: boolean;
}

export class WsServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private registry: ConnectorRegistry;
  private config: AppConfig;
  private sessionIdCounter = 0;
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private pendingPings = new Map<string, number>(); // connectorId -> seq

  constructor(registry: ConnectorRegistry, config: AppConfig) {
    super();
    this.registry = registry;
    this.config = config;
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws' });

      this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
        this.handleConnection(ws, req);
      });

      this.wss.on('error', (error) => {
        console.error('[WsServer] WebSocket server error:', error);
        this.emit('onError', null, error);
      });

      this.httpServer.listen(this.config.daemon.port, this.config.daemon.host, () => {
        console.log(`[WsServer] Listening on ${this.config.daemon.host}:${this.config.daemon.port}`);
        resolve();
      });

      this.httpServer.on('error', (error) => {
        console.error('[WsServer] HTTP server error:', error);
        reject(error);
      });

      // Start heartbeat interval
      this.startHeartbeat();
    });
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    // Clear all heartbeat timers
    for (const timer of this.heartbeatTimers.values()) {
      clearTimeout(timer);
    }
    this.heartbeatTimers.clear();
    this.pendingPings.clear();

    // Close all WebSocket connections
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close(1001, 'Server shutting down');
      }
      await new Promise<void>((resolve) => {
        this.wss!.close(() => resolve());
      });
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }

    console.log('[WsServer] Stopped');
  }

  /**
   * Handle incoming HTTP requests (health/ready endpoints)
   */
  private handleHttpRequest(req: IncomingMessage, res: import('http').ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, timestamp: Date.now() }));
      return;
    }

    if (url.pathname === '/ready') {
      const ready = this.registry.getReadyCount() > 0 || this.registry.getTotalCount() === 0;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, connectors: this.registry.getTotalCount(), timestamp: Date.now() }));
      return;
    }

    if (url.pathname === '/connectors') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ connectors: this.registry.list().map(c => ({
        connectorId: c.connectorId,
        type: c.type,
        status: c.status,
        connectedAt: c.connectedAt,
        capabilities: c.capabilities,
      })), timestamp: Date.now() }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /**
   * Handle new WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const state: ConnectionState = {
      connectorId: null,
      authenticated: false,
    };

    console.log('[WsServer] New connection from', req.socket.remoteAddress);

    /** Set once the socket identifies itself as a window rather than a connector. */
    let appClientId: string | null = null;

    const onMessage = (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString()) as BridgeMessage & {
          token?: string;
          protocol?: number;
          payload?: unknown;
          text?: string;
        };

        // The windows speak the client protocol: flat frames, no envelope and no timestamp.
        // A bridge hello always carries `payload`, so the two handshakes cannot be confused.
        if (appClientId) {
          if (message.type === 'ping') {
            this.sendApp(ws, 'pong', {});
            return;
          }
          this.emit('onAppMessage', appClientId, message);
          return;
        }
        if (message.type === 'hello' && message.payload === undefined && typeof message.token === 'string') {
          appClientId = this.handleAppHello(ws, message);
          return;
        }

        // Validate message structure
        if (!message.type || typeof message.timestamp !== 'number') {
          this.sendError(ws, 'INVALID_MESSAGE', 'Message must have type and timestamp');
          return;
        }

        // Handle hello message (authentication)
        if (message.type === 'hello') {
          this.handleHello(ws, message, state);
          return;
        }

        // Require authentication for all other messages
        if (!state.authenticated || !state.connectorId) {
          this.sendError(ws, 'NOT_AUTHENTICATED', 'Must send hello first');
          return;
        }

        // Update heartbeat
        this.registry.updateHeartbeat(state.connectorId);

        // Route message
        switch (message.type) {
          case 'ping':
            this.handlePing(ws, state.connectorId, message);
            break;
          case 'pong':
            this.handlePong(state.connectorId, message);
            break;
          case 'channel_notify':
          case 'connector_event':
          case 'command':
          case 'command_result':
          case 'send':
          case 'abort':
          case 'ui_response':
            this.emit('onMessage', state.connectorId, message);
            break;
          case 'disconnect':
            this.handleDisconnect(ws, state.connectorId, message);
            break;
          default:
            this.sendError(ws, 'UNKNOWN_MESSAGE_TYPE', `Unknown message type: ${message.type}`);
        }
      } catch (error) {
        console.error('[WsServer] Error parsing message:', error);
        this.sendError(ws, 'PARSE_ERROR', 'Invalid JSON');
      }
    };

    const onClose = (code: number, reason: Buffer) => {
      console.log('[WsServer] Connection closed:', code, reason.toString());
      if (state.connectorId) {
        this.cleanupConnector(state.connectorId, code, reason.toString());
      }
    };

    const onError = (error: Error) => {
      console.error('[WsServer] WebSocket error:', error);
      this.emit('onError', state.connectorId, error);
    };

    ws.on('message', onMessage);
    ws.on('close', onClose);
    ws.on('error', onError);
  }

  /**
   * Handle hello message (authentication handshake)
   */
  /**
   * The client protocol's handshake: same daemon token, no connector type. A window gets the
   * flat `ready` the protocol expects, and from then on its frames go to `onAppMessage`.
   */
  private handleAppHello(ws: WebSocket, message: { token?: string; protocol?: number }): string | null {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.sendAppError(ws, 'PROTOCOL_MISMATCH', `Expected protocol v${PROTOCOL_VERSION}, got v${message.protocol}`);
      ws.close(1002, 'Protocol mismatch');
      return null;
    }
    if (!message.token || message.token !== this.getAuthToken()) {
      this.sendAppError(ws, 'INVALID_TOKEN', 'Invalid authentication token');
      ws.close(1008, 'Invalid token');
      return null;
    }

    const clientId = `app-${++this.appSeq}`;
    this.appClients.set(clientId, ws);
    ws.on('close', () => this.appClients.delete(clientId));
    this.sendApp(ws, 'ready', { protocol: PROTOCOL_VERSION, agentState: 'idle', clientId });
    console.log(`[WsServer] App client connected: ${clientId}`);
    return clientId;
  }

  /** One flat client-protocol frame to a window. */
  private sendApp(ws: WebSocket, type: string, payload: unknown): boolean {
    if (ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify({ type, ...(payload as Record<string, unknown>) }));
      return true;
    } catch (error) {
      console.error('[WsServer] send to app failed:', error);
      return false;
    }
  }

  private sendAppError(ws: WebSocket, code: string, message: string): void {
    this.sendApp(ws, 'error', { code, message });
  }

  /**
   * Deliver to whoever the id names: a window (flat client protocol) or a connector (bridge
   * envelope). The daemon routes engine events through this so one code path serves both.
   */
  deliver(target: string, type: BridgeMessageType | string, payload: unknown): boolean {
    const app = this.appClients.get(target);
    if (app) return this.sendApp(app, type, payload);
    return this.sendToConnector(target, type as BridgeMessageType, payload);
  }

  private handleHello(ws: WebSocket, message: BridgeMessage, state: ConnectionState): void {
    const payload = message.payload as HelloPayload;

    // Validate protocol version
    if (payload.protocol !== PROTOCOL_VERSION) {
      this.sendError(ws, 'PROTOCOL_MISMATCH', `Expected protocol v${PROTOCOL_VERSION}, got v${payload.protocol}`);
      ws.close(1002, 'Protocol mismatch');
      return;
    }

    // Validate token (simple check - in production use proper auth)
    if (!payload.token || payload.token !== this.getAuthToken()) {
      this.sendError(ws, 'INVALID_TOKEN', 'Invalid authentication token');
      ws.close(1008, 'Invalid token');
      return;
    }

    // Validate connector type
    if (!payload.connectorType || !(CONNECTOR_TYPES as readonly string[]).includes(payload.connectorType)) {
      this.sendError(ws, 'INVALID_CONNECTOR_TYPE', `Unknown connector type: ${payload.connectorType}. Accepted: ${CONNECTOR_TYPES.join(', ')}`);
      ws.close(1008, 'Invalid connector type');
      return;
    }

    // Check if connectorId already registered
    if (this.registry.get(payload.connectorId)) {
      this.sendError(ws, 'CONNECTOR_EXISTS', `Connector ${payload.connectorId} already connected`);
      ws.close(1008, 'Connector already connected');
      return;
    }

    // Register connector
    const connectorInfo: ConnectorInfo = {
      connectorId: payload.connectorId,
      type: payload.connectorType,
      status: 'connecting',
      connectedAt: Date.now(),
      lastPing: Date.now(),
      capabilities: payload.capabilities || [],
      metadata: payload.metadata || {},
    };

    this.registry.register(connectorInfo);

    // Mark as authenticated
    state.connectorId = payload.connectorId;
    state.authenticated = true;

    // Store ws reference in registry
    const registered = this.registry.get(state.connectorId);
    if (registered) {
      (registered as ConnectorWithWs).ws = ws;
    }

    // Send ready response
    const sessionId = `session-${++this.sessionIdCounter}-${Date.now()}`;
    const readyPayload: ReadyPayload = {
      sessionId,
      agentState: 'ready',
      features: ['channel_notify', 'connector_event', 'command', 'command_result'],
      daemonVersion: DAEMON_VERSION,
    };

    this.send(ws, 'ready', readyPayload);

    // Update status to ready
    this.registry.updateStatus(state.connectorId, 'ready');

    console.log(`[WsServer] Connector registered: ${state.connectorId} (${payload.connectorType})`);
    this.emit('onConnection', ws, state.connectorId);
  }

  /**
   * Handle ping message
   */
  private handlePing(ws: WebSocket, connectorId: string, message: BridgeMessage): void {
    const payload = message.payload as PingPayload;
    const pongPayload: PongPayload = { seq: payload.seq };
    this.send(ws, 'pong', pongPayload);
  }

  /**
   * Handle pong message
   */
  private handlePong(connectorId: string, message: BridgeMessage): void {
    const payload = message.payload as PongPayload;
    const pendingSeq = this.pendingPings.get(connectorId);
    if (pendingSeq !== undefined && pendingSeq === payload.seq) {
      this.pendingPings.delete(connectorId);
    }
  }

  /**
   * Handle disconnect message
   */
  private handleDisconnect(ws: WebSocket, connectorId: string, message: BridgeMessage): void {
    ws.close(1000, 'Client requested disconnect');
  }

  /**
   * Clean up connector on disconnect
   */
  private cleanupConnector(connectorId: string, code: number, reason: string): void {
    const connector = this.registry.get(connectorId);
    if (connector) {
      this.registry.updateStatus(connectorId, 'disconnected');
    }
    this.registry.unregister(connectorId);

    const timer = this.heartbeatTimers.get(connectorId);
    if (timer) {
      clearTimeout(timer);
      this.heartbeatTimers.delete(connectorId);
    }
    this.pendingPings.delete(connectorId);

    this.emit('onDisconnection', connectorId, code, reason);
    console.log(`[WsServer] Connector unregistered: ${connectorId}`);
  }

  /**
   * Send a message to a WebSocket
   */
  send(ws: WebSocket, type: BridgeMessageType, payload: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: BridgeMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };

    ws.send(JSON.stringify(message));
  }

  /**
   * Send error to a WebSocket
   */
  sendError(ws: WebSocket, code: string, message: string, details?: unknown): void {
    const payload: ErrorPayload = { code, message, details };
    this.send(ws, 'error', payload);
  }

  /**
   * Broadcast message to all connectors of a specific type
   */
  broadcastToType(type: ConnectorType, messageType: BridgeMessageType, payload: unknown): number {
    const connectors = this.registry.getByType(type);
    let sent = 0;

    for (const connector of connectors) {
      const ws = (connector as ConnectorWithWs).ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        this.send(ws, messageType, payload);
        sent++;
      }
    }

    return sent;
  }

  /**
   * Send message to specific connector
   */
  sendToConnector(connectorId: string, messageType: BridgeMessageType, payload: unknown): boolean {
    const connector = this.registry.get(connectorId);
    if (!connector) {
      return false;
    }
    const ws = (connector as ConnectorWithWs).ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    this.send(ws, messageType, payload);
    return true;
  }

  /**
   * Start heartbeat mechanism
   */
  private startHeartbeat(): void {
    setInterval(() => {
      const now = Date.now();

      for (const connector of this.registry.list()) {
        const cid = connector.connectorId;
        const ws = (connector as ConnectorWithWs).ws;

        // Check if heartbeat timeout exceeded
        if (now - connector.lastPing > HEARTBEAT_TIMEOUT) {
          console.warn(`[WsServer] Heartbeat timeout for ${cid}, disconnecting`);
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1001, 'Heartbeat timeout');
          }
          continue;
        }

        // Send ping if no pending ping
        if (!this.pendingPings.has(cid) && ws && ws.readyState === WebSocket.OPEN) {
          const seq = Date.now();
          this.pendingPings.set(cid, seq);
          this.send(ws, 'ping', { seq, ts: now });
        }
      }
    }, HEARTBEAT_INTERVAL);
  }

  /**
   * Get authentication token from config or env
   */
  /** Windows connected over the client protocol (flat frames), by client id. */
  private appClients = new Map<string, WebSocket>();
  private appSeq = 0;

  private getAuthToken(): string {
    // In production, this should come from a secure config
    // For now, use a simple shared secret from env or default
    return process.env['BRIDGE_AUTH_TOKEN'] || 'gentle-dot-bridge-secret';
  }
}
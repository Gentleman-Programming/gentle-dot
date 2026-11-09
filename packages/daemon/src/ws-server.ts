/**
 * WebSocket Server - Bridge Protocol v1 implementation
 * Implements Regla de Oro #5: Handshake obligatorio hello→ready
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, IncomingMessage, Server as HttpServer } from 'http';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { CloseCode } from '@gentle-dot/protocol';
import { CONNECTOR_TYPES, ConnectorRegistry, type ConnectorInfo, type ConnectorType } from './connector-registry.ts';
import type { UploadStore } from './uploads.ts';
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

/**
 * The one shared key this server authenticates windows and bridges with. The daemon
 * generates it at startup and persists it in `<dataDir>/token` (cli.ts); a built-in
 * default would be a secret published in the source that any local process could use,
 * so a missing key is an error rather than a fallback (S25.8).
 */
export function requireAuthToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env['BRIDGE_AUTH_TOKEN'];
  if (!token) {
    throw new Error(
      'BRIDGE_AUTH_TOKEN is not set: the daemon must generate its access key before the WebSocket server starts.',
    );
  }
  return token;
}

export class WsServer extends EventEmitter {
  /** Captured once at start, so a later env change cannot move the key mid-life. */
  private authToken: string | undefined;
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
    // Fail closed before listening: without a key, no client can authenticate.
    this.authToken = requireAuthToken();
    // Origins the operator named on top of the desktop app's defaults.
    const configured = (this.config.daemon as { allowedOrigins?: string[] }).allowedOrigins;
    for (const origin of configured ?? []) this.allowedOrigins.add(origin);
    return new Promise((resolve, reject) => {
      this.httpServer = createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      this.wss = new WebSocketServer({ noServer: true, path: '/ws' });
      const wss = this.wss;

      // WebSocket upgrades are routed here instead of through the HTTP handler, so the origin
      // veto runs before the handshake: a page the user happens to open must not drive their
      // assistant. Same-origin windows (the served web UI, a proxied VPS domain) and the
      // allowlisted desktop origins pass; anything else is refused before upgrading.
      this.httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/ws') {
          socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
        const host = typeof req.headers.host === 'string' ? req.headers.host : undefined;
        const sameOrigin =
          origin !== undefined && host !== undefined && (origin === `http://${host}` || origin === `https://${host}`);
        if (origin !== undefined && !sameOrigin && !this.allowedOrigins.has(origin)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\nThat origin is not allowed.');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

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

    if (url.pathname === '/upload') {
      this.handleUpload(req, res);
      return;
    }

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
      this.handleMcp(req, res);
      return;
    }

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

    // The daemon no longer ships a window (the desktop app does), but the root answers so a
    // browser or a health check that lands here sees something alive instead of a 404.
    if (url.pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Gentle Dot</title><p>Gentle Dot is running.</p>');
      return;
    }

    // A path the daemon does not serve: wrong method for a known place is a 405, anything else 404.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
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
        // No session exists yet: the first frame a window sends must be the flat hello, and a
        // connection that never authenticated cannot keep talking (client protocol, S25.1).
        if (message.type !== 'hello') {
          ws.close(CloseCode.unauthorized, 'The first message must be hello');
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
        // A window gets the flat client-protocol error; bridges get the envelope one.
        if (appClientId) this.sendAppError(ws, 'bad_message', 'Invalid JSON');
        else this.sendError(ws, 'PARSE_ERROR', 'Invalid JSON');
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
   * `POST /mcp`: the connectors' MCP endpoint (JSON-RPC 2.0), reached by the engine with the key its
   * launch was given. A wrong key is refused before the body is read.
   */
  private handleMcp(req: IncomingMessage, res: import('http').ServerResponse): void {
    const endpoint = this.mcpEndpoint;
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (!endpoint || bearer !== endpoint.key) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'A valid key is required.' }));
      return;
    }

    // The proxy speaks the full MCP protocol over streamable HTTP, per connector: the path
    // carries the connector id and the proxy owns parsing, listing, calls and approvals.
    endpoint.handle(req, res);
  }

  /**
   * `POST /upload`: the desktop app sends a file the user dropped on the window.
   *
   * The access key travels in the Authorization header only (never the address, which ends up in
   * logs), a foreign origin is refused before anything is read, and the store enforces the size
   * limits while the body streams so a refused file never lands on disk.
   */
  private handleUpload(req: IncomingMessage, res: import('http').ServerResponse): void {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    const allowOrigin = origin && this.allowedOrigins.has(origin) ? origin : undefined;
    const cors: Record<string, string> = allowOrigin
      ? {
          'Access-Control-Allow-Origin': allowOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'authorization, x-file-name, x-upload-id, content-type',
        }
      : {};

    if (origin !== undefined && !allowOrigin) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'origin_refused', message: 'That origin is not allowed.' }));
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { ...cors, Allow: 'POST, OPTIONS' });
      res.end();
      return;
    }

    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
    if (bearer !== this.getAuthToken()) {
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'A valid access key is required.' }));
      return;
    }

    const rawName = typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : '';
    const name = rawName === '' ? '' : decodeURIComponent(rawName);
    if (name.trim() === '') {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'name_required', message: 'A file name is required.' }));
      return;
    }

    const uploadId = typeof req.headers['x-upload-id'] === 'string' ? req.headers['x-upload-id'] : undefined;
    const declared = Number(req.headers['content-length'] ?? 0);
    const store = this.uploads;
    if (!store) {
      res.writeHead(503, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'uploads_unavailable', message: 'Uploads are not available.' }));
      return;
    }

    // A body that stops mid-flight leaves nothing behind: the store destroys what it wrote.
    req.on('aborted', () => req.destroy());

    void store
      .receive(req, { name, ...(declared > 0 ? { length: declared } : {}), ...(uploadId ? { uploadId } : {}) })
      .then((outcome) => {
        if (outcome.ok) {
          res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
          res.end(JSON.stringify(outcome.file));
          return;
        }
        res.writeHead(outcome.status, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: outcome.code, message: outcome.message }));
      })
      .catch((error: Error) => {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'upload_failed', message: error.message }));
      });
  }

  /**
   * The client protocol's handshake: same daemon token, no connector type. A window gets the
   * flat `ready` the protocol expects, and from then on its frames go to `onAppMessage`.
   */
  private handleAppHello(ws: WebSocket, message: { token?: string; protocol?: number }): string | null {
    if (message.protocol !== PROTOCOL_VERSION) {
      this.sendAppError(ws, 'PROTOCOL_MISMATCH', `Expected protocol v${PROTOCOL_VERSION}, got v${message.protocol}`);
      ws.close(CloseCode.badProtocol, 'Protocol mismatch');
      return null;
    }
    if (!message.token || message.token !== this.getAuthToken()) {
      this.sendAppError(ws, 'INVALID_TOKEN', 'Invalid authentication token');
      ws.close(CloseCode.unauthorized, 'Invalid token');
      return null;
    }

    const clientId = `app-${++this.appSeq}`;
    this.appClients.set(clientId, ws);
    ws.on('close', () => {
      this.appClients.delete(clientId);
      // Whoever was signed in from that window is gone: the daemon cancels what it owned.
      this.emit('onAppDisconnect', clientId);
    });
    const model = this.modelName?.();
    this.sendApp(ws, 'ready', {
      protocol: PROTOCOL_VERSION,
      agentState: 'idle',
      clientId,
      ...(model ? { model } : {}),
    });
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

  /** Sends one flat frame to every connected window. */
  broadcastApps(type: string, payload: unknown): number {
    let sent = 0;
    for (const ws of this.appClients.values()) {
      if (this.sendApp(ws, type, payload)) sent++;
    }
    return sent;
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
  /** Where an uploaded file goes; set by the daemon once its workspace is known. */
  uploads: UploadStore | null = null;

  /**
   * The connectors' MCP endpoint: the address the engine's server list points at, the key that
   * launch was given, and what to list and call. The daemon owns the answers; the server only
   * speaks JSON-RPC and checks the key.
   */
  mcpEndpoint: {
    key: string;
    handle(req: IncomingMessage, res: import('http').ServerResponse): void;
  } | null = null;

  /**
   * Origins the desktop app's windows come from. Anything else is refused, here and on the upload
   * endpoint, because a page the user happens to open must not drive their assistant.
   */
  allowedOrigins = new Set<string>(['tauri://localhost', 'https://tauri.localhost']);

  /** Names the model the assistant is running, for the window's ready frame. */
  modelName: (() => string | undefined) | null = null;

  /** Windows connected over the client protocol (flat frames), by client id. */
  private appClients = new Map<string, WebSocket>();
  private appSeq = 0;

  private getAuthToken(): string {
    if (this.authToken === undefined) {
      throw new Error('The WebSocket server has no access key: start() was never called.');
    }
    return this.authToken;
  }
}
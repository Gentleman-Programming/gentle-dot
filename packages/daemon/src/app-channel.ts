/**
 * App Channel - Unix socketpair for desktop app communication (S25.1)
 * Hereda el socketpair del desktop app para comunicación bidireccional
 */

import { createServer, Server as NetServer, Socket } from 'net';
import { EventEmitter } from 'events';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

export interface AppChannelConfig {
  socketPath: string;
  daemonPort: number;
}

export interface AppMessage {
  type: string;
  payload: unknown;
  requestId?: string;
  timestamp: number;
}

export interface AppChannelEvents {
  onConnect: (clientId: string) => void;
  onDisconnect: (clientId: string) => void;
  onMessage: (clientId: string, message: AppMessage) => void;
  onError: (clientId: string | null, error: Error) => void;
}

const DEFAULT_SOCKET_PATH = path.join(
  process.env['HOME'] || '/tmp',
  '.gentle-dot',
  'app-channel.sock'
);

export class AppChannel extends EventEmitter {
  private server: NetServer | null = null;
  private clients = new Map<string, Socket>();
  private config: AppChannelConfig;
  private messageHandlers = new Map<string, (payload: unknown) => Promise<unknown>>();

  constructor(config?: Partial<AppChannelConfig>) {
    super();
    this.config = {
      socketPath: config?.socketPath || DEFAULT_SOCKET_PATH,
      daemonPort: config?.daemonPort || 4317,
    };

    // Register default handlers
    this.registerHandler('daemon_status', this.handleDaemonStatus.bind(this));
    this.registerHandler('connector_list', this.handleConnectorList.bind(this));
    this.registerHandler('connector_status', this.handleConnectorStatus.bind(this));
  }

  /**
   * Start the Unix socket server
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Remove existing socket file
      try {
        if (fs.existsSync(this.config.socketPath)) {
          fs.unlinkSync(this.config.socketPath);
        }
      } catch (error) {
        console.warn('[AppChannel] Could not remove existing socket:', error);
      }

      // Ensure directory exists
      const dir = path.dirname(this.config.socketPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this.server = createServer((socket) => this.handleConnection(socket));

      this.server.on('error', (error) => {
        console.error('[AppChannel] Server error:', error);
        this.emit('onError', null, error);
        reject(error);
      });

      this.server.listen(this.config.socketPath, () => {
        console.log(`[AppChannel] Listening on ${this.config.socketPath}`);
        // Set permissions to user-only
        try {
          fs.chmodSync(this.config.socketPath, 0o600);
        } catch {
          // Ignore chmod errors
        }
        resolve();
      });
    });
  }

  /**
   * Stop the Unix socket server
   */
  async stop(): Promise<void> {
    // Close all client connections
    for (const [id, socket] of this.clients.entries()) {
      socket.destroy();
    }
    this.clients.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Remove socket file
    try {
      if (fs.existsSync(this.config.socketPath)) {
        fs.unlinkSync(this.config.socketPath);
      }
    } catch {
      // Ignore
    }

    console.log('[AppChannel] Stopped');
  }

  /**
   * Handle new client connection
   */
  private handleConnection(socket: Socket): void {
    const clientId = randomUUID();
    console.log(`[AppChannel] Client connected: ${clientId}`);

    this.clients.set(clientId, socket);
    this.emit('onConnect', clientId);

    let buffer = '';

    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      this.processBuffer(clientId, buffer);
    });

    socket.on('close', () => {
      console.log(`[AppChannel] Client disconnected: ${clientId}`);
      this.clients.delete(clientId);
      this.emit('onDisconnect', clientId);
    });

    socket.on('error', (error) => {
      console.error(`[AppChannel] Client error (${clientId}):`, error);
      this.emit('onError', clientId, error);
    });

    // Send welcome message
    this.send(clientId, 'welcome', {
      daemonPort: this.config.daemonPort,
      protocolVersion: 1,
    });
  }

  /**
   * Process incoming buffer for complete messages
   */
  private processBuffer(clientId: string, buffer: string): string {
    const lines = buffer.split('\n');
    const incomplete = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as AppMessage;
        this.handleMessage(clientId, message);
      } catch (error) {
        console.error(`[AppChannel] Parse error from ${clientId}:`, error);
        this.sendError(clientId, 'PARSE_ERROR', 'Invalid JSON');
      }
    }

    return incomplete;
  }

  /**
   * Handle incoming message
   */
  private async handleMessage(clientId: string, message: AppMessage): Promise<void> {
    this.emit('onMessage', clientId, message);

    // Handle request-response pattern
    if (message.requestId) {
      const handler = this.messageHandlers.get(message.type);
      if (handler) {
        try {
          const result = await handler(message.payload);
          this.send(clientId, message.type + '_response', result, message.requestId);
        } catch (error) {
          this.sendError(clientId, 'HANDLER_ERROR', (error as Error).message, message.requestId);
        }
      } else {
        this.sendError(clientId, 'UNKNOWN_TYPE', `Unknown message type: ${message.type}`, message.requestId);
      }
    }
  }

  /**
   * Send message to client
   */
  send(clientId: string, type: string, payload: unknown, requestId?: string): boolean {
    const socket = this.clients.get(clientId);
    if (!socket || socket.destroyed) {
      return false;
    }

    const message: AppMessage = {
      type,
      payload,
      requestId,
      timestamp: Date.now(),
    };

    try {
      socket.write(JSON.stringify(message) + '\n');
      return true;
    } catch (error) {
      console.error(`[AppChannel] Send error to ${clientId}:`, error);
      return false;
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(type: string, payload: unknown): number {
    let sent = 0;
    for (const clientId of this.clients.keys()) {
      if (this.send(clientId, type, payload)) {
        sent++;
      }
    }
    return sent;
  }

  /**
   * Send error response
   */
  sendError(clientId: string, code: string, message: string, requestId?: string): void {
    this.send(clientId, 'error', { code, message }, requestId);
  }

  /**
   * Register a message handler for request-response
   */
  registerHandler(type: string, handler: (payload: unknown) => Promise<unknown>): void {
    this.messageHandlers.set(type, handler);
  }

  /**
   * Unregister a message handler
   */
  unregisterHandler(type: string): void {
    this.messageHandlers.delete(type);
  }

  /**
   * Get connected client count
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get list of connected client IDs
   */
  getClientIds(): string[] {
    return Array.from(this.clients.keys());
  }

  // Default handlers

  private async handleDaemonStatus(): Promise<unknown> {
    return {
      status: 'running',
      port: this.config.daemonPort,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
    };
  }

  private async handleConnectorList(): Promise<unknown> {
    // This will be populated by the daemon
    return { connectors: [] };
  }

  private async handleConnectorStatus(payload: unknown): Promise<unknown> {
    // This will be populated by the daemon
    return { status: 'unknown' };
  }
}

/**
 * App Channel Client - for desktop app to connect to daemon
 */
export class AppChannelClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private requestId = 0;
  private buffer = '';

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath || DEFAULT_SOCKET_PATH;
  }

  /**
   * Connect to the daemon's app channel
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new Socket();

      this.socket.on('connect', () => {
        console.log('[AppChannelClient] Connected to daemon');
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      this.socket.on('close', () => {
        console.log('[AppChannelClient] Disconnected from daemon');
        this.emit('disconnect');
      });

      this.socket.on('error', (error) => {
        console.error('[AppChannelClient] Error:', error);
        this.emit('error', error);
        reject(error);
      });

      this.socket.connect(this.socketPath);
    });
  }

  /**
   * Disconnect from daemon
   */
  async disconnect(): Promise<void> {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  /**
   * Send request and wait for response
   */
  async request(type: string, payload: unknown): Promise<unknown> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected');
    }

    const id = `req-${++this.requestId}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const message: AppMessage = {
        type,
        payload,
        requestId: id,
        timestamp: Date.now(),
      };

      this.socket!.write(JSON.stringify(message) + '\n');

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${type} timed out`));
        }
      }, 10000);
    });
  }

  /**
   * Send notification (no response expected)
   */
  notify(type: string, payload: unknown): void {
    if (!this.socket || this.socket.destroyed) {
      return;
    }

    const message: AppMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };

    this.socket.write(JSON.stringify(message) + '\n');
  }

  /**
   * Process incoming buffer
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as AppMessage;

        if (message.requestId && this.pendingRequests.has(message.requestId)) {
          const { resolve, reject } = this.pendingRequests.get(message.requestId)!;
          this.pendingRequests.delete(message.requestId);

          if (message.type === 'error') {
            reject(new Error((message.payload as any)?.message || 'Unknown error'));
          } else {
            resolve(message.payload);
          }
        } else {
          // Unsolicited notification
          this.emit('notification', message.type, message.payload);
        }
      } catch (error) {
        console.error('[AppChannelClient] Parse error:', error);
      }
    }
  }
}
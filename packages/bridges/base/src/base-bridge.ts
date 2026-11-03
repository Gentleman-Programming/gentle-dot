/**
 * BaseBridge - Abstract base class for all connector bridges
 * Implements Bridge Protocol v1 handshake, heartbeat, and message routing
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';

export type BridgeStatus = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'error';

export interface BridgeConfig {
  daemonUrl: string;          // ws://host:port/ws
  connectorId: string;        // Unique identifier for this bridge instance
  connectorType: string;      // telegram, gmail, discord, whatsapp
  token: string;              // Authentication token
  capabilities: string[];     // List of capabilities this bridge provides
  metadata?: Record<string, unknown>;
  reconnectInterval?: number; // ms, default 5000
  maxReconnectAttempts?: number; // default 10
  heartbeatInterval?: number; // ms, default 30000
}

export interface BridgeMessage {
  type: string;
  payload: unknown;
  seq?: number;
  timestamp: number;
}

export interface HelloPayload {
  token: string;
  protocol: number;
  capabilities: string[];
  connectorType: string;
  connectorId: string;
  metadata?: Record<string, unknown>;
}

export interface ReadyPayload {
  sessionId: string;
  agentState: string;
  features: string[];
  daemonVersion: string;
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

export interface BridgeEvents {
  onStatusChange: (status: BridgeStatus) => void;
  onReady: (sessionId: string) => void;
  onChannelNotify: (payload: ChannelNotifyPayload) => void;
  onConnectorEvent: (payload: ConnectorEventPayload) => void;
  onCommand: (payload: CommandPayload) => Promise<CommandResultPayload>;
  onCommandResult: (payload: CommandResultPayload) => void;
  onError: (error: Error) => void;
  onDisconnect: (code: number, reason: string) => void;
}

type EventHandler<K extends keyof BridgeEvents> = BridgeEvents[K];

const PROTOCOL_VERSION = 1;
const DEFAULT_RECONNECT_INTERVAL = 5000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_HEARTBEAT_INTERVAL = 30000;

export abstract class BaseBridge extends EventEmitter {
  protected config: BridgeConfig;
  protected ws: WebSocket | null = null;
  protected status: BridgeStatus = 'disconnected';
  protected sessionId: string | null = null;
  protected reconnectAttempts = 0;
  protected reconnectTimer: NodeJS.Timeout | null = null;
  protected heartbeatTimer: NodeJS.Timeout | null = null;
  protected pendingPings = new Map<number, number>(); // seq -> timestamp
  protected pingSeq = 0;
  protected messageSeq = 0;

  constructor(config: BridgeConfig) {
    super();
    this.config = {
      reconnectInterval: DEFAULT_RECONNECT_INTERVAL,
      maxReconnectAttempts: DEFAULT_MAX_RECONNECT_ATTEMPTS,
      heartbeatInterval: DEFAULT_HEARTBEAT_INTERVAL,
      ...config,
    };
  }

  /**
   * Connect to the daemon
   */
  async connect(): Promise<void> {
    if (this.status === 'connecting' || this.status === 'authenticating' || this.status === 'ready') {
      return;
    }

    this.setStatus('connecting');
    console.log(`[${this.config.connectorType}] Connecting to ${this.config.daemonUrl}...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.daemonUrl);

      this.ws.on('open', () => {
        console.log(`[${this.config.connectorType}] WebSocket connected`);
        this.sendHello();
        this.setStatus('authenticating');
      });

      this.ws.on('message', (data: Buffer) => {
        this.handleMessage(data);
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        console.log(`[${this.config.connectorType}] Disconnected: ${code} ${reason.toString()}`);
        this.handleDisconnect(code, reason.toString());
      });

      this.ws.on('error', (error: Error) => {
        console.error(`[${this.config.connectorType}] WebSocket error:`, error);
        this.emit('onError', error);
        if (this.status === 'connecting' || this.status === 'authenticating') {
          reject(error);
        }
      });

      // Connection timeout
      setTimeout(() => {
        if (this.status === 'connecting' || this.status === 'authenticating') {
          this.ws?.close();
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Disconnect from the daemon
   */
  async disconnect(): Promise<void> {
    this.clearTimers();

    if (this.ws) {
      this.sendDisconnect();
      this.ws.close(1000, 'Bridge disconnecting');
      this.ws = null;
    }

    this.setStatus('disconnected');
    this.reconnectAttempts = 0;
  }

  /**
   * Send hello message (handshake step 1)
   */
  protected sendHello(): void {
    const payload: HelloPayload = {
      token: this.config.token,
      protocol: PROTOCOL_VERSION,
      capabilities: this.config.capabilities,
      connectorType: this.config.connectorType,
      connectorId: this.config.connectorId,
      metadata: this.config.metadata,
    };

    this.send('hello', payload);
  }

  /**
   * Handle incoming messages
   */
  protected handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString()) as BridgeMessage;

      if (!message.type || typeof message.timestamp !== 'number') {
        console.warn(`[${this.config.connectorType}] Invalid message format`);
        return;
      }

      // Base lifecycle first: status, heartbeat and the onReady hook depend on these.
      switch (message.type) {
        case 'ready':
          this.handleReady(message.payload as ReadyPayload);
          break;
        case 'ping':
          this.handlePing(message.payload as { seq: number; ts: number });
          break;
        case 'pong':
          this.handlePong(message.payload as { seq: number });
          break;
        default:
          break;
      }

      // The subclass sees every message (lifecycle included) for its own state.
      this.handleConnectorMessage(message);
    } catch (error) {
      console.error(`[${this.config.connectorType}] Parse error:`, error);
    }
  }

  /**
   * Connector-specific message handling. Called for every daemon message after
   * the base lifecycle (ready/ping/pong) ran, so overriding this — unlike the
   * old handleMessage override — never bypasses the handshake state machine.
   */
  protected abstract handleConnectorMessage(message: BridgeMessage): void;

  /**
   * Handle ready response (handshake step 2)
   */
  protected handleReady(payload: ReadyPayload): void {
    this.sessionId = payload.sessionId;
    this.reconnectAttempts = 0;
    this.setStatus('ready');
    this.startHeartbeat();
    this.emit('onReady', payload.sessionId);
    console.log(`[${this.config.connectorType}] Ready (session: ${payload.sessionId})`);
    // The subclass lifecycle starts only after the daemon handshake succeeded.
    void this.onReady().catch((error) => {
      console.error(`[${this.config.connectorType}] onReady failed:`, error);
      this.emit('onError', error);
    });
  }

  /**
   * Handle ping from daemon
   */
  protected handlePing(payload: { seq: number; ts: number }): void {
    this.send('pong', { seq: payload.seq });
  }

  /**
   * Handle pong from daemon
   */
  protected handlePong(payload: { seq: number }): void {
    const sentTime = this.pendingPings.get(payload.seq);
    if (sentTime !== undefined) {
      const latency = Date.now() - sentTime;
      this.pendingPings.delete(payload.seq);
      // Could emit latency metric
    }
  }

  /**
   * Handle channel notification from daemon
   */
  protected handleChannelNotify(payload: ChannelNotifyPayload): void {
    this.emit('onChannelNotify', payload);
  }

  /**
   * Handle connector event from daemon
   */
  protected handleConnectorEvent(payload: ConnectorEventPayload): void {
    this.emit('onConnectorEvent', payload);
  }

  /**
   * Handle command from daemon
   */
  protected async handleCommand(payload: CommandPayload): Promise<void> {
    try {
      const result = await this.emit('onCommand', payload);
      const commandResult: CommandResultPayload = {
        commandId: payload.commandId,
        success: true,
        result,
      };
      this.send('command_result', commandResult);
    } catch (error) {
      const commandResult: CommandResultPayload = {
        commandId: payload.commandId,
        success: false,
        error: (error as Error).message,
      };
      this.send('command_result', commandResult);
    }
  }

  /**
   * Handle command result from daemon
   */
  protected handleCommandResult(payload: CommandResultPayload): void {
    this.emit('onCommandResult', payload);
  }

  /**
   * Handle error from daemon
   */
  protected handleError(payload: { code: string; message: string; details?: unknown }): void {
    console.error(`[${this.config.connectorType}] Daemon error: ${payload.code} - ${payload.message}`);
    this.emit('onError', new Error(`${payload.code}: ${payload.message}`));
  }

  /**
   * Handle disconnection
   */
  protected handleDisconnect(code: number, reason: string): void {
    this.clearTimers();
    this.setStatus('disconnected');
    this.emit('onDisconnect', code, reason);

    // Attempt reconnection if not intentionally closed
    if (code !== 1000 && this.reconnectAttempts < (this.config.maxReconnectAttempts || DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection attempt
   */
  protected scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = this.config.reconnectInterval || DEFAULT_RECONNECT_INTERVAL;

    console.log(`[${this.config.connectorType}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error(`[${this.config.connectorType}] Reconnect failed:`, error);
      });
    }, delay);
  }

  /**
   * Start heartbeat mechanism
   */
  protected startHeartbeat(): void {
    const interval = this.config.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;

    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const seq = ++this.pingSeq;
        this.pendingPings.set(seq, Date.now());
        this.send('ping', { seq, ts: Date.now() });

        // Check for stale pings
        for (const [pingSeq, sentTime] of this.pendingPings.entries()) {
          if (Date.now() - sentTime > interval * 2) {
            console.warn(`[${this.config.connectorType}] Heartbeat timeout, reconnecting`);
            this.ws?.close(1001, 'Heartbeat timeout');
            break;
          }
        }
      }
    }, interval);
  }

  /**
   * Send a message to the daemon
   */
  protected send(type: string, payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const message: BridgeMessage = {
      type,
      payload,
      seq: ++this.messageSeq,
      timestamp: Date.now(),
    };

    this.ws.send(JSON.stringify(message));
  }

  /**
   * Send disconnect message
   */
  protected sendDisconnect(): void {
    this.send('disconnect', {});
  }

  /**
   * Send channel notification to daemon
   */
  sendChannelNotify(channelId: string, event: string, data: unknown): void {
    this.send('channel_notify', { channelId, event, data });
  }

  /**
   * Send connector event to daemon
   */
  sendConnectorEvent(event: string, data: unknown): void {
    this.send('connector_event', {
      connectorId: this.config.connectorId,
      event,
      data,
    });
  }

  /**
   * Send command to daemon
   */
  sendCommand(action: string, params: Record<string, unknown>): Promise<CommandResultPayload> {
    return new Promise((resolve, reject) => {
      const commandId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      const handler = (result: CommandResultPayload) => {
        if (result.commandId === commandId) {
          this.off('onCommandResult', handler);
          if (result.success) {
            resolve(result);
          } else {
            reject(new Error(result.error || 'Command failed'));
          }
        }
      };

      this.on('onCommandResult', handler);

      // Timeout
      setTimeout(() => {
        this.off('onCommandResult', handler);
        reject(new Error('Command timeout'));
      }, 30000);

      this.send('command', {
        commandId,
        connectorId: this.config.connectorId,
        action,
        params,
      });
    });
  }

  /**
   * Get current connection status
   */
  getStatus(): BridgeStatus {
    return this.status;
  }

  /**
   * Get session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Check if connected and ready
   */
  isReady(): boolean {
    return this.status === 'ready' && this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Set status and emit event
   */
  protected setStatus(status: BridgeStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.emit('onStatusChange', status);
    }
  }

  /**
   * Clear all timers
   */
  protected clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.pendingPings.clear();
}

  /**
   * Subscribe to bridge events
   */
  override on<K extends keyof BridgeEvents>(event: K, handler: EventHandler<K>): this {
    super.on(event, handler);
    return this;
  }
  /**
   * Abstract method to be implemented by subclasses
   * Called when bridge is ready to start its specific logic
   */
  abstract onReady(): Promise<void>;

  /**
   * Abstract method to be implemented by subclasses
   * Called when bridge needs to stop its specific logic
   */
  abstract onStop(): Promise<void>;
}

/**
 * Load bridge configuration from YAML file
 */
export function loadBridgeConfig(configPath: string): BridgeConfig {
  const fileContent = fs.readFileSync(configPath, 'utf-8');
  const yaml = require('yaml');
  const parsed = yaml.parse(fileContent);

  if (!parsed) {
    throw new Error('Config file is empty or invalid YAML');
  }

  return parsed as BridgeConfig;
}

/**
 * Create bridge config from environment variables
 */
export function createBridgeConfigFromEnv(connectorType: string): BridgeConfig {
  const daemonHost = process.env['DAEMON_HOST'] || '127.0.0.1';
  const daemonPort = process.env['DAEMON_PORT'] || '4317';
  const token = process.env['BRIDGE_AUTH_TOKEN'] || 'gentle-dot-bridge-secret';

  return {
    daemonUrl: `ws://${daemonHost}:${daemonPort}/ws`,
    connectorId: `${connectorType}-${process.env['HOSTNAME'] || 'local'}-${process.pid}`,
    connectorType,
    token,
    capabilities: [],
    metadata: {},
  };
}
/**
 * BaseBridge - Abstract base class for all connector bridges
 * Implements Bridge Protocol v1 handshake, heartbeat, and message routing
 */
import WebSocket from 'ws';
import { EventEmitter } from 'events';
export type BridgeStatus = 'disconnected' | 'connecting' | 'authenticating' | 'ready' | 'error';
export interface BridgeConfig {
    daemonUrl: string;
    connectorId: string;
    connectorType: string;
    token: string;
    capabilities: string[];
    metadata?: Record<string, unknown>;
    reconnectInterval?: number;
    maxReconnectAttempts?: number;
    heartbeatInterval?: number;
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
export declare abstract class BaseBridge extends EventEmitter {
    protected config: BridgeConfig;
    protected ws: WebSocket | null;
    protected status: BridgeStatus;
    protected sessionId: string | null;
    protected reconnectAttempts: number;
    protected reconnectTimer: NodeJS.Timeout | null;
    protected heartbeatTimer: NodeJS.Timeout | null;
    protected pendingPings: Map<number, number>;
    protected pingSeq: number;
    protected messageSeq: number;
    constructor(config: BridgeConfig);
    /**
     * Connect to the daemon
     */
    connect(): Promise<void>;
    /**
     * Disconnect from the daemon
     */
    disconnect(): Promise<void>;
    /**
     * Send hello message (handshake step 1)
     */
    protected sendHello(): void;
    /**
     * Handle incoming messages
     */
    protected handleMessage(data: Buffer): void;
    /**
     * Handle ready response (handshake step 2)
     */
    protected handleReady(payload: ReadyPayload): void;
    /**
     * Handle ping from daemon
     */
    protected handlePing(payload: {
        seq: number;
        ts: number;
    }): void;
    /**
     * Handle pong from daemon
     */
    protected handlePong(payload: {
        seq: number;
    }): void;
    /**
     * Handle channel notification from daemon
     */
    protected handleChannelNotify(payload: ChannelNotifyPayload): void;
    /**
     * Handle connector event from daemon
     */
    protected handleConnectorEvent(payload: ConnectorEventPayload): void;
    /**
     * Handle command from daemon
     */
    protected handleCommand(payload: CommandPayload): Promise<void>;
    /**
     * Handle command result from daemon
     */
    protected handleCommandResult(payload: CommandResultPayload): void;
    /**
     * Handle error from daemon
     */
    protected handleError(payload: {
        code: string;
        message: string;
        details?: unknown;
    }): void;
    /**
     * Handle disconnection
     */
    protected handleDisconnect(code: number, reason: string): void;
    /**
     * Schedule reconnection attempt
     */
    protected scheduleReconnect(): void;
    /**
     * Start heartbeat mechanism
     */
    protected startHeartbeat(): void;
    /**
     * Send a message to the daemon
     */
    protected send(type: string, payload: unknown): void;
    /**
     * Send disconnect message
     */
    protected sendDisconnect(): void;
    /**
     * Send channel notification to daemon
     */
    sendChannelNotify(channelId: string, event: string, data: unknown): void;
    /**
     * Send connector event to daemon
     */
    sendConnectorEvent(event: string, data: unknown): void;
    /**
     * Send command to daemon
     */
    sendCommand(action: string, params: Record<string, unknown>): Promise<CommandResultPayload>;
    /**
     * Get current connection status
     */
    getStatus(): BridgeStatus;
    /**
     * Get session ID
     */
    getSessionId(): string | null;
    /**
     * Check if connected and ready
     */
    isReady(): boolean;
    /**
     * Set status and emit event
     */
    protected setStatus(status: BridgeStatus): void;
    /**
     * Clear all timers
     */
    protected clearTimers(): void;
    /**
     * Subscribe to bridge events
     */
    on<K extends keyof BridgeEvents>(event: K, handler: EventHandler<K>): this;
    /**
     * Abstract method to be implemented by subclasses
     * Called when bridge needs to stop its specific logic
     */
    abstract onStop(): Promise<void>;
}
/**
 * Load bridge configuration from YAML file
 */
export declare function loadBridgeConfig(configPath: string): BridgeConfig;
/**
 * Create bridge config from environment variables
 */
export declare function createBridgeConfigFromEnv(connectorType: string): BridgeConfig;
export {};
//# sourceMappingURL=base-bridge.d.ts.map
/**
 * Connector Registry - In-memory registry for connected bridges
 * Implements Regla de Oro #4: Registry en memoria, no BD
 */

import { EventEmitter } from 'events';

/** Tipos de conector aceptados en el handshake (Regla de Oro #5). */
export const CONNECTOR_TYPES = [
  'telegram',
  'gmail',
  'discord',
  'whatsapp',
  'linear',
  'notion',
  'atlassian',
  'slack',
  'voice',
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];
export type ConnectorStatus = 'connecting' | 'ready' | 'disconnected' | 'error';

export interface ConnectorInfo {
  connectorId: string;
  type: ConnectorType;
  status: ConnectorStatus;
  connectedAt: number;
  lastPing: number;
  capabilities: string[];
  metadata: Record<string, unknown>;
  ws?: unknown; // Reference to WebSocket for message routing
}

export interface ConnectorRegistryEvents {
  onConnectorRegistered: (info: ConnectorInfo) => void;
  onConnectorUnregistered: (connectorId: string) => void;
  onConnectorStatusChange: (connectorId: string, status: ConnectorStatus) => void;
  onHeartbeat: (connectorId: string) => void;
}

type EventHandler = (...args: unknown[]) => void;

export class ConnectorRegistry extends EventEmitter {
  private connectors = new Map<string, ConnectorInfo>();

  /**
   * Register a new connector
   */
  register(info: ConnectorInfo): void {
    if (this.connectors.has(info.connectorId)) {
      throw new Error(`Connector ${info.connectorId} already registered`);
    }

    this.connectors.set(info.connectorId, {
      ...info,
      connectedAt: info.connectedAt || Date.now(),
      lastPing: info.lastPing || Date.now(),
    });

    this.emit('onConnectorRegistered', this.connectors.get(info.connectorId)!);
  }

  /**
   * Unregister a connector
   */
  unregister(connectorId: string): boolean {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return false;
    }

    this.connectors.delete(connectorId);
    this.emit('onConnectorUnregistered', connectorId);
    return true;
  }

  /**
   * Get connector by ID
   */
  get(connectorId: string): ConnectorInfo | undefined {
    return this.connectors.get(connectorId);
  }

  /**
   * List all connectors
   */
  list(): ConnectorInfo[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Get connectors by type
   */
  getByType(type: ConnectorType): ConnectorInfo[] {
    return this.list().filter((c) => c.type === type);
  }

  /**
   * Update connector status
   */
  updateStatus(connectorId: string, status: ConnectorStatus): boolean {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return false;
    }

    const oldStatus = connector.status;
    connector.status = status;
    connector.lastPing = Date.now();

    if (oldStatus !== status) {
      this.emit('onConnectorStatusChange', connectorId, status);
    }
    return true;
  }

  /**
   * Update heartbeat timestamp
   */
  updateHeartbeat(connectorId: string): boolean {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return false;
    }
    connector.lastPing = Date.now();
    this.emit('onHeartbeat', connectorId);
    return true;
  }

  /**
   * Update connector capabilities
   */
  updateCapabilities(connectorId: string, capabilities: string[]): boolean {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return false;
    }
    connector.capabilities = capabilities;
    return true;
  }

  /**
   * Update connector metadata
   */
  updateMetadata(connectorId: string, metadata: Record<string, unknown>): boolean {
    const connector = this.connectors.get(connectorId);
    if (!connector) {
      return false;
    }
    connector.metadata = { ...connector.metadata, ...metadata };
    return true;
  }

  /**
   * Get count of connected (ready) connectors
   */
  getReadyCount(): number {
    return this.list().filter((c) => c.status === 'ready').length;
  }

  /**
   * Get count of all registered connectors
   */
  getTotalCount(): number {
    return this.connectors.size;
  }

  /**
   * Check if a connector type is connected
   */
  hasTypeReady(type: ConnectorType): boolean {
    return this.getByType(type).some((c) => c.status === 'ready');
  }

  /**
   * Clean up stale connections (no heartbeat for > 60s)
   */
  cleanupStale(maxAgeMs: number = 60000): string[] {
    const now = Date.now();
    const stale: string[] = [];

    for (const [id, connector] of this.connectors.entries()) {
      if (now - connector.lastPing > maxAgeMs) {
        this.unregister(id);
        stale.push(id);
      }
    }

    return stale;
  }

  /**
   * Clear all connectors (for shutdown)
   */
  clear(): void {
    const ids = Array.from(this.connectors.keys());
    for (const id of ids) {
      this.unregister(id);
    }
  }
}

/**
 * Singleton instance for global access
 */
export const connectorRegistry = new ConnectorRegistry();
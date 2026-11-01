/**
 * Daemon Package - Main exports
 */

export { Daemon, createDaemon } from './daemon.js';
export type { DaemonOptions } from './daemon.js';

export { WsServer } from './ws-server.js';
export type { BridgeMessage, BridgeMessageType, HelloPayload, ReadyPayload } from './ws-server.js';

export { ConnectorRegistry, connectorRegistry } from './connector-registry.js';
export type { ConnectorInfo, ConnectorType, ConnectorStatus } from './connector-registry.js';

export { GentleShellSpawner, gentleShellSpawner, IDENTITY_PROMPT } from './gentle-shell-spawner.js';
export type { ShellConfig, ShellSpawnOptions } from './gentle-shell-spawner.js';

export { McpProxy } from './mcp-proxy.js';
export type { McpServerConfig, McpMode, McpTool, ApprovalRequest, ApprovalResponse } from './mcp-proxy.js';

export { AppChannel, AppChannelClient } from './app-channel.js';
export type { AppMessage, AppChannelConfig } from './app-channel.js';

export { loadConfig, loadAndValidateConfig, validateConfig, watchConfig, getDefaultConfigPath } from './config-loader.js';
export type { AppConfig, DaemonConfig, ConnectorsConfig, ValidationResult } from './config-loader.js';
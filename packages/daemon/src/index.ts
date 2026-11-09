/**
 * Daemon Package - Main exports
 */

export { Daemon, createDaemon } from './daemon.ts';
export type { DaemonOptions } from './daemon.ts';

export { WsServer } from './ws-server.ts';
export type { BridgeMessage, BridgeMessageType, HelloPayload, ReadyPayload } from './ws-server.ts';

export { ConnectorRegistry, connectorRegistry } from './connector-registry.ts';
export type { ConnectorInfo, ConnectorType, ConnectorStatus } from './connector-registry.ts';

export { GentleShellSpawner, gentleShellSpawner, IDENTITY_PROMPT } from './gentle-shell-spawner.ts';
export type { ShellConfig, ShellSpawnOptions } from './gentle-shell-spawner.ts';

export { McpProxy } from './mcp-proxy.ts';
export type { McpProxyOptions, ProxiedConnector, UpstreamCredentials, ApprovalPreview } from './mcp-proxy.ts';

export { AppChannel, AppChannelClient } from './app-channel.ts';
export type { AppMessage, AppChannelConfig } from './app-channel.ts';

export { loadConfig, loadAndValidateConfig, validateConfig, watchConfig, getDefaultConfigPath } from './config-loader.ts';
export type { AppConfig, DaemonConfig, ConnectorsConfig, ValidationResult } from './config-loader.ts';
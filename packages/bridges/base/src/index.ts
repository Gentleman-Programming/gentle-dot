/**
 * Bridges Base Package - Main exports
 */

export { BaseBridge, loadBridgeConfig, createBridgeConfigFromEnv } from './base-bridge.js';
/** The two rules every channel transport owns, so no provider re-implements them (#48). */
export { brandInbound, createEchoGuard } from './channel-contract.js';
export type { MessageEchoGuard } from './channel-contract.js';
export type { 
  BridgeConfig, 
  BridgeStatus, 
  BridgeMessage, 
  BridgeEvents,
  HelloPayload,
  ReadyPayload,
  ChannelNotifyPayload,
  ConnectorEventPayload,
  CommandPayload,
  CommandResultPayload
} from './base-bridge.js';

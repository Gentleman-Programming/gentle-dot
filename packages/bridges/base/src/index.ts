/**
 * Bridges Base Package - Main exports
 */

export { BaseBridge, loadBridgeConfig, createBridgeConfigFromEnv } from './base-bridge.js';
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

/**
 * WhatsApp Connector - Main Exports
 */

export { WhatsAppBridge, type WhatsAppBridgeOptions } from './whatsapp-bridge.js';
export { type Config, loadConfig, type ConfigError, type MetaCloudConfig, isValidE164 } from './config.js';
export { RateLimiter } from './rate-limit.js';
export { loadAllowlistFile, saveAllowlistFile, resolveAllowlist, maskNumber, type AllowlistEntry } from './allowlist-store.js';
export { createTransportFactory, type ChannelTransport, type ChannelInbound, type TransportStateEvent, type TransportFactoryOptions } from './transport/factory.js';
export { createMetaCloudTransport } from './transport/meta-cloud.js';

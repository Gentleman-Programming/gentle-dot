/**
 * Gmail Connector - Main Exports
 */

export { GmailBridge, type GmailBridgeOptions } from './gmail-bridge.js';
export { type Config, loadConfig, type ConfigError, type GmailOAuthConfig } from './config.js';
export { GmailClient, extractTextFromMessage, getHeader, type SendMessageParams } from './gmail-client.js';
export { GmailTokenStore, createOAuth2Client, getValidAccessToken, generateAuthUrl, exchangeCodeForTokens, type GmailTokenData } from './auth/token-store.js';

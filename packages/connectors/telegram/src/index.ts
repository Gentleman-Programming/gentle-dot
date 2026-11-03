/**
 * Telegram Connector — public exports.
 */

export { TelegramBridge, type TelegramBridgeOptions } from './telegram-bridge.js';
export { type Config, loadConfig, ConfigError } from './config.js';
export { splitMessage, telegramDownloader, TELEGRAM_TEXT_LIMIT, TELEGRAM_DOWNLOAD_LIMIT } from './utils.js';
export { NicknameStore, type NicknameEntry } from './storage/nickname-store.js';
export { UploadRefused, UPLOAD_MAX_BASE64 } from './uploads.js';
export {
	PROTOCOL_VERSION,
	CloseCode,
	MAX_VOICE_AUDIO,
	type AgentState,
	type Ask,
	type AttachmentRef,
	type ClientMessage,
	type ServerMessage,
	type UploadedFile,
} from './protocol.js';

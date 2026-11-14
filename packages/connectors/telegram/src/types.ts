/**
 * Type definitions for Telegram connector
 */

import { Bot, Context } from 'grammy';

export type ConnectorType = 'telegram';
export type ConnectorStatus = 'connecting' | 'ready' | 'disconnected' | 'error';

export interface ConnectorConfig {
  connectorId: string;
  type: ConnectorType;
  daemonUrl: string;
  token: string;
  capabilities: string[];
  metadata?: Record<string, unknown>;
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

export interface PingPayload {
  seq: number;
  ts: number;
}

export interface PongPayload {
  seq: number;
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

export interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

export interface Upload {
  name: string;
  data: Buffer;
  uploadId?: string;
}

export interface UploadedFile {
  uploadId: string;
  name: string;
  url?: string;
}

export interface IncomingFile {
  fileId: string;
  name: string;
  size?: number;
}

export interface NicknameEntry {
  userId: string;
  nickname: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingAsk {
  requestId: string;
  chatId: number;
  messageId?: number;
  method: 'confirm' | 'input' | 'editor' | 'select' | 'app' | 'pin';
  title: string;
  message?: string;
  options?: string[];
}

export interface DaemonConnection {
  send(message: unknown): boolean;
}

export interface BridgeOptions {
  bot: Bot;
  daemon: DaemonConnection;
  allowedUsers: Set<number>;
  log(message: string): void;
  draftRefreshMs?: number;
  download?(filePath: string): Promise<Buffer>;
  upload?(file: Upload): Promise<UploadedFile>;
}

export interface Turn {
  chatId: number;
  draftId: number;
  draftText: string;
  sawBusy: boolean;
  refresh: NodeJS.Timeout;
}

export interface AgentState {
  state: 'idle' | 'thinking' | 'working' | 'needs_you' | 'error';
}

export interface Ask {
  requestId: string;
  title: string;
  message?: string;
  method: 'confirm' | 'input' | 'editor' | 'select' | 'app' | 'pin';
  options?: string[];
}

export interface ServerMessage {
  type: string;
  agentState?: string;
  voice?: { transcribe?: boolean };
  requestId?: string;
  text?: string;
  state?: string;
  activity?: { status: string; title: string };
  error?: string;
  stopped?: boolean;
  level?: string;
  message?: string;
  code?: string;
  ask?: Ask;
}

export interface ClientMessage {
  type: string;
  text?: string;
  attachments?: AttachmentRef[];
  requestId?: string;
  value?: unknown;
  confirmed?: boolean;
  cancelled?: boolean;
}

export interface AttachmentRef {
  uploadId: string;
  name: string;
}
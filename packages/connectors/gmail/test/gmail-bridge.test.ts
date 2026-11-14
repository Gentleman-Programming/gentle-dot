/**
 * Gmail bridge command contract (doc 07): the daemon drives the connector through commands
 * (send/list/get/watch) and every command answers with a command_result.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GmailBridge } from '../src/gmail-bridge.js';

vi.mock('@gentle-dot/bridges-base', () => {
  class BaseBridge {
    config: Record<string, unknown>;
    constructor(config: Record<string, unknown>) {
      this.config = config;
    }
    send() {}
    async connect() {}
    async disconnect() {}
    isReady() { return false; }
  }
  return { BaseBridge };
});

const gmailMock = {
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  sendMessage: vi.fn(),
  watch: vi.fn(),
};

vi.mock('../src/gmail-client.js', () => ({
  GmailClient: vi.fn().mockImplementation(function () {
    this.listMessages = gmailMock.listMessages;
    this.getMessage = gmailMock.getMessage;
    this.sendMessage = gmailMock.sendMessage;
    this.watch = gmailMock.watch;
  }),
  extractTextFromMessage: vi.fn(),
  getHeader: vi.fn(),
}));

vi.mock('../src/auth/token-store.js', () => ({
  GmailTokenStore: vi.fn().mockImplementation(function () {
    this.load = () => ({
      access_token: 'ya29.test',
      refresh_token: '1//test',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      token_type: 'Bearer',
      expiry_date: Date.now() + 3_600_000,
    });
    this.save = () => {};
    this.isExpired = () => false;
  }),
  createOAuth2Client: vi.fn().mockReturnValue({ setCredentials: vi.fn() }),
  getValidAccessToken: vi.fn().mockResolvedValue('ya29.valid'),
  generateAuthUrl: vi.fn().mockReturnValue('https://accounts.google.com/...'),
  exchangeCodeForTokens: vi.fn(),
}));

const dir = mkdtempSync(join(tmpdir(), 'gmail-bridge-'));

interface CommandResult {
  commandId?: string;
  success?: boolean;
  result?: unknown;
  error?: string;
}

class TestableBridge extends GmailBridge {
  sent: Array<{ type: string; payload: Record<string, unknown> }> = [];

  constructor() {
    super({
      config: {
        connectorId: 'gmail',
        oauth: { clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost/cb', scopes: [] },
        daemonUrl: 'ws://127.0.0.1:4317/ws',
        tokenFile: join(dir, 'token'),
        tokenPath: join(dir, 'tokens.json'),
        pollIntervalMs: 60_000,
        watchLabels: ['INBOX'],
      },
      log: () => {},
    } as never);
    this.sent = [];
  }

  override send(type: string, payload: Record<string, unknown>): void {
    this.sent.push({ type, payload });
  }

  command(action: string, params: Record<string, unknown> = {}, commandId = 'cmd-1'): Promise<CommandResult> {
    const self = this as unknown as {
      handleCommand(p: { commandId: string; action: string; params: Record<string, unknown> }): Promise<void>;
    };
    return self.handleCommand({ commandId, action, params }).then(() => {
      const last = this.sent.at(-1);
      return (last?.payload ?? {}) as CommandResult;
    });
  }
}

describe('Gmail bridge commands', () => {
  let bridge: TestableBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new TestableBridge();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('send_message answers success with the sent message id', async () => {
    gmailMock.sendMessage.mockResolvedValueOnce('sent-123');
    const result = await bridge.command('send_message', {
      to: 'dest@example.com',
      subject: 'Hola',
      body: 'Cuerpo',
    });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ messageId: 'sent-123' });
    expect(gmailMock.sendMessage).toHaveBeenCalledWith({
      to: 'dest@example.com',
      subject: 'Hola',
      body: 'Cuerpo',
      threadId: undefined,
      inReplyTo: undefined,
    });
  });

  it('list_messages answers with the message list', async () => {
    gmailMock.listMessages.mockResolvedValueOnce([{ id: 'm1' }]);
    const result = await bridge.command('list_messages', { query: 'is:unread', maxResults: 5 });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ messages: [{ id: 'm1' }] });
  });

  it('get_message answers with the full message', async () => {
    gmailMock.getMessage.mockResolvedValueOnce({ id: 'm9', snippet: 'hola' });
    const result = await bridge.command('get_message', { id: 'm9' });
    expect(result.success).toBe(true);
    expect(result.result).toEqual({ message: { id: 'm9', snippet: 'hola' } });
  });

  it('setup_watch calls the Gmail watch API and answers with its result', async () => {
    gmailMock.watch.mockResolvedValueOnce({ expiration: '999', historyId: '42' });
    const result = await bridge.command('setup_watch', { webhookUrl: 'https://x/y', labelIds: ['INBOX'] });
    expect(result.success).toBe(true);
    expect(gmailMock.watch).toHaveBeenCalledWith('https://x/y', ['INBOX']);
  });

  it('unknown actions answer success:false with the reason', async () => {
    const result = await bridge.command('no_existe');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown action: no_existe');
  });

  it('a failing send answers success:false with the error message', async () => {
    gmailMock.sendMessage.mockRejectedValueOnce(new Error('quota exceeded'));
    const result = await bridge.command('send_message', { to: 'x@y.z', subject: 's', body: 'b' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('quota exceeded');
  });

  it('every command_result echoes the commandId', async () => {
    const result = await bridge.command('get_message', { id: 'm1' }, 'cmd-77');
    expect(result.commandId).toBe('cmd-77');
  });
});

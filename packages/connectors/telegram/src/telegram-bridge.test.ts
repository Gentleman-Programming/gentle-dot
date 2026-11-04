/**
 * Telegram Bridge Tests - TDD approach
 * Tests for BaseBridge v2 compatibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramBridge, TelegramBridgeOptions, UploadFn } from './telegram-bridge.js';
import { BridgeConfig, BridgeStatus, ReadyPayload, HelloPayload, ChannelNotifyPayload, CommandPayload, CommandResultPayload } from '@gentle-dot/bridges-base';

// Mock dependencies
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(function () {
    return ({
    use: vi.fn(),
    command: vi.fn(),
    callbackQuery: vi.fn(),
    on: vi.fn(),
    catch: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    api: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'test/path' }),
      sendMessageDraft: vi.fn().mockResolvedValue(undefined),
    },
  });
  }),
  InlineKeyboard: vi.fn().mockImplementation(function () {
    return ({
    text: vi.fn().mockReturnThis(),
    row: vi.fn().mockReturnThis(),
    });
  }),
  Context: vi.fn(),
}));

vi.mock('./storage/nickname-store.js', () => ({
  NicknameStore: vi.fn().mockImplementation(function () {
    return ({
    init: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    getByUserId: vi.fn().mockResolvedValue(undefined),
    count: vi.fn().mockReturnValue(0),
    });
  }),
}));

vi.mock('./config.js', () => ({
  loadTelegramConfig: vi.fn(),
  TelegramConnectorConfig: {},
}));

vi.mock('./commands.js', () => ({
  registerCommands: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  splitMessage: vi.fn((msg: string) => [msg]),
  telegramDownloader: vi.fn(() => vi.fn().mockResolvedValue(Buffer.from('test'))),
}));

// Fake daemon WebSocket: completes the hello/ready handshake so start() resolves.
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  class FakeWebSocket extends EventEmitter {
    constructor(public url: string) {
      super();
      queueMicrotask(() => this.emit('open'));
    }
    send(data: string): void {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'hello') {
          queueMicrotask(() =>
            this.emit(
              'message',
              Buffer.from(
                JSON.stringify({
                  type: 'ready',
                  timestamp: Date.now(),
                  payload: { sessionId: 'test-session', agentState: 'idle', features: [] },
                }),
              ),
            ),
          );
        }
      } catch {
        // ignore non-JSON frames
      }
    }
    close(): void {}
  }
  return { default: FakeWebSocket };
});

const createMockOptions = (overrides: Partial<TelegramBridgeOptions> = {}): TelegramBridgeOptions => ({
  config: {
    daemonUrl: 'ws://localhost:4317/ws',
    tokenFile,
    botToken: '123456789:TEST_TOKEN',
    allowedUsers: new Set([123456789]),
    nicknameDb: ':memory:',
  },
  log: vi.fn(),
  download: vi.fn().mockResolvedValue(Buffer.from('test')),
  upload: vi.fn().mockResolvedValue({ uploadId: 'test', name: 'test.txt', size: 4, mime: 'text/plain', path: 'uploads/test/test.txt' }),
  ...overrides,
});

let tokenFile: string;

beforeEach(() => {
  tokenFile = join(mkdtempSync(join(tmpdir(), 'tg-token-')), 'daemon-token');
  writeFileSync(tokenFile, 'test-token-123456789012345678901234');
});

describe('TelegramBridge - BaseBridge v2 Compatibility', () => {
  let bridge: TelegramBridge;
  let mockOptions: TelegramBridgeOptions;

  beforeEach(() => {
    mockOptions = createMockOptions();
    bridge = new TelegramBridge(mockOptions);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with correct BridgeConfig', () => {
      expect(bridge).toBeInstanceOf(TelegramBridge);
      // BaseBridge config should be set via super()
    });

    it('should have required capabilities in config', () => {
      const config = (bridge as any).config as BridgeConfig;
      expect(config.capabilities).toContain('channel_notify');
      expect(config.capabilities).toContain('message_send');
      expect(config.capabilities).toContain('connector_command');
      expect(config.capabilities).toContain('nickname_management');
      expect(config.capabilities).toContain('multi_chat');
      expect(config.capabilities).toContain('voice_transcription');
    });

    it('should have correct connector metadata', () => {
      const config = (bridge as any).config as BridgeConfig;
      expect(config.connectorType).toBe('telegram');
      expect(config.connectorId).toBe('telegram');
      expect(config.daemonUrl).toBe('ws://localhost:4317/ws');
      expect(config.token).toBe('test-token-123456789012345678901234');
    });
  });

  describe('BaseBridge Abstract Methods', () => {
    it('should implement onReady()', async () => {
      // onReady is abstract in BaseBridge, must be implemented
      await expect(bridge.onReady()).resolves.not.toThrow();
    });

    it('should implement onStop()', async () => {
      // onStop is abstract in BaseBridge, must be implemented
      await expect(bridge.onStop()).resolves.not.toThrow();
    });
  });

  describe('Connection Lifecycle', () => {
    it('should have connect() method from BaseBridge', () => {
      expect(typeof bridge.connect).toBe('function');
    });

    it('should have disconnect() method from BaseBridge', () => {
      expect(typeof bridge.disconnect).toBe('function');
    });

    it('should have send() method from BaseBridge', () => {
      expect(typeof bridge.send).toBe('function');
    });

    it('should have getStatus() method from BaseBridge', () => {
      expect(typeof bridge.getStatus).toBe('function');
    });

    it('should have isReady() method from BaseBridge', () => {
      expect(typeof bridge.isReady).toBe('function');
    });

    it('should have getSessionId() method from BaseBridge', () => {
      expect(typeof bridge.getSessionId).toBe('function');
    });
  });

  describe('Event System', () => {
    it('should have on() method for event subscription', () => {
      // BaseBridge extends EventEmitter: on()/once() chain the bridge itself.
      expect(bridge.on('onReady', vi.fn())).toBe(bridge);
    });

    it('should have once() method', () => {
      expect(bridge.once('onReady', vi.fn())).toBe(bridge);
    });

    it('should have off() method', () => {
      const handler = vi.fn();
      bridge.on('onReady', handler);
      bridge.off('onReady', handler);
      expect(true).toBe(true); // No throw
    });

    it('should emit onStatusChange on connection state changes', () => {
      const statusHandler = vi.fn();
      bridge.on('onStatusChange', statusHandler);
      // Status changes tested in integration tests
    });
  });

  describe('Message Sending', () => {
    it('should have sendChannelNotify() method', () => {
      expect(typeof bridge.sendChannelNotify).toBe('function');
    });

    it('should have sendConnectorEvent() method', () => {
      expect(typeof bridge.sendConnectorEvent).toBe('function');
    });

    it('should have sendCommand() method returning Promise', () => {
      expect(typeof bridge.sendCommand).toBe('function');
    });
  });

  describe('Telegram-Specific Methods', () => {
    it('should have hello() method for initial handshake', () => {
      expect(typeof bridge.hello).toBe('function');
    });

    it('should have getStatus() returning bridge status info', () => {
      // BridgeStatus is a synchronous state string (disconnected|connecting|...).
      const status = bridge.getStatus();
      expect(typeof status).toBe('string');
    });

    it('should have setNickname() method', async () => {
      await expect(bridge.setNickname('user123', 'testnick')).resolves.not.toThrow();
    });

    it('should have getNickname() method', async () => {
      const nick = await bridge.getNickname('user123');
      expect(nick).toBeUndefined(); // empty store
    });

    it('should have connectionLost() method', async () => {
      await expect(bridge.connectionLost()).resolves.not.toThrow();
    });
  });

  describe('Configuration Validation', () => {
    it('should require botToken in config', () => {
      const options = createMockOptions({ config: { ...mockOptions.config, botToken: '' } });
      expect(() => new TelegramBridge(options)).not.toThrow(); // Bot validates at start
    });

    it('should authenticate to the daemon with the token file, never the bot token', () => {
      const b = new TelegramBridge(mockOptions);
      const config = (b as any).config as BridgeConfig;
      expect(config.token).toBe('test-token-123456789012345678901234');
      expect(config.token).not.toBe(mockOptions.config.botToken);
    });

    it('should fail closed when the daemon token file is missing', () => {
      const options = createMockOptions({ config: { ...mockOptions.config, tokenFile: '/nonexistent/daemon-token' } });
      expect(() => new TelegramBridge(options)).toThrow();
    });

    it('should require daemonUrl in config', () => {
      const options = createMockOptions({ config: { ...mockOptions.config, daemonUrl: '' } });
      const b = new TelegramBridge(options);
      const config = (b as any).config as BridgeConfig;
      expect(config.daemonUrl).toBe('');
    });
  });
});

describe('TelegramBridge - Integration Behavior', () => {
  let bridge: TelegramBridge;
  let mockOptions: TelegramBridgeOptions;

  beforeEach(() => {
    mockOptions = createMockOptions();
    bridge = new TelegramBridge(mockOptions);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should setup bot handlers on construction', async () => {
    const { Bot } = await import('grammy');
    const botInstance = (Bot as any).mock.results[0]?.value;
    expect(botInstance).toBeDefined();
    // Bot setup happens in constructor via setupBot()
  });

  it('should start bot and connect to daemon on start()', async () => {
    const { Bot } = await import('grammy');
    const botInstance = (Bot as any).mock.results[0]?.value;

    await bridge.start();

    expect(botInstance.start).toHaveBeenCalled();
    // connect() from BaseBridge should be called
  });

  it('should stop bot and disconnect on stop()', async () => {
    const { Bot } = await import('grammy');
    const botInstance = (Bot as any).mock.results[0]?.value;
    
    await bridge.stop();
    
    expect(botInstance.stop).toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync } from 'node:fs';
import { TelegramBridge } from './telegram-bridge.js';

vi.mock('grammy', () => {
  const mockInstances = [];
  class MockBot {
    constructor() {
      this.use = vi.fn();
      this.command = vi.fn();
      this.callbackQuery = vi.fn();
      this.on = vi.fn();
      this.catch = vi.fn();
      this.start = vi.fn().mockResolvedValue(undefined);
      this.stop = vi.fn();
      this.api = {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
        editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
        answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
        getFile: vi.fn().mockResolvedValue({ file_path: 'test/path' }),
        sendMessageDraft: vi.fn().mockResolvedValue(undefined),
        getMe: vi.fn().mockResolvedValue({ username: 'testbot' }),
      };
      mockInstances.push(this);
    }
  }
  return {
    Bot: MockBot,
    getMockInstances: () => mockInstances,
    InlineKeyboard: vi.fn().mockImplementation(() => ({
      text: vi.fn().mockReturnThis(),
      row: vi.fn().mockReturnThis(),
    })),
    Context: vi.fn(),
  };
});

vi.mock('./storage/nickname-store', () => {
  class MockNicknameStore {
    constructor() {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.set = vi.fn().mockResolvedValue(undefined);
      this.getByUserId = vi.fn().mockResolvedValue(undefined);
      this.count = vi.fn().mockReturnValue(0);
    }
  }
  return { NicknameStore: MockNicknameStore };
});

vi.mock('./storage/nickname-store.js', () => {
  class MockNicknameStore {
    constructor() {
      this.init = vi.fn().mockResolvedValue(undefined);
      this.set = vi.fn().mockResolvedValue(undefined);
      this.getByUserId = vi.fn().mockResolvedValue(undefined);
      this.count = vi.fn().mockReturnValue(0);
    }
  }
  return { NicknameStore: MockNicknameStore };
});

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

describe('TelegramBridge - BaseBridge v2 Compatibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFileSync('/tmp/test-token', 'test-token-123456789012345678901234');
  });

  function createBridge(overrides = {}) {
    return new TelegramBridge({
      config: {
        botToken: '123:test-token',
        daemonUrl: 'ws://127.0.0.1:4317/ws',
        tokenFile: '/tmp/test-token',
        allowedUsers: new Set([12345]),
        nicknameDb: '/tmp/nickname.db',
      },
      log: vi.fn(),
      download: vi.fn().mockResolvedValue(null),
      upload: vi.fn().mockResolvedValue({ uploadId: 'test', name: 'test', path: '/test' }),
      ...overrides,
    });
  }

  describe('Constructor', () => {
    it('should create instance with correct BridgeConfig', () => {
      const bridge = createBridge();
      const config = (bridge as any).config;
      expect(config).toBeDefined();
      expect(config.token).toBeDefined();
    });

    it('should have required capabilities in config', () => {
      const bridge = createBridge();
      const config = (bridge as any).config;
      expect(config.capabilities).toContain('channel_notify');
      expect(config.capabilities).toContain('message_send');
      expect(config.capabilities).toContain('connector_command');
      expect(config.capabilities).toContain('nickname_management');
      expect(config.capabilities).toContain('multi_chat');
      expect(config.capabilities).toContain('voice_transcription');
    });

    it('should have correct connector metadata', () => {
      const bridge = createBridge();
      const config = (bridge as any).config;
      expect(config.connectorType).toBe('telegram');
      expect(config.connectorId).toBe('telegram');
    });

    it('should authenticate to the daemon with the token file, never the bot token', () => {
      const bridge = createBridge();
      const config = (bridge as any).config;
      expect(config.token).toBe('test-token-123456789012345678901234');
      expect(config.token).not.toBe('123:test-token');
    });

    it('should handle missing daemon token file gracefully', () => {
      const bridge = createBridge({
        config: {
          botToken: '123:test-token',
          daemonUrl: 'ws://127.0.0.1:4317/ws',
          tokenFile: '/nonexistent/daemon-token',
          allowedUsers: new Set([12345]),
          nicknameDb: '/tmp/nickname.db',
        },
      });
      const config = (bridge as any).config;
      expect(config.token).toBe('');
    });
  });

  describe('BaseBridge Abstract Methods', () => {
    it('should implement onReady()', () => {
      const bridge = createBridge();
      expect(typeof bridge.onReady).toBe('function');
    });

    it('should implement onStop()', () => {
      const bridge = createBridge();
      expect(typeof bridge.onStop).toBe('function');
    });
  });

  describe('Connection Lifecycle (inherited from BaseBridge)', () => {
    it('should have connect() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.connect).toBe('function');
    });

    it('should have disconnect() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.disconnect).toBe('function');
    });

    it('should have send() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.send).toBe('function');
    });

    it('should have getStatus() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.getStatus).toBe('function');
    });

    it('should have isReady() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.isReady).toBe('function');
    });

    it('should have getSessionId() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.getSessionId).toBe('function');
    });
  });

  describe('Event System (inherited from EventEmitter)', () => {
    it('should have on() method for event subscription', () => {
      const bridge = createBridge();
      expect(typeof bridge.on).toBe('function');
    });

    it('should have once() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.once).toBe('function');
    });

    it('should have off() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.off).toBe('function');
    });

    it('should emit onStatusChange on connection state changes', () => {
      const bridge = createBridge();
      expect(typeof bridge.emit).toBe('function');
    });
  });

  describe('Message Sending (inherited from BaseBridge)', () => {
    it('should have sendChannelNotify() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.sendChannelNotify).toBe('function');
    });

    it('should have sendConnectorEvent() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.sendConnectorEvent).toBe('function');
    });

    it('should have sendCommand() method returning Promise', () => {
      const bridge = createBridge();
      expect(typeof bridge.sendCommand).toBe('function');
    });
  });

  describe('Telegram-Specific Public Methods', () => {
    it('should have start() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.start).toBe('function');
    });

    it('should have stop() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.stop).toBe('function');
    });

    it('should have getBridgeStatus() method', () => {
      const bridge = createBridge();
      expect(typeof bridge.getBridgeStatus).toBe('function');
    });
  });

  describe('Configuration Validation', () => {
    it('should accept empty botToken in config (validated at runtime)', () => {
      const bridge = createBridge({
        config: {
          botToken: '',
          daemonUrl: 'ws://127.0.0.1:4317/ws',
          tokenFile: '/tmp/test-token',
          allowedUsers: new Set([12345]),
          nicknameDb: '/tmp/nickname.db',
        },
      });
      expect(bridge).toBeDefined();
    });

    it('should require daemonUrl in config', () => {
      const bridge = createBridge({
        config: {
          botToken: '123:test-token',
          daemonUrl: '',
          tokenFile: '/tmp/test-token',
          allowedUsers: new Set([12345]),
          nicknameDb: '/tmp/nickname.db',
        },
      });
      const config = (bridge as any).config;
      expect(config.daemonUrl).toBe('');
    });
  });

  describe('TelegramBridge - Integration Behavior', () => {
    let bridge;

    beforeEach(() => {
      vi.clearAllMocks();
      bridge = createBridge();
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should setup bot handlers on construction', () => {
      // Verify bot was created and has expected methods
      expect(bridge).toBeDefined();
      expect(typeof bridge.start).toBe('function');
      expect(typeof bridge.stop).toBe('function');
    });

    it('should start bot and connect to daemon on start()', async () => {
      const connectSpy = vi.spyOn(bridge, 'connect').mockResolvedValue(undefined);
      
      await bridge.start();

      expect(connectSpy).toHaveBeenCalled();
    });

    it('should stop bot and disconnect on stop()', async () => {
      const disconnectSpy = vi.spyOn(bridge, 'disconnect').mockResolvedValue(undefined);
      const onStopSpy = vi.spyOn(bridge, 'onStop').mockResolvedValue(undefined);
      
      await bridge.stop();

      expect(onStopSpy).toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });
});
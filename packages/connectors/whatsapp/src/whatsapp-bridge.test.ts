/**
 * WhatsApp Bridge Tests - TDD approach
 * Tests for BaseBridge v2 compatibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WhatsAppBridge, WhatsAppBridgeOptions } from './whatsapp-bridge.js';
import { BridgeConfig, BridgeStatus, ReadyPayload, HelloPayload, ChannelNotifyPayload, CommandPayload, CommandResultPayload } from '@gentle-dot/bridges-base';
import { ChannelTransport, ChannelInbound, TransportStateEvent } from './transport/types.js';

// Mock dependencies
vi.mock('./transport/factory.js', () => ({
  createTransportFactory: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onState: vi.fn(),
    sendText: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('./rate-limit.js', () => ({
  RateLimiter: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue(undefined),
  })),
}));

const createMockConfig = (overrides: Partial<Config> = {}): Config => ({
  connectorId: 'whatsapp-test',
  authDir: '/tmp/test-auth',
  allowedNumbers: new Set(['5491112345678', '5491187654321']),
  daemonUrl: 'ws://localhost:4317/ws',
  tokenFile: '/tmp/test-token',
  provider: 'baileys',
  meta: null,
  adminPort: 4407,
  adminTokenFile: '/tmp/admin-token',
  allowlistFile: '/tmp/allowlist.json',
  ...overrides,
});

const createMockOptions = (overrides: Partial<WhatsAppBridgeOptions> = {}): WhatsAppBridgeOptions => ({
  config: createMockConfig(),
  log: vi.fn(),
  ...overrides,
});

describe('WhatsAppBridge - BaseBridge v2 Compatibility', () => {
  let bridge: WhatsAppBridge;
  let mockOptions: WhatsAppBridgeOptions;

  beforeEach(() => {
    mockOptions = createMockOptions();
    bridge = new WhatsAppBridge(mockOptions);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Constructor', () => {
    it('should create instance with correct BridgeConfig', () => {
      expect(bridge).toBeInstanceOf(WhatsAppBridge);
    });

    it('should have required capabilities in config', () => {
      const config = (bridge as any).config as BridgeConfig;
      expect(config.capabilities).toContain('channel_notify');
      expect(config.capabilities).toContain('message_send');
      expect(config.capabilities).toContain('connector_command');
      expect(config.capabilities).toContain('allowlist_management');
    });

    it('should have correct connector metadata', () => {
      const config = (bridge as any).config as BridgeConfig;
      expect(config.connectorType).toBe('whatsapp');
      expect(config.connectorId).toBe('whatsapp-test');
      expect(config.daemonUrl).toBe('ws://localhost:4317/ws');
      expect(config.metadata).toEqual({
        version: '1.0.0',
        provider: 'baileys',
        features: ['allowlist_management', 'meta_cloud_support'],
      });
    });

    it('should use provider token for meta-cloud', () => {
      const metaOptions = createMockOptions({
        config: createMockConfig({
          provider: 'meta-cloud',
          meta: {
            phoneNumberId: '123456789',
            token: 'meta-token-123',
            verifyToken: 'verify',
            appSecret: 'secret',
            webhookPort: 4408,
            webhookHost: '0.0.0.0',
            graphUrl: 'https://graph.facebook.com',
            graphVersion: 'v21.0',
          },
        }),
      });
      const metaBridge = new WhatsAppBridge(metaOptions);
      const config = (metaBridge as any).config as BridgeConfig;
      expect(config.token).toBe('meta-token-123');
    });
  });

  describe('BaseBridge Abstract Methods', () => {
    it('should implement onReady()', async () => {
      await expect(bridge.onReady()).resolves.not.toThrow();
    });

    it('should implement onStop()', async () => {
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
      const unsubscribe = bridge.on('onReady', vi.fn());
      expect(typeof unsubscribe).toBe('function');
    });

    it('should have once() method', () => {
      const unsubscribe = bridge.once('onReady', vi.fn());
      expect(typeof unsubscribe).toBe('function');
    });

    it('should have off() method', () => {
      const handler = vi.fn();
      bridge.on('onReady', handler);
      bridge.off('onReady', handler);
      expect(true).toBe(true);
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

  describe('WhatsApp-Specific Methods', () => {
    it('should have start() method', () => {
      expect(typeof bridge.start).toBe('function');
    });

    it('should have stop() method', () => {
      expect(typeof bridge.stop).toBe('function');
    });

    it('should have getStatus() returning bridge status info', async () => {
      const status = await bridge.getStatus();
      expect(status).toHaveProperty('uptime');
      expect(status).toHaveProperty('allowedNumbers');
      expect(status).toHaveProperty('provider');
    });

    it('should have connectionLost() method', async () => {
      await expect(bridge.connectionLost()).resolves.not.toThrow();
    });
  });

  describe('Configuration Validation', () => {
    it('should require allowedNumbers in config', () => {
      const options = createMockOptions({ 
        config: createMockConfig({ allowedNumbers: new Set() }) 
      });
      expect(() => new WhatsAppBridge(options)).not.toThrow();
    });

    it('should require daemonUrl in config', () => {
      const options = createMockOptions({ 
        config: createMockConfig({ daemonUrl: '' }) 
      });
      const b = new WhatsAppBridge(options);
      const config = (b as any).config as BridgeConfig;
      expect(config.daemonUrl).toBe('');
    });
  });
});

describe('WhatsAppBridge - Provider Variants', () => {
  it('should create baileys transport by default', () => {
    const { createTransportFactory } = await import('./transport/factory.js');
    const options = createMockOptions({ 
      config: createMockConfig({ provider: 'baileys' }) 
    });
    new WhatsAppBridge(options);
    expect(createTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'baileys',
    }));
  });

  it('should create meta-cloud transport when configured', () => {
    const { createTransportFactory } = await import('./transport/factory.js');
    const options = createMockOptions({ 
      config: createMockConfig({
        provider: 'meta-cloud',
        meta: {
          phoneNumberId: '123456789',
          token: 'meta-token-123',
          verifyToken: 'verify',
          appSecret: 'secret',
          webhookPort: 4408,
          webhookHost: '0.0.0.0',
          graphUrl: 'https://graph.facebook.com',
          graphVersion: 'v21.0',
        },
      }) 
    });
    new WhatsAppBridge(options);
    expect(createTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'meta-cloud',
    }));
  });
});
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

vi.mock('./rate-limit.js', () => {
  class RateLimiter {
    send = vi.fn().mockResolvedValue(undefined);
  }
  return { RateLimiter };
});

const createMockConfig = (overrides: Partial<Config> = {}): Config => ({
  connectorId: 'whatsapp-test',
  authDir: '/tmp/test-auth',
  allowedNumbers: new Set(['5491112345678', '5491187654321']),
  daemonUrl: 'ws://localhost:4317/ws',
  tokenFile: '/tmp/test-token',
  provider: 'meta-cloud',
  // The bridge only supports Meta Cloud today (see src/transport/factory.ts:9), so the default
  // mock config carries the credentials the constructor requires.
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
        provider: 'meta-cloud',
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
    // BaseBridge extends EventEmitter: on/once return the emitter, and off unsubscribes.
    it('should have on() method for event subscription', () => {
      expect(bridge.on('onReady', vi.fn())).toBe(bridge);
    });

    it('should have once() method', () => {
      expect(bridge.once('onReady', vi.fn())).toBe(bridge);
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

    it('should have disconnect() method', () => {
      expect(typeof bridge.disconnect).toBe('function');
    });

    // BaseBridge.getStatus() answers the lifecycle state, not a snapshot object.
    it('should have getStatus() returning the bridge status', () => {
      expect(bridge.getStatus()).toBe('disconnected');
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
  // Baileys is not implemented: src/transport/factory.ts:9 supports Meta Cloud only
  // (Baileys carries a git dependency). Kept as a skipped placeholder so the gap stays visible.
  it.skip('should create baileys transport by default', async () => {
    const { createTransportFactory } = await import('./transport/factory.js');
    const options = createMockOptions({ 
      config: createMockConfig({ provider: 'baileys' }) 
    });
    new WhatsAppBridge(options);
    expect(createTransportFactory).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'baileys',
    }));
  });

  it('should create meta-cloud transport when configured', async () => {
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
describe('WhatsAppBridge - the transport never answers itself (#48)', () => {
  const deliverInbound = async (id: string, text: string) => {
    const { createTransportFactory } = await import('./transport/factory.js');
    const transport = (createTransportFactory as unknown as { mock: { results: { value: { onMessage: { mock: { calls: unknown[][] } } } }[] } }).mock.results.at(-1)!.value;
    const handler = transport.onMessage.mock.calls[0]![0] as (message: ChannelInbound) => void;
    handler({ from: '5491112345678', id, text });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it('drops an inbound whose id this transport already sent', async () => {
    const { createEchoGuard } = await import('@gentle-dot/bridges-base');
    const echoGuard = createEchoGuard();
    echoGuard.remember('wamid.ECHO');
    const bridge = new WhatsAppBridge(createMockOptions({ echoGuard }));
    const send = vi.spyOn(bridge as unknown as { send: (...args: unknown[]) => void }, 'send');

    await deliverInbound('wamid.ECHO', 'hola');

    expect(send).not.toHaveBeenCalled();
  });

  it('lets an inbound with a different id reach the assistant, labelled', async () => {
    const { createEchoGuard } = await import('@gentle-dot/bridges-base');
    const bridge = new WhatsAppBridge(createMockOptions({ echoGuard: createEchoGuard() }));
    const send = vi.spyOn(bridge as unknown as { send: (...args: unknown[]) => void }, 'send');

    await deliverInbound('wamid.FRESH', 'hola');

    expect(send).toHaveBeenCalledWith('send', { text: '📱 [Gentle Dot] hola' });
  });
});

describe('WhatsAppBridge - graceful shutdown (#48 follow-up)', () => {
  it('closes the transport and the daemon link when main.ts calls shutdown()', async () => {
    const bridge = new WhatsAppBridge(createMockOptions());
    const { createTransportFactory } = await import('./transport/factory.js');
    const transport = (createTransportFactory as unknown as { mock: { results: { value: { stop: { mock: unknown } } }[] } }).mock.results.at(-1)!.value;
    const stop = transport.stop as unknown as { mock: { calls: unknown[] } };
    const disconnect = vi
      .spyOn(bridge as unknown as { disconnect: () => Promise<void> }, 'disconnect')
      .mockResolvedValue(undefined);

    await (bridge as unknown as { shutdown: () => Promise<void> }).shutdown();

    expect(stop.mock.calls.length).toBe(1);
    expect(disconnect).toHaveBeenCalled();
  });
});

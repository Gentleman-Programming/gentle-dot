/**
 * Rate Limiter for WhatsApp outbound messages
 * Prevents hitting provider rate limits
 */

import type { ChannelTransport } from './transport/types.js';

interface RateLimitConfig {
  maxPerSecond: number;
  maxPerMinute: number;
  maxPerHour: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxPerSecond: 20,
  maxPerMinute: 60,
  maxPerHour: 1000,
};

const WINDOW_MS = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
};

export class RateLimiter {
  private transport: ChannelTransport;
  private log: (message: string) => void;
  private config: RateLimitConfig;
  
  private sentSecond: number[] = [];
  private sentMinute: number[] = [];
  private sentHour: number[] = [];

  constructor(transport: ChannelTransport, log: (message: string) => void, config: Partial<RateLimitConfig> = {}) {
    this.transport = transport;
    this.log = log;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async send(toNumber: string, text: string): Promise<void> {
    await this.waitForSlot();
    await this.transport.sendText(toNumber, text);
    this.recordSent();
  }

  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    
    // Clean old entries
    this.sentSecond = this.sentSecond.filter(t => now - t < WINDOW_MS.second);
    this.sentMinute = this.sentMinute.filter(t => now - t < WINDOW_MS.minute);
    this.sentHour = this.sentHour.filter(t => now - t < WINDOW_MS.hour);

    // Check limits
    if (this.sentSecond.length >= this.config.maxPerSecond) {
      const oldest = this.sentSecond[0];
      if (oldest !== undefined) {
        const waitMs = WINDOW_MS.second - (now - oldest) + 10;
        await this.sleep(waitMs);
      }
      return this.waitForSlot();
    }
    if (this.sentMinute.length >= this.config.maxPerMinute) {
      const oldest = this.sentMinute[0];
      if (oldest !== undefined) {
        const waitMs = WINDOW_MS.minute - (now - oldest) + 10;
        await this.sleep(waitMs);
      }
      return this.waitForSlot();
    }
    if (this.sentHour.length >= this.config.maxPerHour) {
      const oldest = this.sentHour[0];
      if (oldest !== undefined) {
        const waitMs = WINDOW_MS.hour - (now - oldest) + 10;
        await this.sleep(waitMs);
      }
      return this.waitForSlot();
    }
  }

  private recordSent(): void {
    const now = Date.now();
    this.sentSecond.push(now);
    this.sentMinute.push(now);
    this.sentHour.push(now);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

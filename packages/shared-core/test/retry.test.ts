import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  calculateDelay,
  isRetryableError,
  DEFAULT_RETRY_CONFIG,
  delay,
  delayImpl,
  ConnectionRetryManager,
} from "../src/retry.js";

describe("retry - bounded attempts, backoff, cancellation", () => {
  describe("calculateDelay", () => {
    it("calculates exponential backoff correctly", () => {
      const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
      // Mock Math.random to return 0 for predictable jitter
      const originalRandom = Math.random;
      Math.random = vi.fn(() => 0);

      expect(calculateDelay(0, config)).toBe(1000); // 1000 * 2^0 = 1000
      expect(calculateDelay(1, config)).toBe(2000); // 1000 * 2^1 = 2000
      expect(calculateDelay(2, config)).toBe(4000); // 1000 * 2^2 = 4000

      Math.random = originalRandom;
    });

    it("caps delay at maxDelayMs", () => {
      const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 10000, backoffMultiplier: 2, maxDelayMs: 15000 };
      const originalRandom = Math.random;
      Math.random = vi.fn(() => 0);

      expect(calculateDelay(0, config)).toBe(10000);
      expect(calculateDelay(1, config)).toBe(15000); // capped at maxDelayMs

      Math.random = originalRandom;
    });

    it("adds jitter to delay", () => {
      const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000, backoffMultiplier: 2, maxDelayMs: 30000 };
      const originalRandom = Math.random;
      Math.random = vi.fn(() => 0.5);

      const delay = calculateDelay(0, config);
      // baseDelay (1000) + jitter (0.5 * 1000) = 1500
      expect(delay).toBe(1500);

      Math.random = originalRandom;
    });
  });

  describe("isRetryableError", () => {
    it("returns true for retryable error codes", () => {
      const error = new Error("Connection refused") as NodeJS.ErrnoException;
      error.code = "ECONNREFUSED";
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(true);
    });

    it("returns true for timeout errors", () => {
      const error = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(true);
    });

    it("returns false for non-retryable errors", () => {
      const error = new Error("EACCES") as NodeJS.ErrnoException;
      error.code = "EACCES";
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(false);
    });

    it("returns false for null/undefined", () => {
      expect(isRetryableError(null, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(false);
      expect(isRetryableError(undefined, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(false);
    });

    it("checks error message for retryable codes", () => {
      const error = new Error("connect ECONNREFUSED 127.0.0.1:8080");
      expect(isRetryableError(error, DEFAULT_RETRY_CONFIG.retryableErrors)).toBe(true);
    });
  });

  describe("delay", () => {
    it("resolves after specified milliseconds", async () => {
      const promise = delay(10);
      await expect(promise).resolves.toBeUndefined();
    });

    it("rejects when aborted before delay", async () => {
      const controller = new AbortController();
      controller.abort();
      const promise = delay(100, controller.signal);
      await expect(promise).rejects.toThrow("Aborted");
    });

    it("rejects when aborted during delay", async () => {
      const controller = new AbortController();
      const promise = delay(500, controller.signal);
      await new Promise(r => setTimeout(r, 10));
      controller.abort();
      await expect(promise).rejects.toThrow("Aborted");
    });
  });

  describe("withRetry", () => {
    let originalDelayImpl: typeof delayImpl.current;

    beforeEach(() => {
      // Store original and replace with a test-friendly version that uses real timers but short delays
      originalDelayImpl = delayImpl.current;
      delayImpl.current = vi.fn().mockImplementation(async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });
    });

    afterEach(() => {
      delayImpl.current = originalDelayImpl;
    });

    it("succeeds on first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on retryable error and succeeds", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success");

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
      expect(result.attempts).toBe(2);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("fails after max attempts", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("ECONNREFUSED");
      expect(result.attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not retry non-retryable errors", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("EACCES"));

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("EACCES");
      expect(result.attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("cancels on abort signal before attempt", async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = vi.fn().mockResolvedValue("success");

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 }, controller.signal);
      expect(result.success).toBe(false);
      expect(result.error?.name).toBe("AbortError");
      expect(result.attempts).toBe(0);
      expect(fn).not.toHaveBeenCalled();
    });

    it("cancels on abort signal during delay", async () => {
      const controller = new AbortController();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success");

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }, controller.signal);
      // Wait a tiny bit for the first attempt to fail and delay to start
      await new Promise(r => setTimeout(r, 5));
      controller.abort();
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error?.name).toBe("AbortError");
    });

    it("passes attempt number to function", async () => {
      const attempts: number[] = [];
      const fn = vi.fn().mockImplementation(async (attempt: number) => {
        attempts.push(attempt);
        if (attempt < 2) throw new Error("ECONNREFUSED");
        return "success";
      });

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      expect(result.success).toBe(true);
      expect(attempts).toEqual([0, 1, 2]);
    });
  });

  describe("ConnectionRetryManager", () => {
    let originalDelayImpl: typeof delayImpl.current;

    beforeEach(() => {
      // Store original and replace with a test-friendly version
      originalDelayImpl = delayImpl.current;
      delayImpl.current = vi.fn().mockImplementation(async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            throw new DOMException("Aborted", "AbortError");
          }, { once: true });
        });
      });
    });

    afterEach(() => {
      delayImpl.current = originalDelayImpl;
    });

    it("tracks active connection attempts", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });
      let resolveFn: (value: string) => void;
      const connectPromise = new Promise<string>((resolve) => { resolveFn = resolve; });

      const attemptPromise = manager.attemptConnection("conn-1", async () => connectPromise);
      expect(manager.getActiveCount()).toBe(1);

      resolveFn!("success");
      await new Promise(r => setTimeout(r, 10));
      const result = await attemptPromise;
      expect(result.success).toBe(true);
      expect(manager.getActiveCount()).toBe(0);
    });

    it("cancels specific connection", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });

      const attemptPromise = manager.attemptConnection("conn-1", async (signal) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve("success"), 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });

      await new Promise(r => setTimeout(r, 10));
      manager.cancelConnection("conn-1");
      await new Promise(r => setTimeout(r, 10));
      const result = await attemptPromise;
      expect(result.success).toBe(false);
      expect(result.error?.name).toBe("AbortError");
    });

    it("cancels all connections", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });
      const promises = [
        manager.attemptConnection("conn-1", async (signal) => {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve("success"), 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }),
        manager.attemptConnection("conn-2", async (signal) => {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve("success"), 1000);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }),
      ];

      await new Promise(r => setTimeout(r, 10));
      manager.cancelAll();
      await new Promise(r => setTimeout(r, 10));
      const results = await Promise.all(promises);
      expect(results.every((r) => !r.success && r.error?.name === "AbortError")).toBe(true);
    });

    it("shuts down and prevents new attempts", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });
      manager.shutdown();
      expect(manager.isShutdown()).toBe(true);

      const result = await manager.attemptConnection("conn-1", async () => "success");
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Connection retry manager is shut down");
      expect(result.attempts).toBe(0);
    });

    it("allows concurrent connection attempts", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });
      const results = await Promise.all([
        manager.attemptConnection("conn-1", async () => "success-1"),
        manager.attemptConnection("conn-2", async () => "success-2"),
        manager.attemptConnection("conn-3", async () => "success-3"),
      ]);

      expect(results.every((r) => r.success)).toBe(true);
      expect(results.map((r) => r.value)).toEqual(["success-1", "success-2", "success-3"]);
    });
  });
});
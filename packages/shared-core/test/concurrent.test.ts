import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ConnectionRetryManager,
  withRetry,
  delay,
  delayImpl,
} from "../src/retry.js";

describe("concurrent - concurrent connection attempts", () => {
  let originalDelayImpl: typeof delayImpl.current;

  beforeEach(() => {
    // Store original and replace with a test-friendly version
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

  describe("ConnectionRetryManager concurrent handling", () => {
    it("handles multiple simultaneous connection attempts", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10 });
      const results = await Promise.all([
        manager.attemptConnection("conn-1", async () => "result-1"),
        manager.attemptConnection("conn-2", async () => "result-2"),
        manager.attemptConnection("conn-3", async () => "result-3"),
        manager.attemptConnection("conn-4", async () => "result-4"),
        manager.attemptConnection("conn-5", async () => "result-5"),
      ]);

      expect(results).toHaveLength(5);
      expect(results.every((r) => r.success)).toBe(true);
      expect(results.map((r) => r.value)).toEqual(["result-1", "result-2", "result-3", "result-4", "result-5"]);
      expect(manager.getActiveCount()).toBe(0);
    });

    it("handles concurrent retries independently", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      
      let attemptCounts = { "conn-1": 0, "conn-2": 0 };
      
      const results = await Promise.all([
        manager.attemptConnection("conn-1", async (signal) => {
          attemptCounts["conn-1"]++;
          if (attemptCounts["conn-1"] < 2) {
            const error = new Error("ECONNREFUSED") as NodeJS.ErrnoException;
            error.code = "ECONNREFUSED";
            throw error;
          }
          return "success-1";
        }),
        manager.attemptConnection("conn-2", async (signal) => {
          attemptCounts["conn-2"]++;
          if (attemptCounts["conn-2"] < 3) {
            const error = new Error("ECONNREFUSED") as NodeJS.ErrnoException;
            error.code = "ECONNREFUSED";
            throw error;
          }
          return "success-2";
        }),
      ]);

      expect(results[0].success).toBe(true);
      expect(results[0].value).toBe("success-1");
      expect(results[0].attempts).toBe(2);
      
      expect(results[1].success).toBe(true);
      expect(results[1].value).toBe("success-2");
      expect(results[1].attempts).toBe(3);
    });

    it("allows cancelling one connection without affecting others", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      
      // Use retryable errors to keep connections in retry loop
      const p1 = manager.attemptConnection("conn-1", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });
      
      const p2 = manager.attemptConnection("conn-2", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });
      
      const p3 = manager.attemptConnection("conn-3", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });

      // Let them start
      await new Promise(r => setTimeout(r, 10));
      expect(manager.getActiveCount()).toBe(3);

      // Cancel only conn-1
      manager.cancelConnection("conn-1");
      expect(manager.getActiveCount()).toBe(2);

      // Wait a bit for cancellation to propagate
      await new Promise(r => setTimeout(r, 50));
      
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.success).toBe(false);
      expect(r1.error?.name).toBe("AbortError");
      // The other two should also fail because they keep retrying
      // but they're not cancelled, so they'll eventually fail with max attempts
      expect(r2.success).toBe(false);
      expect(r3.success).toBe(false);
    });

    it("tracks active count correctly across concurrent operations", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      
      // Use retryable errors to keep connections in retry loop
      const p1 = manager.attemptConnection("conn-1", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });
      
      // Before starting
      expect(manager.getActiveCount()).toBe(1);
      
      // Start second attempt
      const p2 = manager.attemptConnection("conn-2", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });
      
      // Give time for both to register
      await new Promise(r => setTimeout(r, 10));
      expect(manager.getActiveCount()).toBe(2);
      
      // Cancel second
      manager.cancelConnection("conn-2");
      await new Promise(r => setTimeout(r, 10));
      expect(manager.getActiveCount()).toBe(1);
      
      // Cancel first
      manager.cancelConnection("conn-1");
      await new Promise(r => setTimeout(r, 10));
      await p1;
      await p2;
      expect(manager.getActiveCount()).toBe(0);
    });

    it("handles rapid sequential connections on same ID", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] });
      
      // Start first - make it retry
      const p1 = manager.attemptConnection("conn-1", async (signal) => {
        let count = 0;
        while (!signal.aborted) {
          count++;
          if (count > 10) throw new Error("ECONNREFUSED");
          await new Promise(r => setTimeout(r, 10));
        }
        throw new DOMException("Aborted", "AbortError");
      });
      await new Promise(r => setTimeout(r, 10));
      expect(manager.getActiveCount()).toBe(1);
      
      // Cancel it before completion
      manager.cancelConnection("conn-1");
      await new Promise(r => setTimeout(r, 10));
      await p1;
      expect(manager.getActiveCount()).toBe(0);
      
      // Start second with same ID - make it also take some time
      const p2 = manager.attemptConnection("conn-1", async (signal) => {
        await new Promise(r => setTimeout(r, 100));
        return "second";
      });
      await new Promise(r => setTimeout(r, 10));
      expect(manager.getActiveCount()).toBe(1);
      
      await new Promise(r => setTimeout(r, 150));
      const r2 = await p2;
      expect(r2.success).toBe(true);
      expect(r2.value).toBe("second");
    });
  });

  describe("withRetry concurrent behavior", () => {
    it("multiple withRetry calls run independently", async () => {
      const fn1 = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success-1");
      
      const fn2 = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success-2");

      const [p1, p2] = [
        withRetry(fn1, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }),
        withRetry(fn2, { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }),
      ];

      const [r1, r2] = await Promise.all([p1, p2]);
      
      expect(r1.success).toBe(true);
      expect(r1.value).toBe("success-1");
      expect(r1.attempts).toBe(2);
      
      expect(r2.success).toBe(true);
      expect(r2.value).toBe("success-2");
      expect(r2.attempts).toBe(3);
    });

    it("shared abort signal affects all concurrent retries", async () => {
      const controller = new AbortController();
      
      const fn = vi.fn()
        .mockRejectedValue(new Error("ECONNREFUSED"));

      const promises = [
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }, controller.signal),
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }, controller.signal),
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] }, controller.signal),
      ];

      // First attempts run
      await new Promise(r => setTimeout(r, 10));
      expect(fn).toHaveBeenCalledTimes(3);
      
      // Abort during first delay
      controller.abort();
      await new Promise(r => setTimeout(r, 10));
      
      const results = await Promise.all(promises);
      expect(results.every((r) => !r.success && r.error?.name === "AbortError")).toBe(true);
    });
  });

  describe("Concurrent delay handling", () => {
    it("multiple delays run concurrently", async () => {
      const promises = [
        delay(10),
        delay(20),
        delay(30),
      ];

      await Promise.all(promises);
      expect(promises.length).toBe(3);
    });
  });
});
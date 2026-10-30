import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  ConnectionRetryManager,
  delay,
} from "../src/retry.js";

describe("shutdown - clean shutdown during retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("ConnectionRetryManager shutdown", () => {
    it("cancels all active attempts on shutdown", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 100 });
      
      const attempts = [
        manager.attemptConnection("conn-1", async (signal) => {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve("success"), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }),
        manager.attemptConnection("conn-2", async (signal) => {
          return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => resolve("success"), 5000);
            signal.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        }),
      ];

      // Let them start
      vi.advanceTimersByTime(50);
      expect(manager.getActiveCount()).toBe(2);

      // Shutdown
      manager.shutdown();

      // Advance time
      vi.advanceTimersByTime(5000);

      const results = await Promise.all(attempts);
      expect(results.every((r) => !r.success && r.error?.name === "AbortError")).toBe(true);
      expect(manager.isShutdown()).toBe(true);
      expect(manager.getActiveCount()).toBe(0);
    });

    it("prevents new attempts after shutdown", async () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 100 });
      
      // Start one attempt
      const attempt1 = manager.attemptConnection("conn-1", async (signal) => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve("success"), 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timeout);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      });

      vi.advanceTimersByTime(50);
      
      // Shutdown
      manager.shutdown();
      
      // Try to start another attempt
      const result = await manager.attemptConnection("conn-2", async () => "success");
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Connection retry manager is shut down");
      expect(result.attempts).toBe(0);

      // Original attempt should be cancelled
      vi.advanceTimersByTime(5000);
      const result1 = await attempt1;
      expect(result1.success).toBe(false);
      expect(result1.error?.name).toBe("AbortError");
    });

    it("shutdown is idempotent", () => {
      const manager = new ConnectionRetryManager({ maxAttempts: 3, baseDelayMs: 100 });
      manager.shutdown();
      manager.shutdown(); // Should not throw
      expect(manager.isShutdown()).toBe(true);
    });
  });

  describe("withRetry shutdown behavior", () => {
    it("cancels retry loop when aborted during delay", async () => {
      const controller = new AbortController();
      let attemptCount = 0;

      const fn = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          const error = new Error("ECONNREFUSED");
          (error as NodeJS.ErrnoException).code = "ECONNREFUSED";
          throw error;
        }
        return "success";
      });

      const promise = withRetry(fn, { maxAttempts: 5, baseDelayMs: 1000, retryableErrors: ["ECONNREFUSED"] }, controller.signal);
      
      // First attempt fails, wait for delay
      vi.advanceTimersByTime(500);
      controller.abort();
      vi.advanceTimersByTime(5000);
      
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.error?.name).toBe("AbortError");
      expect(attemptCount).toBe(1); // Only first attempt ran
    });

    it("cancels retry loop when aborted before attempt", async () => {
      const controller = new AbortController();
      controller.abort();
      
      const fn = vi.fn().mockResolvedValue("success");
      
      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 }, controller.signal);
      expect(result.success).toBe(false);
      expect(result.error?.name).toBe("AbortError");
      expect(result.attempts).toBe(0);
      expect(fn).not.toHaveBeenCalled();
    });

    it("completes current attempt before respecting abort", async () => {
      const controller = new AbortController();
      let resolveFn: (value: string) => void;
      
      const fn = vi.fn().mockImplementation(async () => {
        return new Promise<string>((resolve) => {
          resolveFn = resolve;
        });
      });

      const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 }, controller.signal);
      
      // Wait for attempt to start
      vi.advanceTimersByTime(10);
      expect(fn).toHaveBeenCalledTimes(1);
      
      // Abort during the attempt
      controller.abort();
      
      // Complete the attempt
      resolveFn!("success");
      vi.advanceTimersByTime(100);
      
      const result = await promise;
      // The attempt completed successfully before abort was checked
      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
    });
  });

  describe("delay cancellation during retry", () => {
    it("aborts delay immediately when signal aborted", async () => {
      const controller = new AbortController();
      
      const delayPromise = delay(5000, controller.signal);
      
      vi.advanceTimersByTime(100);
      controller.abort();
      vi.advanceTimersByTime(5000);
      
      await expect(delayPromise).rejects.toThrow("Aborted");
    });

    it("allows delay to complete when not aborted", async () => {
      const promise = delay(100);
      vi.advanceTimersByTime(100);
      await expect(promise).resolves.toBeUndefined();
    });
  });
});
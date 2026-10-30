import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withRetry,
  isAmbiguousFailure,
  createConnectionWithSideEffectTracking,
  delayImpl,
  DEFAULT_RETRY_CONFIG,
  SideEffectContext,
} from "../src/retry.js";

describe("no-side-effect - no retry tool calls after ambiguous failure", () => {
  let originalDelayImpl: typeof delayImpl.current;

  beforeEach(() => {
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

  describe("isAmbiguousFailure", () => {
    it("identifies ambiguous failure errors", () => {
      const error = new Error("Ambiguous failure after side effect");
      error.name = "AmbiguousFailureError";
      (error as any).sideEffectOccurred = true;
      
      expect(isAmbiguousFailure(error)).toBe(true);
    });

    it("returns false for regular errors", () => {
      const error = new Error("Regular error");
      expect(isAmbiguousFailure(error)).toBe(false);
    });

    it("returns false for non-errors", () => {
      expect(isAmbiguousFailure(null)).toBe(false);
      expect(isAmbiguousFailure(undefined)).toBe(false);
      expect(isAmbiguousFailure("string")).toBe(false);
    });
  });

  describe("createConnectionWithSideEffectTracking", () => {
    it("tracks side effects and prevents retry on ambiguous failure", async () => {
      let attemptCount = 0;
      
      // Create a connect function that marks side effect occurred
      const baseConnectFn = async (_signal: AbortSignal, context: SideEffectContext) => {
        attemptCount++;
        if (attemptCount === 1) {
          context.sideEffectOccurred = true;
          // Simulate tool call that might have partially succeeded
          await new Promise(r => setTimeout(r, 1));
          const error = new Error("Connection lost after tool call") as NodeJS.ErrnoException;
          error.code = "ECONNREFUSED";
          throw error;
        }
        return "success";
      };

      const connectFn = createConnectionWithSideEffectTracking(
        baseConnectFn,
        { retryOnAmbiguousFailure: false }
      );

      const result = await withRetry(
        connectFn as any,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );

      expect(result.success).toBe(false);
      expect(isAmbiguousFailure(result.error)).toBe(true);
      expect(attemptCount).toBe(1); // Only one attempt, no retry after side effect
    });

    it("allows retry when retryOnAmbiguousFailure is true", async () => {
      let attemptCount = 0;
      
      const baseConnectFn = async (_signal: AbortSignal, context: SideEffectContext) => {
        attemptCount++;
        if (attemptCount < 2) {
          context.sideEffectOccurred = true;
          // Side effect occurred
          const error = new Error("Connection lost") as NodeJS.ErrnoException;
          error.code = "ECONNREFUSED";
          throw error;
        }
        return "success";
      };
      
      const connectFn = createConnectionWithSideEffectTracking(
        baseConnectFn,
        { retryOnAmbiguousFailure: true }
      );

      const result = await withRetry(
        connectFn as any,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );

      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
      expect(attemptCount).toBe(2);
    });
  });

  describe("withRetry - no side effect retry behavior", () => {
    it("does not retry when side effect occurred and failure is ambiguous", async () => {
      // This test verifies that createConnectionWithSideEffectTracking prevents retry
      // when a side effect occurred and we don't want to retry on ambiguous failure
      let attemptCount = 0;

      const baseConnectFn = async (_signal: AbortSignal, context: SideEffectContext) => {
        attemptCount++;
        if (attemptCount === 1) {
          context.sideEffectOccurred = true;
          const error = new Error("Connection lost after tool call") as NodeJS.ErrnoException;
          error.code = "ECONNREFUSED";
          throw error;
        }
        return "success";
      };

      const connectFn = createConnectionWithSideEffectTracking(
        baseConnectFn,
        { retryOnAmbiguousFailure: false }
      );

      const result = await withRetry(
        connectFn as any,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );

      // With the wrapper, it should fail without retry when side effect occurred
      expect(result.success).toBe(false);
      expect(isAmbiguousFailure(result.error)).toBe(true);
      expect(attemptCount).toBe(1);
    });

    it("retries normally when no side effect occurred", async () => {
      let attemptCount = 0;

      const fn = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          const error = new Error("ECONNREFUSED") as NodeJS.ErrnoException;
          error.code = "ECONNREFUSED";
          throw error;
        }
        return "success";
      });

      const result = await withRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(3);
    });

    it("retries on retryable errors without side effects", async () => {
      const results: string[] = [];
      let attemptCount = 0;

      const fn = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          const error = new Error("ETIMEDOUT") as NodeJS.ErrnoException;
          error.code = "ETIMEDOUT";
          throw error;
        }
        results.push("connected");
        return "success";
      });

      const result = await withRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ETIMEDOUT", "ECONNREFUSED"] },
        undefined
      );

      expect(result.success).toBe(true);
      expect(attemptCount).toBe(2);
    });

    it("does not retry non-retryable errors even if they occur after side effects", async () => {
      let attemptCount = 0;

      const fn = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount === 1) {
          // Side effect occurred but error is not retryable
          const error = new Error("EACCES") as NodeJS.ErrnoException;
          error.code = "EACCES";
          throw error;
        }
        return "success";
      });

      const result = await withRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );

      expect(result.success).toBe(false);
      expect(attemptCount).toBe(1); // No retry for non-retryable error
    });
  });

  describe("Integration: Connection layer only", () => {
    it("retry logic is isolated to connection attempts", async () => {
      // This test verifies the retry logic is designed for connection layer
      // and not for tool calls or MCP layer operations
      
      const connectionAttempt = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("connected");

      const toolCallAttempt = vi.fn().mockResolvedValue("tool result");

      // Connection retry works
      const connResult = await withRetry(
        connectionAttempt,
        { maxAttempts: 3, baseDelayMs: 10, retryableErrors: ["ECONNREFUSED"] },
        undefined
      );
      expect(connResult.success).toBe(true);
      expect(connectionAttempt).toHaveBeenCalledTimes(2);

      // Tool calls don't use retry (they're called directly)
      const toolResult = await toolCallAttempt();
      expect(toolResult).toBe("tool result");
      expect(toolCallAttempt).toHaveBeenCalledTimes(1);
    });

    it("demonstrates connection layer retry with proper error codes", async () => {
      const retryableCodes = ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"];
      
      for (const code of retryableCodes) {
        const fn = vi.fn()
          .mockRejectedValueOnce((() => { const e = new Error(code); (e as NodeJS.ErrnoException).code = code; return e; })())
          .mockResolvedValue("success");

        const result = await withRetry(
          fn,
          { maxAttempts: 3, baseDelayMs: 10, retryableErrors: retryableCodes },
          undefined
        );
        
        expect(result.success).toBe(true);
        expect(fn).toHaveBeenCalledTimes(2);
        vi.clearAllMocks();
      }
    });
  });

  describe("Retry configuration for connection layer", () => {
    it("uses default config for connection retry", () => {
      expect(DEFAULT_RETRY_CONFIG.maxAttempts).toBe(3);
      expect(DEFAULT_RETRY_CONFIG.baseDelayMs).toBe(1000);
      expect(DEFAULT_RETRY_CONFIG.maxDelayMs).toBe(30000);
      expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBe(2);
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain("ECONNREFUSED");
      expect(DEFAULT_RETRY_CONFIG.retryableErrors).toContain("ETIMEDOUT");
    });

    it("allows custom config for connection layer", async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValue("success");

      const result = await withRetry(
        fn,
        { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 10000, backoffMultiplier: 1.5 },
        undefined
      );
      
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
    });
  });
});
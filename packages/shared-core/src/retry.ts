/**
 * Connection retry logic with bounded attempts, exponential backoff, jitter,
 * cancellation, and clean shutdown support.
 */

export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3) */
  maxAttempts: number;
  /** Base delay in milliseconds (default: 1000) */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelayMs: number;
  /** Backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Error codes that trigger a retry */
  retryableErrors: string[];
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  retryableErrors: ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"],
};

/**
 * Checks if an error is retryable based on its code.
 */
export function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    // Check for Node.js system error codes
    const code = (error as NodeJS.ErrnoException).code;
    if (code && retryableErrors.includes(code)) return true;
    // Check for error message containing retryable codes
    const message = error.message;
    return retryableErrors.some((retryable) => message.includes(retryable));
  }
  return false;
}

/**
 * Calculates the next delay with exponential backoff and jitter.
 * @param attempt - The current attempt number (0-indexed)
 * @param config - The retry configuration
 * @returns The delay in milliseconds
 */
export function calculateDelay(attempt: number, config: RetryConfig): number {
  const baseDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(baseDelay, config.maxDelayMs);
  // Add jitter: random value between 0 and cappedDelay
  const jitter = Math.random() * cappedDelay;
  return Math.floor(cappedDelay + jitter);
}

/**
 * A cancellable delay that can be aborted via an AbortSignal.
 * Uses a static delay function that can be replaced for testing.
 */
export const delayImpl = {
  current: async (ms: number, signal?: AbortSignal): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const cleanup = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
      };

      const onAbort = () => {
        cleanup();
        reject(new DOMException("Aborted", "AbortError"));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
    });
  },
};

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return delayImpl.current(ms, signal);
}

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
  /** Whether the operation succeeded */
  success: boolean;
  /** The result value if successful */
  value?: T;
  /** The error if failed */
  error?: Error;
  /** Number of attempts made */
  attempts: number;
}

/**
 * Executes a function with retry logic.
 * 
 * @param fn - The async function to execute
 * @param config - Retry configuration
 * @param signal - Optional abort signal for cancellation
 * @returns The result of the operation
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  config: Partial<RetryConfig> = {},
  signal?: AbortSignal,
): Promise<RetryResult<T>> {
  const mergedConfig: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | undefined;
  let attempts = 0;

  for (let attempt = 0; attempt < mergedConfig.maxAttempts; attempt++) {
    // Check for cancellation before each attempt (before incrementing attempts)
    if (signal?.aborted) {
      return {
        success: false,
        error: new DOMException("Aborted", "AbortError"),
        attempts,
      };
    }

    attempts = attempt + 1;

    try {
      const value = await fn(attempt);
      return { success: true, value, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on the last attempt
      if (attempt === mergedConfig.maxAttempts - 1) break;

      // Check if error is retryable
      if (!isRetryableError(error, mergedConfig.retryableErrors)) {
        return { success: false, error: lastError, attempts };
      }

      // Calculate delay and wait (with cancellation support)
      const delayMs = calculateDelay(attempt, mergedConfig);
      try {
        await delay(delayMs, signal);
      } catch (delayError) {
        // Aborted during delay
        return {
          success: false,
          error: delayError instanceof Error ? delayError : new Error(String(delayError)),
          attempts,
        };
      }
    }
  }

  return { success: false, error: lastError, attempts };
}

/**
 * A connection attempt manager that handles concurrent connection attempts
 * with proper retry logic and cancellation.
 */
export class ConnectionRetryManager {
  private readonly config: RetryConfig;
  private readonly activeAttempts = new Map<string, AbortController>();
  private _shutdown = false;

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = { ...DEFAULT_RETRY_CONFIG, ...config };
  }

  /**
   * Attempts a connection with retry logic.
   * 
   * @param connectionId - Unique identifier for this connection attempt
   * @param connectFn - The connection function to execute
   * @returns The result of the connection attempt
   */
  async attemptConnection<T>(
    connectionId: string,
    connectFn: (signal: AbortSignal) => Promise<T>,
  ): Promise<RetryResult<T>> {
    if (this._shutdown) {
      return {
        success: false,
        error: new Error("Connection retry manager is shut down"),
        attempts: 0,
      };
    }

    const controller = new AbortController();
    this.activeAttempts.set(connectionId, controller);

    try {
      const result = await withRetry(
        (_attempt) => connectFn(controller.signal),
        this.config,
        controller.signal,
      );
      return result;
    } finally {
      this.activeAttempts.delete(connectionId);
    }
  }

  /**
   * Cancels a specific connection attempt.
   */
  cancelConnection(connectionId: string): boolean {
    const controller = this.activeAttempts.get(connectionId);
    if (controller) {
      controller.abort();
      this.activeAttempts.delete(connectionId);
      return true;
    }
    return false;
  }

  /**
   * Cancels all active connection attempts.
   */
  cancelAll(): void {
    for (const controller of this.activeAttempts.values()) {
      controller.abort();
    }
    this.activeAttempts.clear();
  }

  /**
   * Shuts down the manager, cancelling all active attempts and preventing new ones.
   */
  shutdown(): void {
    this._shutdown = true;
    this.cancelAll();
  }

  /**
   * Returns the number of active connection attempts.
   */
  getActiveCount(): number {
    return this.activeAttempts.size;
  }

  /**
   * Checks if the manager is shut down.
   */
  isShutdown(): boolean {
    return this._shutdown;
  }
}

/**
 * Creates a connection function that can be used with withRetry.
 * This is a helper for creating connection functions that properly
 * handle ambiguous failures without retrying side effects.
 * 
 * @param connectFn - The actual connection logic that receives a context to mark side effects
 * @param options - Options to control retry behavior
 * @returns A wrapped function that tracks whether side effects occurred
 */
export function createConnectionWithSideEffectTracking<T>(
  connectFn: (signal: AbortSignal, context: SideEffectContext) => Promise<T>,
  options: { retryOnAmbiguousFailure?: boolean } = {},
): (signal: AbortSignal) => Promise<T> {
  return async (signal: AbortSignal) => {
    const context: SideEffectContext = { sideEffectOccurred: false };

    try {
      const result = await connectFn(signal, context);
      return result;
    } catch (error) {
      // If a side effect occurred and we shouldn't retry on ambiguous failure, throw a special error
      if (context.sideEffectOccurred && !options.retryOnAmbiguousFailure) {
        const ambiguousError = new Error("Ambiguous failure after side effect");
        ambiguousError.name = "AmbiguousFailureError";
        (ambiguousError as any).sideEffectOccurred = true;
        throw ambiguousError;
      }
      throw error;
    }
  };
}

/**
 * Context for tracking side effects during a connection attempt.
 */
export interface SideEffectContext {
  sideEffectOccurred: boolean;
}

/**
 * Marks that a side effect has occurred during the current connection attempt.
 * This should be called after any tool call or side-effect operation.
 */
export function markSideEffectOccurred(context: SideEffectContext): void {
  context.sideEffectOccurred = true;
}

/**
 * Checks if an error is an ambiguous failure (side effect occurred but result unclear).
 */
export function isAmbiguousFailure(error: unknown): boolean {
  if (error instanceof Error && error.name === "AmbiguousFailureError") {
    return true;
  }
  return false;
}
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  attempts?: number;
  // Base delay in ms; each retry waits baseDelayMs * 2^(attempt-1), capped at maxDelayMs.
  baseDelayMs?: number;
  maxDelayMs?: number;
  // Return false to stop retrying a given error immediately (e.g. a non-transient failure).
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

// Run an async operation with exponential backoff. Throws the last error once attempts run out.
export async function withRetry<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 15000;
  const retryable = options.retryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !retryable(err)) break;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      options.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}

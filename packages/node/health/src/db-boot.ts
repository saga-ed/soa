import { TIMEOUT, withTimeout } from './readiness.js';

export interface AwaitDbAtBootOptions {
  /** Overall deadline (default 60000). */
  timeoutMs?: number;
  /** Pause between attempts (default 2000). */
  retryDelayMs?: number;
  /** Per-attempt hard timeout (default 5000). */
  attemptTimeoutMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

const describeError = (err: unknown): string =>
  err === TIMEOUT ? 'attempt timed out' : err instanceof Error ? err.message : String(err);

/** Resolves once `ping` succeeds; throws at the deadline so the caller can crash before `listen()`. */
export async function awaitDbAtBoot(
  ping: () => Promise<unknown>,
  opts: AwaitDbAtBootOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const retryDelayMs = opts.retryDelayMs ?? 2000;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? 5000;
  const start = Date.now();
  let attempt = 0;
  for (;;) {
    attempt++;
    const remaining = timeoutMs - (Date.now() - start);
    try {
      await withTimeout(
        Promise.resolve().then(ping),
        Math.max(1, Math.min(attemptTimeoutMs, remaining)),
      );
      return;
    } catch (err) {
      opts.onRetry?.(attempt, err);
      if (timeoutMs - (Date.now() - start) <= retryDelayMs) {
        throw new Error(
          `DB not reachable after ${attempt} attempt(s) over ${Date.now() - start}ms: ${describeError(err)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

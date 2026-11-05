import { getEnv } from "../config/env";

export interface RetryDecision {
  retry: boolean;
  /** Absolute time of the next attempt when `retry` is true. */
  runAt: Date | null;
  delayMs: number;
}

/**
 * Exponential backoff with jitter (architecture section 9.5).
 *
 * Attempt 1 fails -> ~5s, attempt 2 -> ~15s, attempt 3 -> terminal. `attempts`
 * is the number of attempts *already made* (1 = first attempt just failed).
 */
export function computeRetry(
  attemptsMade: number,
  maxAttempts: number,
  options: {
    baseSeconds?: number;
    jitterRatio?: number;
    random?: () => number;
    now?: number;
  } = {},
): RetryDecision {
  const env = safeEnv();
  const baseSeconds = options.baseSeconds ?? env?.WORKER_RETRY_BASE_SECONDS ?? 5;
  const jitterRatio = options.jitterRatio ?? env?.WORKER_RETRY_JITTER_RATIO ?? 0.25;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now();

  if (attemptsMade >= maxAttempts) {
    return { retry: false, runAt: null, delayMs: 0 };
  }

  const exponentialMs = baseSeconds * 1000 * 3 ** (attemptsMade - 1);
  const jitter = exponentialMs * jitterRatio * (random() * 2 - 1);
  const delayMs = Math.max(0, Math.round(exponentialMs + jitter));

  return { retry: true, runAt: new Date(now + delayMs), delayMs };
}

function safeEnv() {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

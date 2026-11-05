import { describe, expect, test } from "bun:test";
import { computeRetry } from "../../src/queue/retry";

describe("retry/backoff", () => {
  const fixedRandom = () => 0.5; // no jitter offset

  test("first failure retries in ~5s", () => {
    const decision = computeRetry(1, 3, { baseSeconds: 5, jitterRatio: 0, random: fixedRandom });
    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBe(5000);
  });

  test("second failure retries in ~15s", () => {
    const decision = computeRetry(2, 3, { baseSeconds: 5, jitterRatio: 0, random: fixedRandom });
    expect(decision.delayMs).toBe(15_000);
  });

  test("third failure is terminal", () => {
    const decision = computeRetry(3, 3, { baseSeconds: 5, random: fixedRandom });
    expect(decision.retry).toBe(false);
    expect(decision.runAt).toBeNull();
  });

  test("jitter stays inside the configured band", () => {
    const low = computeRetry(1, 3, { baseSeconds: 5, jitterRatio: 0.25, random: () => 0 });
    const high = computeRetry(1, 3, { baseSeconds: 5, jitterRatio: 0.25, random: () => 1 });
    expect(low.delayMs).toBe(3750);
    expect(high.delayMs).toBe(6250);
  });

  test("never returns a negative delay", () => {
    const decision = computeRetry(1, 3, { baseSeconds: 1, jitterRatio: 1, random: () => 0 });
    expect(decision.delayMs).toBeGreaterThanOrEqual(0);
  });
});

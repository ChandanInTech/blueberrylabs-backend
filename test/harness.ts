import { resetEnvCache } from "../src/config/env";
import { closeDatabase, getDatabase, setDatabaseForTesting } from "../src/db/client";
import { registerMetrics, resetMetrics } from "../src/observability/metrics";
import { setStorageForTesting } from "../src/services/storage";
import { applyTestEnv } from "./setup-env";

export interface TestSession {
  token: string;
  userId: string;
}

/**
 * Create a user, an access code, and a token — the same path a real user takes.
 *
 * Tests go through `/auth/login` rather than minting a token directly so the
 * code-redemption path is exercised by every suite that needs a session.
 */
export async function createSession(baseUrl: string): Promise<TestSession> {
  const { createDemoUserWithCode } = await import("../src/modules/auth/session");
  const { code, userId } = await createDemoUserWithCode("test");

  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });

  if (response.status !== 200) {
    throw new Error(`Failed to log in with access code: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { token: string; user: { id: string } };
  return { token: body.token, userId: body.user.id ?? userId };
}

/** Headers that authenticate a request. */
export function authedHeaders(session: TestSession, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${session.token}`,
    ...extra,
  };
}

/** Reset process singletons between suites. */
export async function resetSingletons(): Promise<void> {
  await closeDatabase();
  setDatabaseForTesting(null);
  setStorageForTesting(null);
  resetEnvCache();
}

export function bootTestRuntime(): void {
  applyTestEnv();
  resetEnvCache();
  resetMetrics();
  registerMetrics();
}

export async function truncateAll(): Promise<void> {
  const db = getDatabase().client;
  await db.unsafe(
    "TRUNCATE generation_events, jobs, generations, assets, auth_sessions, access_codes, demo_sessions, rate_limit_buckets, users RESTART IDENTITY CASCADE",
  );
}

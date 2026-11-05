import { resetEnvCache } from "../src/config/env";
import { closeDatabase, getDatabase, setDatabaseForTesting } from "../src/db/client";
import { registerMetrics, resetMetrics } from "../src/observability/metrics";
import { setStorageForTesting } from "../src/services/storage";
import { applyTestEnv } from "./setup-env";

export interface TestSession {
  cookie: string;
  csrfToken: string;
  userId: string;
}

/**
 * Minimal browser stand-in for cookie handling.
 *
 * Bun's `fetch` has no cookie jar, so tests carry the session cookie and the
 * CSRF token the way the frontend does.
 */
export async function createSession(baseUrl: string): Promise<TestSession> {
  const response = await fetch(`${baseUrl}/api/v1/auth/demo`, { method: "POST" });
  if (response.status !== 201) {
    throw new Error(`Failed to create demo session: ${response.status} ${await response.text()}`);
  }

  const setCookies = response.headers.getSetCookie();
  const cookie = setCookies
    .map((entry) => entry.split(";")[0])
    .filter(Boolean)
    .join("; ");
  const body = (await response.json()) as { csrfToken: string; user: { id: string } };

  return { cookie, csrfToken: body.csrfToken, userId: body.user.id };
}

export function authedHeaders(session: TestSession, extra: Record<string, string> = {}) {
  return {
    cookie: session.cookie,
    "x-csrf-token": session.csrfToken,
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
    "TRUNCATE generation_events, jobs, generations, assets, demo_sessions, rate_limit_buckets, users RESTART IDENTITY CASCADE",
  );
}

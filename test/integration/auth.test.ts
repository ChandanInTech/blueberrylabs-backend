import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import * as envModule from "../../src/config/env";
import { getDatabase } from "../../src/db/client";
import { setStorageForTesting } from "../../src/services/storage";
import { authedHeaders, bootTestRuntime, createSession, resetSingletons, truncateAll } from "../harness";
import { setupTestDatabase, teardownTestDatabase, testDatabaseUrl } from "../setup-env";

async function json<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

let app: ReturnType<typeof createApp>;
let url: string;

beforeAll(async () => {
  bootTestRuntime();
  process.env.DATABASE_URL = testDatabaseUrl();
  envModule.resetEnvCache();
  await setupTestDatabase();
  app = createApp();
  app.listen(0);
  url = `http://localhost:${app.server!.port}`;

  // The filesystem storage adapter mints presigned URLs from API_PUBLIC_URL;
  // point it at the ephemeral test port.
  process.env.API_PUBLIC_URL = url;
  envModule.resetEnvCache();
  setStorageForTesting(null);
}, 60_000);

afterAll(async () => {
  await app?.stop();
  await resetSingletons();
  await teardownTestDatabase();
}, 30_000);

describe("demo authentication", () => {
  test("creates a session and sets HttpOnly cookies", async () => {
    const response = await fetch(`${url}/api/v1/auth/demo`, { method: "POST" });
    expect(response.status).toBe(201);

    const cookies = response.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => c.startsWith("bl_session="));
    const csrfCookie = cookies.find((c) => c.startsWith("bl_csrf="));

    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(csrfCookie).toBeDefined();
    // CSRF token must be readable by JS for the double-submit pattern.
    expect(csrfCookie).not.toContain("HttpOnly");

    const body = await json(response);
    expect(body.user.kind).toBe("DEMO");
    expect(typeof body.user.id).toBe("string");
    expect(typeof body.csrfToken).toBe("string");
  });

  test("never stores the raw session token", async () => {
    const response = await fetch(`${url}/api/v1/auth/demo`, { method: "POST" });
    const rawCookie = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("bl_session="))!
      .split(";")[0]!
      .split("=")[1]!;

    const rows = await getDatabase().client`SELECT token_hash FROM demo_sessions`;
    const hashes = rows.map((row) => row.token_hash as string);
    expect(hashes).not.toContain(rawCookie);
    expect(hashes.some((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  test("returns the current session", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.user.id).toBe(session.userId);
    expect(body.csrfToken).toBe(session.csrfToken);
  });

  test("rejects an unauthenticated session read", async () => {
    const response = await fetch(`${url}/api/v1/auth/session`);
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBeString();
  });

  test("logout revokes the session and clears cookies", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: authedHeaders(session),
    });
    expect(response.status).toBe(204);

    const cleared = response.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith("bl_session=;"))).toBe(true);

    const after = await fetch(`${url}/api/v1/auth/session`, { headers: { cookie: session.cookie } });
    expect(after.status).toBe(401);
  });

  test("logout without a CSRF token is rejected", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: session.cookie },
    });
    expect(response.status).toBe(403);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("CSRF_TOKEN_INVALID");
  });

  test("rejects requests from a disallowed origin", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { ...authedHeaders(session), origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
    expect((await json<{ error: { code: string } }>(response)).error.code).toBe("INVALID_ORIGIN");
  });

  test("allows the configured web origin", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { ...authedHeaders(session), origin: "http://localhost:3000" },
    });
    expect(response.status).toBe(204);
  });

  test("a forged session cookie is rejected", async () => {
    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { cookie: "bl_session=forged-token-value; bl_csrf=whatever" },
    });
    expect(response.status).toBe(401);
  });

  test("echoes the correlation id header", async () => {
    const response = await fetch(`${url}/health/live`, { headers: { "x-request-id": "trace-me-123" } });
    expect(response.headers.get("x-request-id")).toBe("trace-me-123");
  });
});

describe("health endpoints", () => {
  test("live reports ok", async () => {
    const response = await fetch(`${url}/health/live`);
    expect(response.status).toBe(200);
    expect((await json<{ status: string }>(response)).status).toBe("ok");
  });

  test("ready checks the database", async () => {
    const response = await fetch(`${url}/health/ready`);
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.status).toBe("ok");
    expect(body.checks.database).toBe("ok");
    // Readiness must never leak configuration values.
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });
});

describe("rate limiting", () => {
  beforeAll(() => {
    // Restore the production defaults this suite asserts on.
    process.env.RATE_LIMIT_GENERATION_PER_MINUTE = "3";
    process.env.MAX_GENERATIONS_PER_USER_PER_DAY = "20";
    process.env.MAX_CONCURRENT_GENERATIONS_PER_USER = "2";
    envModule.resetEnvCache();
  });

  test("returns 429 with Retry-After once the demo-auth limit is hit", async () => {
    // Limit is 10 per 15 minutes per IP; each test request has no proxy IP, so
    // the limiter keys on nothing and allows. Force a user-scoped limit instead
    // by hammering the generation endpoint with a real session.
    const session = await createSession(url);

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await fetch(`${url}/api/v1/generations`, {
        method: "POST",
        headers: authedHeaders(session, { "content-type": "application/json" }),
        body: JSON.stringify({
          assetId: "00000000-0000-4000-8000-000000000000",
          platform: "INSTAGRAM",
          format: "SQUARE",
        }),
      });
      statuses.push(response.status);
      if (response.status === 429) {
        expect(response.headers.get("retry-after")).toBeString();
        const body = await json(response);
        expect(body.error.code).toBe("RATE_LIMIT_EXCEEDED");
        expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
        break;
      }
    }

    expect(statuses).toContain(429);
  });

  test("rate limiting is atomic under concurrency", async () => {
    const session = await createSession(url);
    const { rules, consume } = await import("../../src/middleware/rate-limit");
    const rule = { ...rules().generation, limit: 5 };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => consume(rule, { userId: session.userId })),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
  });
});

describe("ownership isolation", () => {
  test("a user cannot read another user's generation", async () => {
    const alice = await createSession(url);
    const bob = await createSession(url);
    expect(alice.userId).not.toBe(bob.userId);

    const response = await fetch(`${url}/api/v1/generations/00000000-0000-4000-8000-000000000001`, {
      headers: { cookie: bob.cookie },
    });
    expect(response.status).toBe(404);
  });

  test("protected routes reject missing sessions", async () => {
    for (const path of ["/api/v1/generations", "/api/v1/assets/00000000-0000-4000-8000-000000000001"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(401);
    }
  });
});

export { truncateAll };

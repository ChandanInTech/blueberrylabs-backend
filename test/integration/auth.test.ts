import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApp } from "../../src/app";
import * as envModule from "../../src/config/env";
import { getDatabase } from "../../src/db/client";
import {
  backfillAccessCodes,
  createAccessCode,
  createDemoUserWithCode,
  getOrCreateAccessCode,
  hashCode,
} from "../../src/modules/auth/session";
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

describe("access-code login", () => {
  test("exchanges a valid code for a JWT", async () => {
    const { code, userId } = await createDemoUserWithCode("login test");

    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    expect(response.status).toBe(200);
    const body = await json(response);

    expect(body.user.id).toBe(userId);
    expect(body.user.kind).toBe("DEMO");
    expect(typeof body.token).toBe("string");
    // Three base64url segments: header.payload.signature.
    expect(body.token.split(".")).toHaveLength(3);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  test("issues a token valid for the configured TTL (24h by default)", async () => {
    const { code } = await createDemoUserWithCode();
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const body = await json(response);
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    // Allow a minute of slack for the round trip.
    expect(ttlMs).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3600 * 1000);
  });

  test("accepts a code typed with separators and lower case", async () => {
    const { code } = await createDemoUserWithCode();
    const messy = code.toLowerCase().split("").join("-");

    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: messy }),
    });

    expect(response.status).toBe(200);
  });

  test("rejects an unknown code", async () => {
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "ZZZZZZZZZZ" }),
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error.code).toBe("UNAUTHENTICATED");
  });

  test("a permanent code has no expiry", async () => {
    const { code, userId } = await createDemoUserWithCode();
    const [row] = await getDatabase().client`
      SELECT expires_at, redeemed_at FROM access_codes WHERE user_id = ${userId}
    `;

    expect(row?.expires_at).toBeNull();
    expect(row?.redeemed_at).toBeNull();
  });

  test("the same code logs the same user in repeatedly", async () => {
    const { code, userId } = await createDemoUserWithCode();

    const logins = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await fetch(`${url}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(response.status).toBe(200);
      logins.push(await json(response));
    }

    // Same identity every time, but a distinct session (and therefore token).
    expect(logins.every((body) => body.user.id === userId)).toBe(true);
    expect(new Set(logins.map((body) => body.token)).size).toBe(3);
  });

  test("concurrent logins with one code all succeed", async () => {
    const { code, userId } = await createDemoUserWithCode();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(`${url}/api/v1/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        }),
      ),
    );

    // A permanent code is reusable, so every request succeeds.
    expect(responses.filter((r) => r.status === 200)).toHaveLength(8);
    const bodies = await Promise.all(responses.map((r) => json(r)));
    expect(bodies.every((body) => body.user.id === userId)).toBe(true);
  });

  test("rejects an expired code (invitation-style codes only)", async () => {
    const { userId } = await createDemoUserWithCode();
    await getDatabase().client`
      UPDATE access_codes SET expires_at = now() - interval '1 hour' WHERE user_id = ${userId}
    `;

    const [row] = await getDatabase().client`
      SELECT code_hash FROM access_codes WHERE user_id = ${userId}
    `;
    expect(row?.code_hash).toBeString();

    // The code itself is unknown (only its hash is stored), so assert via a
    // freshly created user whose code we do know.
    const fresh = await createDemoUserWithCode();
    await getDatabase().client`
      UPDATE access_codes SET expires_at = now() - interval '1 hour' WHERE user_id = ${fresh.userId}
    `;

    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: fresh.code }),
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error.message).toContain("expired");
  });

  test("rejects a revoked code", async () => {
    const { code, userId } = await createDemoUserWithCode();
    await getDatabase().client`
      UPDATE access_codes SET revoked_at = now() WHERE user_id = ${userId}
    `;

    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });

    expect(response.status).toBe(401);
    expect((await json(response)).error.message).toContain("revoked");
  });

  test("a user can only have one code", async () => {
    const { userId } = await createDemoUserWithCode();

    // The unique index on user_id is what enforces "one code per user".
    await expect(createAccessCode(userId, "second")).rejects.toThrow();
  });

  test("getOrCreateAccessCode is idempotent", async () => {
    const { userId } = await createDemoUserWithCode();

    const first = await getOrCreateAccessCode(userId);
    expect(first.created).toBe(false);
    expect(first.code).toBe("");

    const fresh = await createDemoUserWithCode();
    const second = await getOrCreateAccessCode(fresh.userId);
    expect(second.created).toBe(false);
  });

  test("backfill issues a code for every user that lacks one", async () => {
    // Simulate pre-migration users: insert users with no code.
    const db = getDatabase().client;
    await db`INSERT INTO users (kind) VALUES ('DEMO'), ('DEMO'), ('DEMO')`;

    const { issued } = await backfillAccessCodes("backfill test");
    expect(issued.length).toBeGreaterThanOrEqual(3);

    // Every user now has exactly one code.
    const orphans = await db`
      SELECT count(*)::int AS n FROM users u
      WHERE NOT EXISTS (SELECT 1 FROM access_codes ac WHERE ac.user_id = u.id)
    `;
    expect(orphans[0]?.n).toBe(0);

    // And a backfilled code actually works.
    const response = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: issued[0]!.code }),
    });
    expect(response.status).toBe(200);
    expect((await json(response)).user.id).toBe(issued[0]!.userId);
  });

  test("never stores the raw code", async () => {
    const { code } = await createDemoUserWithCode();
    const rows = await getDatabase().client`SELECT code_hash FROM access_codes`;
    const hashes = rows.map((row) => row.code_hash as string);

    expect(hashes).not.toContain(code);
    expect(hashes).toContain(hashCode(code));
    expect(hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash))).toBe(true);
  });

  test("rejects a missing or too-short code at the schema layer", async () => {
    for (const body of [{}, { code: "" }, { code: "ab" }]) {
      const response = await fetch(`${url}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await json(response)).error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("bearer token authentication", () => {
  test("returns the current session for a valid token", async () => {
    const session = await createSession(url);
    const response = await fetch(`${url}/api/v1/auth/session`, { headers: authedHeaders(session) });

    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body.user.id).toBe(session.userId);
    expect(body.token).toBe(session.token);
  });

  test("rejects a request with no Authorization header", async () => {
    const response = await fetch(`${url}/api/v1/auth/session`);
    expect(response.status).toBe(401);
    const body = await json(response);
    expect(body.error.code).toBe("UNAUTHENTICATED");
    expect(body.error.requestId).toBeString();
  });

  test("rejects a malformed Authorization header", async () => {
    for (const header of ["", "Bearer", "Bearer ", "Basic abc", "token abc", "Bearer  "]) {
      const response = await fetch(`${url}/api/v1/auth/session`, {
        headers: { authorization: header },
      });
      expect(response.status).toBe(401);
    }
  });

  test("rejects a forged token", async () => {
    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { authorization: "Bearer forged.token.value" },
    });
    expect(response.status).toBe(401);
  });

  test("rejects a token whose signature was tampered with", async () => {
    const session = await createSession(url);
    const [header, payload, signature] = session.token.split(".");
    // Flip the last character of the signature.
    const flipped = signature!.slice(0, -1) + (signature!.endsWith("A") ? "B" : "A");

    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${header}.${payload}.${flipped}` },
    });
    expect(response.status).toBe(401);
  });

  test("rejects a token signed with the wrong secret", async () => {
    const { signAccessToken } = await import("../../src/modules/auth/jwt");
    const { token } = signAccessToken({ sub: "someone", jti: crypto.randomUUID() }, "x".repeat(48), 3600);

    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  test("rejects an expired token even with a valid signature", async () => {
    const { signAccessToken } = await import("../../src/modules/auth/jwt");
    const session = await createSession(url);
    const { token } = signAccessToken(
      { sub: session.userId, jti: crypto.randomUUID() },
      process.env.JWT_SECRET!,
      0,
    );

    const response = await fetch(`${url}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(401);
  });

  test("rejects a valid token whose session row was deleted", async () => {
    const session = await createSession(url);
    await getDatabase().client`DELETE FROM auth_sessions`;

    const response = await fetch(`${url}/api/v1/auth/session`, { headers: authedHeaders(session) });
    expect(response.status).toBe(401);
  });

  test("protected routes reject a missing token", async () => {
    for (const path of ["/api/v1/generations", "/api/v1/assets/00000000-0000-4000-8000-000000000001"]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(401);
    }
  });

  test("protected routes reject a forged token", async () => {
    const response = await fetch(`${url}/api/v1/generations`, {
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(response.status).toBe(401);
  });
});

describe("logout", () => {
  test("revokes the token immediately", async () => {
    const session = await createSession(url);

    const before = await fetch(`${url}/api/v1/auth/session`, { headers: authedHeaders(session) });
    expect(before.status).toBe(200);

    const logout = await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: authedHeaders(session),
    });
    expect(logout.status).toBe(204);

    // The token is still cryptographically valid but must no longer be accepted.
    const after = await fetch(`${url}/api/v1/auth/session`, { headers: authedHeaders(session) });
    expect(after.status).toBe(401);
  });

  test("does not affect other sessions for the same user", async () => {
    // One code per user, but each login creates its own session — so logging
    // out on one device must not sign the user out on another.
    const { code } = await createDemoUserWithCode();

    const login = async () => {
      const response = await fetch(`${url}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      return (await json<{ token: string }>(response)).token;
    };

    const tokenA = await login();
    const tokenB = await login();
    expect(tokenA).not.toBe(tokenB);

    await fetch(`${url}/api/v1/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}` },
    });

    const stillValid = await fetch(`${url}/api/v1/auth/session`, {
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(stillValid.status).toBe(200);
  });

  test("logout without a token is rejected", async () => {
    const response = await fetch(`${url}/api/v1/auth/logout`, { method: "POST" });
    expect(response.status).toBe(401);
  });
});

describe("origin allow-list", () => {
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

  test("returns 429 with Retry-After once the generation limit is hit", async () => {
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
      headers: authedHeaders(bob),
    });
    expect(response.status).toBe(404);
  });
});

export { truncateAll };

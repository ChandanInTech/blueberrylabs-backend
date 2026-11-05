import { eq, lt } from "drizzle-orm";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";
import { demo_sessions, users } from "../../db/schema";
import type { ScopedLogger } from "../../observability/logger";
import { hmacSha256, safeEqual, sha256 } from "../../utils/crypto";
import { errors } from "../../utils/errors";
import { randomToken } from "../../utils/ids";

export const SESSION_COOKIE = "bl_session";
export const CSRF_COOKIE = "bl_csrf";

export interface SessionPrincipal {
  sessionId: string;
  userId: string;
  csrfTokenHash: string;
  expiresAt: Date;
}

export interface IssuedSession extends SessionPrincipal {
  token: string;
  csrfToken: string;
}

function cookieSecure(): boolean {
  const env = getEnv();
  if (env.COOKIE_SECURE === "auto") return env.NODE_ENV === "production";
  return env.COOKIE_SECURE === "true";
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (cookieSecure()) attributes.push("Secure");
  return attributes.join("; ");
}

/**
 * The CSRF token is intentionally readable by JavaScript (double-submit
 * pattern) but still SameSite=Lax and short-lived so it cannot be replayed
 * cross-origin.
 */
export function csrfCookie(token: string, maxAgeSeconds: number): string {
  const attributes = [`${CSRF_COOKIE}=${token}`, "Path=/", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (cookieSecure()) attributes.push("Secure");
  return attributes.join("; ");
}

export function clearSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecure() ? "; Secure" : ""}`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0${cookieSecure() ? "; Secure" : ""}`,
  ];
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Create a demo principal and session.
 *
 * The architecture allows either a shared demo principal or per-visitor
 * principals; this uses a fresh principal per demo login so ownership checks
 * are meaningful (cross-user access tests need two distinct users) while still
 * requiring no signup.
 */
export async function createDemoSession(log: ScopedLogger): Promise<IssuedSession> {
  const db = getDb();
  const env = getEnv();
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + env.DEMO_SESSION_TTL_HOURS * 60 * 60 * 1000);

  const session = await db.transaction(async (tx) => {
    const [user] = await tx.insert(users).values({ kind: "DEMO" }).returning();
    if (!user) throw errors.internal(new Error("demo user insert returned no row"));

    const [row] = await tx
      .insert(demo_sessions)
      .values({
        userId: user.id,
        tokenHash: sha256(token),
        csrfTokenHash: hmacSha256(env.DEMO_SESSION_SECRET, csrfToken),
        expiresAt,
      })
      .returning();

    if (!row) throw errors.internal(new Error("demo session insert returned no row"));
    return row;
  });

  log.info("auth.demo_session.created", { userId: session.userId, sessionId: session.id });

  return {
    sessionId: session.id,
    userId: session.userId,
    csrfTokenHash: session.csrfTokenHash,
    expiresAt: session.expiresAt,
    token,
    csrfToken,
  };
}

/** Validate a raw session token. Returns `null` when the session is unusable. */
export async function findSessionByToken(token: string | undefined): Promise<SessionPrincipal | null> {
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select()
    .from(demo_sessions)
    .where(eq(demo_sessions.tokenHash, sha256(token)))
    .limit(1);

  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  return {
    sessionId: row.id,
    userId: row.userId,
    csrfTokenHash: row.csrfTokenHash,
    expiresAt: row.expiresAt,
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await getDb().update(demo_sessions).set({ revokedAt: new Date() }).where(eq(demo_sessions.id, sessionId));
}

/**
 * Validate the double-submit CSRF token.
 *
 * The raw CSRF token lives only in the readable `bl_csrf` cookie; we compare
 * it against the hash bound to the session server-side, so a forged cookie
 * alone is useless.
 */
export function verifyCsrf(principal: SessionPrincipal, headerToken: string | undefined): boolean {
  if (!headerToken) return false;
  const derived = hmacSha256(getEnv().DEMO_SESSION_SECRET, headerToken);
  return safeEqual(derived, principal.csrfTokenHash);
}

/** Remove sessions that are long expired. Called by the cleanup task. */
export async function deleteExpiredSessions(olderThan: Date): Promise<number> {
  const deleted = await getDb()
    .delete(demo_sessions)
    .where(lt(demo_sessions.expiresAt, olderThan))
    .returning({ id: demo_sessions.id });
  return deleted.length;
}

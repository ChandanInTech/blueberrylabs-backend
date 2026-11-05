import { and, eq, isNull, lt } from "drizzle-orm";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";
import { access_codes, auth_sessions, users } from "../../db/schema";
import type { ScopedLogger } from "../../observability/logger";
import { sha256 } from "../../utils/crypto";
import { errors } from "../../utils/errors";
import { randomToken, uuid } from "../../utils/ids";
import { signAccessToken, verifyAccessToken } from "./jwt";

/** The authenticated caller, resolved from a bearer token. */
export interface SessionPrincipal {
  userId: string;
  /** The `auth_sessions` row id, equal to the token's `jti`. */
  sessionId: string;
  expiresAt: Date;
}

export interface IssuedSession {
  token: string;
  expiresAt: Date;
  userId: string;
}

/**
 * Canonical form of an access code.
 *
 * Codes are shown grouped (`ABCD-EFGH`) but typed however the user likes, so
 * separators are stripped and case is folded before hashing. Without this the
 * same code would hash differently depending on how it was typed.
 */
export function normaliseCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** Hash a normalised code for storage and lookup. */
export function hashCode(code: string): string {
  return sha256(normaliseCode(code));
}

/**
 * Exchange an access code for a signed token.
 *
 * Runs in one transaction so a single-use code cannot be redeemed twice by two
 * concurrent requests: the `UPDATE ... WHERE redeemed_at IS NULL` both claims
 * the code and tells us whether we won the race.
 */
export async function loginWithCode(code: string, log: ScopedLogger): Promise<IssuedSession> {
  const env = getEnv();
  const codeHash = hashCode(code);

  const issued = await getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(access_codes).where(eq(access_codes.codeHash, codeHash)).limit(1);

    if (!row) throw errors.unauthenticated("That access code is not valid.");
    if (row.revokedAt !== null) throw errors.unauthenticated("That access code has been revoked.");
    if (row.expiresAt.getTime() <= Date.now()) throw errors.unauthenticated("That access code has expired.");

    if (env.ACCESS_CODE_SINGLE_USE) {
      const claimed = await tx
        .update(access_codes)
        .set({ redeemedAt: new Date() })
        .where(and(eq(access_codes.id, row.id), isNull(access_codes.redeemedAt)))
        .returning({ id: access_codes.id });

      if (claimed.length === 0) {
        throw errors.unauthenticated("That access code has already been used.");
      }
    }

    const sessionId = uuid();
    const { token, expiresAt } = signAccessToken(
      { sub: row.userId, jti: sessionId },
      env.JWT_SECRET,
      env.JWT_TTL_HOURS * 3600,
    );

    await tx.insert(auth_sessions).values({ id: sessionId, userId: row.userId, expiresAt });

    return { token, expiresAt, userId: row.userId, sessionId };
  });

  log.info("auth.login", { userId: issued.userId, sessionId: issued.sessionId });

  return { token: issued.token, expiresAt: issued.expiresAt, userId: issued.userId };
}

/**
 * Resolve a bearer token to a principal.
 *
 * Two independent checks, both required:
 *   1. the signature and `exp` claim (stateless, no database round trip);
 *   2. the `auth_sessions` row (stateful, so logout and revocation are
 *      immediate rather than deferred to token expiry).
 *
 * Returns `null` for any failure so callers cannot accidentally treat a
 * partially-valid token as authenticated.
 */
export async function authenticate(token: string | undefined): Promise<SessionPrincipal | null> {
  if (!token) return null;

  const claims = verifyAccessToken(token, getEnv().JWT_SECRET);
  if (!claims) return null;

  const [session] = await getDb()
    .select()
    .from(auth_sessions)
    .where(and(eq(auth_sessions.id, claims.jti), isNull(auth_sessions.revokedAt)))
    .limit(1);

  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  // The token's subject must match the session owner; a mismatch means the
  // token was minted against a different row and is not trustworthy.
  if (session.userId !== claims.sub) return null;

  return { userId: session.userId, sessionId: session.id, expiresAt: session.expiresAt };
}

/** Revoke one session. Idempotent: revoking twice is not an error. */
export async function revokeSession(sessionId: string): Promise<void> {
  await getDb()
    .update(auth_sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(auth_sessions.id, sessionId), isNull(auth_sessions.revokedAt)));
}

/**
 * Create an access code for a user.
 *
 * The raw code is returned exactly once and never persisted; only its hash is
 * stored. Callers must show it to the operator immediately.
 */
export async function createAccessCode(userId: string, label?: string): Promise<string> {
  const env = getEnv();
  // 9 random bytes -> 12 base64url chars; strip to 10 alphanumerics for typing.
  const code = normaliseCode(randomToken(9)).slice(0, 10);

  await getDb()
    .insert(access_codes)
    .values({
      codeHash: hashCode(code),
      userId,
      label: label ?? null,
      expiresAt: new Date(Date.now() + env.ACCESS_CODE_TTL_HOURS * 3600 * 1000),
    });

  return code;
}

/** Create a demo user and an access code for it in one step. */
export async function createDemoUserWithCode(label?: string): Promise<{ userId: string; code: string }> {
  const [user] = await getDb().insert(users).values({ kind: "DEMO" }).returning();
  if (!user) throw errors.internal(new Error("demo user insert returned no row"));
  return { userId: user.id, code: await createAccessCode(user.id, label) };
}

/** Remove sessions that expired before `olderThan`. Called by the cleanup task. */
export async function deleteExpiredSessions(olderThan: Date): Promise<number> {
  const deleted = await getDb()
    .delete(auth_sessions)
    .where(lt(auth_sessions.expiresAt, olderThan))
    .returning({ id: auth_sessions.id });
  return deleted.length;
}

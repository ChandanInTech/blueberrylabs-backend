import { createHmac } from "node:crypto";
import { safeEqual } from "../../utils/crypto";

/**
 * Minimal HS256 JWT implementation.
 *
 * Hand-rolled rather than pulled from a library because the surface we need is
 * three functions and the verification rules are the security-critical part:
 * the algorithm is fixed (never read from the token header, which defeats
 * `alg: none` and algorithm-confusion attacks), the signature is compared in
 * constant time, and `exp` is enforced here rather than by the caller.
 */

export interface AccessTokenClaims {
  /** Subject: the user id. */
  sub: string;
  /** JWT id: the `auth_sessions` row, so logout can revoke before expiry. */
  jti: string;
  /** Issued-at, seconds since the epoch. */
  iat: number;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

function sign(header: string, payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
}

export interface SignedToken {
  token: string;
  expiresAt: Date;
}

/** Issue a token for `sub`, valid for `ttlSeconds`. */
export function signAccessToken(
  input: { sub: string; jti: string },
  secret: string,
  ttlSeconds: number,
): SignedToken {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttlSeconds;
  const payload = Buffer.from(
    JSON.stringify({ sub: input.sub, jti: input.jti, iat, exp } satisfies AccessTokenClaims),
  ).toString("base64url");

  return {
    token: `${HEADER}.${payload}.${sign(HEADER, payload, secret)}`,
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * Verify a token's signature and expiry.
 *
 * Returns `null` for anything untrustworthy — malformed, wrong signature,
 * expired, or missing required claims. Callers must treat `null` as
 * unauthenticated; there is no partial-trust result.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts as [string, string, string];

  // The header is not trusted for algorithm selection, but a token claiming a
  // different algorithm is not one we issued, so reject it outright.
  let parsedHeader: { alg?: unknown; typ?: unknown };
  try {
    parsedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (parsedHeader.alg !== "HS256") return null;

  if (!safeEqual(signature, sign(header, payload, secret))) return null;

  let claims: Partial<AccessTokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof claims.sub !== "string" || claims.sub === "") return null;
  if (typeof claims.jti !== "string" || claims.jti === "") return null;
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
  if (claims.exp <= Math.floor(Date.now() / 1000)) return null;

  return {
    sub: claims.sub,
    jti: claims.jti,
    iat: typeof claims.iat === "number" ? claims.iat : 0,
    exp: claims.exp,
  };
}

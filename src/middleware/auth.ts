import { authenticate, type SessionPrincipal } from "../modules/auth/session";
import { errors } from "../utils/errors";
import { assertSafeOrigin } from "./origin";
import { getContext } from "./request-context";

/**
 * Read request headers from the `Request` itself.
 *
 * Elysia validates and rewrites the decoded `headers` object when a route
 * declares a header schema, which would drop `authorization` and `origin`. The
 * raw request is the authoritative source for security-relevant headers.
 */
export function rawHeaders(request: Request): Record<string, string | undefined> {
  return Object.fromEntries(request.headers.entries()) as Record<string, string | undefined>;
}

/** Extract the token from `Authorization: Bearer <token>`. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (!header) return undefined;

  const separator = header.indexOf(" ");
  if (separator <= 0) return undefined;

  const scheme = header.slice(0, separator);
  const value = header.slice(separator + 1).trim();
  if (scheme.toLowerCase() !== "bearer" || value === "") return undefined;

  return value;
}

/**
 * Resolve the authenticated principal for a request.
 *
 * The token is the only credential: it is verified (signature + expiry) and
 * then checked against its `auth_sessions` row so revocation is immediate.
 * A missing, malformed, tampered, expired, or revoked token is rejected with
 * 401 before any route handler runs.
 *
 * There is deliberately no CSRF token. Browsers never attach an
 * `Authorization` header on their own, so a cross-site request cannot carry the
 * credential — the attack CSRF defends against does not apply to bearer tokens.
 * The `Origin` allow-list is kept as defence in depth.
 */
export async function requireSession(context: { request: Request }): Promise<SessionPrincipal> {
  const { request } = context;
  const ctx = getContext(request);

  assertSafeOrigin(
    request.method,
    request.headers.get("origin") ?? undefined,
    request.headers.get("host") ?? undefined,
  );

  const principal = await authenticate(bearerToken(request));
  if (!principal) throw errors.unauthenticated("Your session has expired. Please sign in again.");

  ctx.userId = principal.userId;
  return principal;
}

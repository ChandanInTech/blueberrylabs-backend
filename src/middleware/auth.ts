import type { SessionPrincipal } from "../modules/auth/session";
import { findSessionByToken, parseCookies, SESSION_COOKIE, verifyCsrf } from "../modules/auth/session";
import { errors } from "../utils/errors";
import { assertSafeOrigin, SAFE_METHODS } from "./origin";
import { getContext } from "./request-context";

/**
 * Read request headers from the `Request` itself.
 *
 * Elysia validates and rewrites the decoded `headers` object when a route
 * declares a header schema, which would drop `cookie` and `origin`. The raw
 * request is the authoritative source for security-relevant headers.
 */
export function rawHeaders(request: Request): Record<string, string | undefined> {
  return Object.fromEntries(request.headers.entries()) as Record<string, string | undefined>;
}

/**
 * Resolve the authenticated principal for a request.
 *
 * Order: reject a disallowed `Origin`, validate the session cookie, then (for
 * state-changing methods) require a matching CSRF token. The resulting user id
 * is written into the request context so logs carry it.
 */
export async function requireSession(context: { request: Request }): Promise<SessionPrincipal> {
  const { request } = context;
  const method = request.method.toUpperCase();
  const ctx = getContext(request);
  const headers = rawHeaders(request);

  assertSafeOrigin(method, headers.origin, headers.host);

  const cookies = parseCookies(headers.cookie);
  const principal = await findSessionByToken(cookies[SESSION_COOKIE]);
  if (!principal) throw errors.unauthenticated();

  ctx.userId = principal.userId;

  if (!SAFE_METHODS.has(method)) {
    // Header only: accepting the cookie value alone would let any actor able to
    // write cookies bypass the double-submit check.
    if (!verifyCsrf(principal, headers["x-csrf-token"])) throw errors.csrf();
  }

  return principal;
}

import { Elysia, t } from "elysia";

/** Cookie definitions, mirrored across every route so the jar is typed. */
const cookieSchema = t.Object({
  bl_session: t.Optional(t.String()),
  bl_csrf: t.Optional(t.String()),
});

import type { DemoSessionResponse, SessionResponse } from "@social-resizer/contracts";
import { getEnv } from "../../config/env";
import { rawHeaders } from "../../middleware/auth";
import { enforce, rateLimitHeaders, rules } from "../../middleware/rate-limit";
import { getContext } from "../../middleware/request-context";
import { errors } from "../../utils/errors";
import { createDemoSession, findSessionByToken, revokeSession, verifyCsrf } from "./session";

function ttlSeconds(): number {
  return getEnv().DEMO_SESSION_TTL_HOURS * 60 * 60;
}

function cookieSecure(): boolean {
  const env = getEnv();
  return env.COOKIE_SECURE === "auto" ? env.NODE_ENV === "production" : env.COOKIE_SECURE === "true";
}

/**
 * SameSite policy for the session and CSRF cookies.
 *
 * Browsers reject `SameSite=None` without `Secure`, so the two are coupled
 * here rather than left to each call site.
 */
function cookieSameSite(): "lax" | "strict" | "none" {
  const env = getEnv();
  if (env.COOKIE_SAME_SITE === "none" && !cookieSecure()) {
    // Refuse to emit a cookie the browser will silently drop.
    throw new Error("COOKIE_SAME_SITE=none requires COOKIE_SECURE=true (or NODE_ENV=production)");
  }
  return env.COOKIE_SAME_SITE;
}

/**
 * Demo authentication.
 *
 * The server derives `userId` from the validated session row on every path; a
 * client-supplied user id is never read as authorization input.
 */
export const authRoutes = new Elysia({ prefix: "/auth", tags: ["auth"] })
  .post(
    "/demo",
    async ({ request, set, cookie: { bl_session, bl_csrf } }) => {
      const ctx = getContext(request);
      const limit = await enforce(rules().demoAuth, { clientIp: ctx.clientIp });

      const issued = await createDemoSession(ctx.log);

      bl_session.set({
        value: issued.token,
        httpOnly: true,
        path: "/",
        sameSite: cookieSameSite(),
        secure: cookieSecure(),
        maxAge: ttlSeconds(),
      });
      // Readable by JS for the double-submit CSRF pattern.
      bl_csrf.set({
        value: issued.csrfToken,
        httpOnly: false,
        path: "/",
        sameSite: cookieSameSite(),
        secure: cookieSecure(),
        maxAge: ttlSeconds(),
      });

      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;
      set.status = 201;
      ctx.userId = issued.userId;

      const body: DemoSessionResponse = {
        user: { id: issued.userId, kind: "DEMO" },
        expiresAt: issued.expiresAt.toISOString(),
        csrfToken: issued.csrfToken,
      };
      return body;
    },
    { cookie: cookieSchema, detail: { summary: "Create a demo session" } },
  )
  .get(
    "/session",
    async ({ request, cookie: { bl_session, bl_csrf } }) => {
      const ctx = getContext(request);
      const principal = await findSessionByToken(bl_session.value ?? undefined);
      if (!principal) {
        throw errors.unauthenticated("Your session has ended. Please continue with the demo account again.");
      }

      const csrfToken = bl_csrf.value;
      if (!csrfToken) {
        // The raw CSRF token cannot be recovered from its hash, so the browser
        // must re-establish a session rather than continue half-configured.
        throw errors.unauthenticated("Your session needs to be re-established.");
      }

      ctx.userId = principal.userId;

      const body: SessionResponse = {
        user: { id: principal.userId, kind: "DEMO" },
        expiresAt: principal.expiresAt.toISOString(),
        csrfToken,
      };
      return body;
    },
    { cookie: cookieSchema, detail: { summary: "Return the current demo session" } },
  )
  .post(
    "/logout",
    async ({ request, set, cookie: { bl_session, bl_csrf } }) => {
      const ctx = getContext(request);
      const headers = rawHeaders(request);
      const principal = await findSessionByToken(bl_session.value ?? undefined);

      if (principal) {
        if (!verifyCsrf(principal, headers["x-csrf-token"])) throw errors.csrf();
        await revokeSession(principal.sessionId);
        ctx.log.info("auth.demo_session.revoked", { userId: principal.userId });
      }

      bl_session.remove();
      bl_csrf.remove();
      set.status = 204;
      return null;
    },
    {
      detail: { summary: "Revoke the current demo session" },
      cookie: cookieSchema,
      headers: t.Object({ "x-csrf-token": t.Optional(t.String()) }),
    },
  );

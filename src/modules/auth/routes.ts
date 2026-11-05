import type { LoginResponse, SessionResponse } from "@social-resizer/contracts";
import { Elysia, t } from "elysia";
import { bearerToken, requireSession } from "../../middleware/auth";
import { enforce, rateLimitHeaders, rules } from "../../middleware/rate-limit";
import { getContext } from "../../middleware/request-context";
import { loginWithCode, revokeSession } from "./session";

/**
 * Access-code authentication.
 *
 * `POST /auth/login` is the only way to obtain a token. Every other endpoint
 * requires `Authorization: Bearer <token>`; the server derives `userId` from
 * the verified token and never reads a client-supplied user id.
 */
export const authRoutes = new Elysia({ prefix: "/auth", tags: ["auth"] })
  .post(
    "/login",
    async ({ request, set, body }) => {
      const ctx = getContext(request);
      const limit = await enforce(rules().demoAuth, { clientIp: ctx.clientIp });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const issued = await loginWithCode(body.code, ctx.log);
      ctx.userId = issued.userId;

      const response: LoginResponse = {
        token: issued.token,
        expiresAt: issued.expiresAt.toISOString(),
        user: { id: issued.userId, kind: "DEMO" },
      };
      return response;
    },
    {
      body: t.Object({
        code: t.String({ minLength: 4, maxLength: 64, description: "The access code issued to the user" }),
      }),
      detail: { summary: "Exchange an access code for a JWT" },
    },
  )
  .get(
    "/session",
    async ({ request }) => {
      const principal = await requireSession({ request });

      const response: SessionResponse = {
        // Echo the caller's own token so a page reload can rehydrate state
        // without a second login round trip.
        token: bearerToken(request) ?? "",
        expiresAt: principal.expiresAt.toISOString(),
        user: { id: principal.userId, kind: "DEMO" },
      };
      return response;
    },
    { detail: { summary: "Return the current session" } },
  )
  .post(
    "/logout",
    async ({ request, set }) => {
      const principal = await requireSession({ request });
      await revokeSession(principal.sessionId);
      getContext(request).log.info("auth.logout", { userId: principal.userId });
      set.status = 204;
      return null;
    },
    { detail: { summary: "Revoke the current token" } },
  );

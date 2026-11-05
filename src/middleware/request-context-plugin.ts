import { Elysia } from "elysia";
import { attachContext, createRequestContext } from "./request-context";

/**
 * Installs the per-request context and echoes the correlation id.
 *
 * Registered first in the composition root so every downstream hook (auth,
 * rate limiting, error handling, metrics) can read the context. Hooks declared
 * on the root instance are inherited by every mounted module.
 */
export const requestContextPlugin = new Elysia({ name: "request-context" }).onRequest(({ request, set }) => {
  const headers = Object.fromEntries(request.headers.entries()) as Record<string, string | undefined>;
  const inbound = headers["x-request-id"]?.trim();
  const requestId = inbound && /^[\w.:-]{1,100}$/.test(inbound) ? inbound : crypto.randomUUID();
  const ctx = createRequestContext(requestId, headers);
  attachContext(request, ctx);
  set.headers["X-Request-Id"] = requestId;
});

import { Elysia } from "elysia";
import { currentTraceId } from "../observability/tracing";
import { attachContext, createRequestContext } from "./request-context";

/**
 * Installs the per-request context and echoes the correlation id.
 *
 * Registered after the OpenTelemetry plugin in the composition root, so the
 * plugin's request span is already active here and its trace id can be
 * attached to the context (logs) and echoed as `X-Trace-Id` when tracing is
 * enabled. Hooks declared on the root instance are inherited by every
 * mounted module.
 */
export const requestContextPlugin = new Elysia({ name: "request-context" }).onRequest(({ request, set }) => {
  const headers = Object.fromEntries(request.headers.entries()) as Record<string, string | undefined>;
  const inbound = headers["x-request-id"]?.trim();
  const requestId = inbound && /^[\w.:-]{1,100}$/.test(inbound) ? inbound : crypto.randomUUID();
  const traceId = currentTraceId();
  const ctx = createRequestContext(requestId, headers, { traceId });
  attachContext(request, ctx);
  set.headers["X-Request-Id"] = requestId;
  if (traceId) set.headers["X-Trace-Id"] = traceId;
});

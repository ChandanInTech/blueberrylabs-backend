import { AsyncLocalStorage } from "node:async_hooks";
import { logger, type ScopedLogger } from "../observability/logger";
import { increment, observe } from "../observability/metrics";

export interface RequestContext {
  requestId: string;
  /** OpenTelemetry trace id for this request, when tracing is enabled. */
  traceId?: string;
  startedAt: number;
  log: ScopedLogger;
  /** Set by the auth middleware once a session is validated. */
  userId?: string;
  /** Client IP, only populated when a trusted proxy header is present. */
  clientIp?: string;
}

/**
 * Per-request context, keyed by the `Request` object.
 *
 * Elysia v1 has no `declare()` singleton hook, and threading context through
 * `derive()` would couple every module to the composition root. A WeakMap keyed
 * by the request keeps the context available to `onRequest`, `onError` and
 * `onAfterResponse` without widening route handler signatures.
 */
const contexts = new WeakMap<Request, RequestContext>();

/**
 * Derive the client IP from proxy headers.
 *
 * Railway terminates TLS and forwards `X-Forwarded-For`. We take the right-most
 * entry, which is the one appended by the closest trusted proxy; earlier entries
 * are client-controlled and must not be trusted.
 */
export function resolveClientIp(headers: Record<string, string | undefined>): string | undefined {
  const forwarded = headers["x-forwarded-for"];
  if (forwarded) {
    const parts = forwarded
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.at(-1) ?? undefined;
  }
  return headers["x-real-ip"]?.trim() || undefined;
}

export function createRequestContext(
  requestId: string,
  headers: Record<string, string | undefined>,
  options: { traceId?: string } = {},
): RequestContext {
  const log = logger.child({ requestId, traceId: options.traceId });
  return {
    requestId,
    traceId: options.traceId,
    startedAt: performance.now(),
    log,
    clientIp: resolveClientIp(headers),
  };
}

export function attachContext(request: Request, ctx: RequestContext): void {
  contexts.set(request, ctx);
}

/** Context for a request, or a fresh fallback (never throws mid-error handling). */
export function getContext(request: Request): RequestContext {
  const existing = contexts.get(request);
  if (existing) return existing;
  const ctx = createRequestContext(crypto.randomUUID(), {});
  contexts.set(request, ctx);
  return ctx;
}

export function recordRequestMetrics(
  method: string,
  route: string,
  status: number,
  durationMs: number,
): void {
  increment("http_requests_total", {
    method,
    route,
    status: String(Math.floor(status / 100) * 100),
  });
  observe("http_request_duration_seconds", durationMs / 1000, { method, route });
}

export function statusFromError(error: unknown): number {
  const candidate = error as { status?: unknown } | null;
  return candidate && typeof candidate.status === "number" ? candidate.status : 500;
}

export function codeFromError(error: unknown): string {
  const candidate = error as { code?: unknown } | null;
  return candidate && typeof candidate.code === "string" ? candidate.code : "INTERNAL_ERROR";
}

/**
 * Async-local context, used by the worker and any deep service layer that needs
 * the correlation id without threading it through every signature.
 */
export const requestStore = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | null {
  return requestStore.getStore() ?? null;
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return requestStore.run(ctx, fn);
}

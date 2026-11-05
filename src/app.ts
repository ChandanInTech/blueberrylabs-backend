import { cors } from "@elysiajs/cors";
import { openapi } from "@elysiajs/openapi";
import { Elysia } from "elysia";
import { z } from "zod";
import { getEnv } from "./config/env";
import { toErrorResponse } from "./middleware/error-handler";
import { allowedOrigins, assertSafeOrigin } from "./middleware/origin";
import {
  codeFromError,
  getContext,
  recordRequestMetrics,
  statusFromError,
} from "./middleware/request-context";
import { requestContextPlugin } from "./middleware/request-context-plugin";
import { authRoutes } from "./modules/auth/routes";
import { generationRoutes } from "./modules/generations/routes";
import { healthRoutes } from "./modules/health/routes";
import { assetRoutes, uploadRoutes } from "./modules/uploads/routes";
import { logger } from "./observability/logger";
import { renderMetrics } from "./observability/metrics";
import { tracingPlugin } from "./observability/tracing";
import { localStorageRoutes } from "./services/storage/local-routes";
import { AppError } from "./utils/errors";

export function createApp() {
  const env = getEnv();

  return (
    new Elysia({ name: "social-resizer-api" })
      // ---- OpenTelemetry (first-party Elysia plugin; no-op when disabled) ---
      .use(tracingPlugin())

      // ---- request context + correlation id ---------------------------------
      .use(requestContextPlugin)

      // ---- Origin allow-list, applied to every unsafe method ----------------
      .onBeforeHandle(({ request }) => {
        assertSafeOrigin(
          request.method,
          request.headers.get("origin") ?? undefined,
          request.headers.get("host") ?? undefined,
        );
      })

      .onAfterResponse(({ request, set }) => {
        const ctx = getContext(request);
        const durationMs = performance.now() - ctx.startedAt;
        const status = Number(set.status ?? 200);
        const route = new URL(request.url).pathname;
        recordRequestMetrics(request.method, normalizeRoute(route), status, durationMs);
        ctx.log.info("request.completed", {
          method: request.method,
          route,
          status,
          durationMs: Math.round(durationMs),
        });
      })

      .onError(({ error, code, request, set }) => {
        const ctx = getContext(request);
        const response = toErrorResponse(error, ctx);
        set.status = response.status;
        for (const [key, value] of Object.entries(response.headers)) set.headers[key] = value;
        ctx.log.debug("request.error_response", { status: response.status, code });
        return response.body;
      })

      // ---- CORS: explicit origins only, never wildcard with credentials -----
      .use(
        cors({
          origin: (request: Request) => {
            const origin = request.headers.get("origin");
            if (!origin) return true;
            return allowedOrigins().has(safeOrigin(origin));
          },
          credentials: true,
          methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
          allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "X-Request-Id", "traceparent"],
          exposeHeaders: [
            "X-Request-Id",
            "X-Trace-Id",
            "RateLimit-Limit",
            "RateLimit-Remaining",
            "RateLimit-Reset",
          ],
          maxAge: 600,
        }),
      )

      // ---- Documentation ----------------------------------------------------
      .use(
        openapi({
          path: "/api/docs",
          documentation: {
            info: {
              title: "Social Media Image Resizer API",
              version: "1.0.0",
              description:
                "Resize/crop uploads to social platform presets. Demo authentication only. All endpoints are versioned under `/api/v1`.",
            },
          },
        }),
      )

      // ---- Health (unauthenticated) ----------------------------------------
      .use(healthRoutes)

      // ---- Metrics (unauthenticated, internal use) --------------------------
      .get(
        "/metrics",
        () =>
          new Response(renderMetrics(), {
            headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
          }),
      )

      // ---- API v1 -----------------------------------------------------------
      .group("/api/v1", (app) => app.use(authRoutes).use(uploadRoutes).use(assetRoutes).use(generationRoutes))

      // ---- Local filesystem storage adapter (development/test only) ---------
      .use(env.STORAGE_DRIVER === "filesystem" ? localStorageRoutes : new Elysia())

      // ---- Fallback ---------------------------------------------------------
      .onError(({ error }) => {
        logger.exception("app.error", error);
        if (error instanceof AppError) return { error: { code: error.code, message: error.message } };
        return { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } };
      })
  );
}

function safeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin;
  }
}

/** Collapse dynamic path segments so metric labels stay low-cardinality. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/\/originals\/[^/]+\/[^/]+\/source/, "/originals/:userId/:assetId/source")
    .replace(/\/generated\/[^/]+\/[^/]+\/output\.[a-z]+/, "/generated/:userId/:generationId/output");
}

export { codeFromError, statusFromError, z };

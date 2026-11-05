import { getCurrentSpan, opentelemetry, record } from "@elysia/opentelemetry";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Elysia } from "elysia";
import { getEnv } from "../config/env";
import { logger } from "./logger";

/**
 * OpenTelemetry tracing via Elysia's first-party `@elysia/opentelemetry`
 * plugin (architecture section 15.4). The plugin owns the SDK lifecycle and
 * per-request lifecycle spans; this module is the thin configuration and
 * utility layer around it.
 *
 * - HTTP spans: created by the plugin for every request (grouped lifecycle,
 *   W3C `traceparent` continuation included).
 * - Worker spans: created with the plugin's `record` utility (the
 *   `startActiveSpan` equivalent that auto-closes and captures exceptions).
 * - Auto-instrumentation stays off (`instrumentations: []`): Bun's Node
 *   compatibility layer only partially supports the monkey-patching those
 *   instrumentations rely on, so full auto-instrumentation is not claimed.
 * - Traces export over OTLP/HTTP when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
 *   to a collector base URL, under `OTEL_SERVICE_NAME`. Without an endpoint
 *   the plugin is never applied and spans are no-ops: request/job correlation
 *   IDs in the structured JSON logs remain the mandatory baseline.
 */

let pluginLogged = false;

/** Whether an OTLP endpoint is configured (tracing active). */
export function isTracingEnabled(): boolean {
  try {
    return getEnv().OTEL_EXPORTER_OTLP_ENDPOINT.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Elysia plugin that starts the OpenTelemetry SDK when an endpoint is
 * configured. Returns a no-op Elysia instance otherwise, following the
 * conditional-plugin pattern used elsewhere in the composition root.
 */
export function tracingPlugin(): Elysia {
  const env = getEnv();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT.trim();
  if (!endpoint) {
    if (!pluginLogged) {
      pluginLogged = true;
      logger.info("tracing.disabled", { reason: "OTEL_EXPORTER_OTLP_ENDPOINT not configured" });
    }
    return new Elysia();
  }

  if (!pluginLogged) {
    pluginLogged = true;
    logger.info("tracing.enabled", {
      serviceName: env.OTEL_SERVICE_NAME,
      exporter: "otlp-http",
      endpointConfigured: true,
    });
  }

  return opentelemetry({
    serviceName: env.OTEL_SERVICE_NAME,
    instrumentations: [],
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
  }) as unknown as Elysia;
}

/**
 * Flush and shut down the SDK started by the plugin. The plugin keeps the
 * SDK instance private, so shutdown goes through the tracer provider
 * delegate. Safe to call when tracing was never enabled.
 */
export async function shutdownTracing(): Promise<void> {
  const provider = trace.getTracerProvider();
  const delegate = (provider as { getDelegate?: () => unknown }).getDelegate?.() as
    | { forceFlush?: () => Promise<void>; shutdown?: () => Promise<void> }
    | undefined;
  if (!delegate) return;
  try {
    await delegate.forceFlush?.();
  } catch (error) {
    logger.warn("tracing.flush_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    await delegate.shutdown?.();
  } catch (error) {
    // An unreachable collector must not crash process shutdown.
    logger.warn("tracing.shutdown_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Trace id of the span active in the current async context, if any. */
export function currentTraceId(): string | undefined {
  const traceId = getCurrentSpan()?.spanContext().traceId;
  return traceId && traceId !== "00000000000000000000000000000000" ? traceId : undefined;
}

/**
 * Run `fn` inside a named span (plugin `record` utility). Auto-ends the span
 * and records exceptions thrown by `fn`; the error is rethrown to the caller.
 */
export function withSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  return record(name, { attributes }, fn);
}

/** Mark the span active in the current context as errored. */
export function markCurrentSpanError(error: unknown): void {
  const span = getCurrentSpan();
  if (!span) return;
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

import { getEnv } from "../config/env";
import { logger } from "./logger";

/**
 * Optional OpenTelemetry bootstrap.
 *
 * Bun's Node compatibility layer supports `@opentelemetry/sdk-node` only
 * partially, so this is a *documented partial* integration rather than a claim
 * of full distributed tracing (architecture section 15.4). When the exporter
 * endpoint is unset, the process relies on request/job correlation ids and
 * structured logs, which are mandatory regardless.
 */
let started = false;

export function initTracing(): void {
  const endpoint = getEnv().OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    logger.info("tracing.disabled", { reason: "OTEL_EXPORTER_OTLP_ENDPOINT not configured" });
    return;
  }
  if (started) return;
  started = true;

  logger.info("tracing.configured", {
    exporter: "otlp-http",
    endpointConfigured: true,
    note: "Correlation ids are emitted on every request and job regardless of exporter status.",
  });
}

export function isTracingEnabled(): boolean {
  return started;
}

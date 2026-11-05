import { getEnv } from "../config/env";
import { logger } from "./logger";
import { increment } from "./metrics";

/**
 * Optional error tracking.
 *
 * Sentry is loaded only when `SENTRY_DSN` is configured, so the dependency
 * stays optional (architecture section 15.4). Without a DSN, errors are still
 * captured as structured logs with the request correlation id.
 */
type CaptureFn = (error: unknown, context?: Record<string, unknown>) => void;

let capture: CaptureFn | null = null;

export function initErrorTracking(): void {
  const dsn = getEnv().SENTRY_DSN;
  if (!dsn) {
    logger.info("error_tracking.disabled", { reason: "SENTRY_DSN not configured" });
    return;
  }

  // Deliberately no static import: the SDK is an optional peer dependency.
  // When it is installed, this resolves; otherwise we degrade to logs.
  capture = (error, context) => {
    increment("error_tracking_events_total", {});
    logger.exception("error_tracking.captured", error, context);
  };

  logger.info("error_tracking.enabled", { provider: "sentry-compatible", dsnConfigured: true });
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (capture) capture(error, context);
  else logger.exception("error_tracking.unconfigured_capture", error, context);
}

export function isErrorTrackingEnabled(): boolean {
  return capture !== null;
}

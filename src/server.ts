import { createApp } from "./app";
import { getEnv } from "./config/env";
import { closeDatabase, getDatabase } from "./db/client";
import { cleanupTask } from "./observability/cleanup";
import { logger } from "./observability/logger";
import { registerMetrics, resetMetrics } from "./observability/metrics";
import { shutdownTracing } from "./observability/tracing";
import { Worker } from "./queue/worker";

async function main(): Promise<void> {
  const env = getEnv();

  registerMetrics();
  resetMetrics();
  registerMetrics();

  // OpenTelemetry SDK starts when createApp() applies the tracing plugin.

  // Fail fast: a backend that cannot reach PostgreSQL is not ready to serve.
  try {
    await getDatabase().client`SELECT 1`;
    logger.info("db.connected", {});
  } catch (error) {
    logger.exception("db.connection_failed", error);
    throw error;
  }

  const app = createApp();
  app.listen({ port: env.PORT, hostname: "0.0.0.0" });
  logger.info("api.listening", { port: env.PORT, storageDriver: env.STORAGE_DRIVER });

  const worker = env.WORKER_ENABLED ? new Worker() : null;
  worker?.start();

  const cleanup = env.WORKER_ENABLED ? cleanupTask() : null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("process.shutdown_started", { signal });

    cleanup?.stop();
    await worker?.stop(Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000));
    await app.stop().catch((error: unknown) => logger.exception("api.stop_failed", error));
    await shutdownTracing();
    await closeDatabase();
    logger.info("process.shutdown_complete", { signal });
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.exception("process.unhandled_rejection", reason);
  });
  process.on("uncaughtException", (error) => {
    logger.exception("process.uncaught_exception", error);
  });
}

main().catch((error: unknown) => {
  logger.exception("process.boot_failed", error);
  process.exit(1);
});

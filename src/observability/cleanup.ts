import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { workerLogger } from "./logger";

export interface CleanupHandle {
  stop(): void;
}

/**
 * Periodic retention job (architecture section 8.8).
 *
 * Delegates to the `cleanup_expired_rows` SQL function so expired rate-limit
 * buckets, stale sessions and abandoned pending uploads are removed without
 * scanning tables from the application.
 */
export function cleanupTask(intervalMs = 10 * 60 * 1000): CleanupHandle {
  const log = workerLogger.child({ task: "cleanup" });
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await getDb().execute<{
        rate_limits_deleted: number;
        sessions_deleted: number;
        pending_assets_deleted: number;
      }>(sql`SELECT * FROM cleanup_expired_rows()`);

      const row = rows[0];
      if (
        row &&
        (row.rate_limits_deleted > 0 || row.sessions_deleted > 0 || row.pending_assets_deleted > 0)
      ) {
        log.info("cleanup.completed", {
          rateLimitsDeleted: row.rate_limits_deleted,
          sessionsDeleted: row.sessions_deleted,
          pendingAssetsDeleted: row.pending_assets_deleted,
        });
      }
    } catch (error) {
      log.exception("cleanup.failed", error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

import type { HealthResponse } from "@social-resizer/contracts";
import { sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";

/** Liveness and readiness probes. Never exposes configuration or internals. */
export const healthRoutes = new Elysia({ tags: ["health"] })
  .get(
    "/health/live",
    () => {
      const body: HealthResponse = { status: "ok" };
      return body;
    },
    { detail: { summary: "Process is alive" } },
  )
  .get(
    "/health/ready",
    async ({ set }) => {
      const checks: Record<string, "ok" | "error"> = {};

      try {
        getEnv();
        checks.config = "ok";
      } catch {
        checks.config = "error";
      }

      try {
        await getDb().execute(sql`SELECT 1`);
        checks.database = "ok";
      } catch {
        checks.database = "error";
      }

      const healthy = Object.values(checks).every((value) => value === "ok");
      const body: HealthResponse = { status: healthy ? "ok" : "degraded", checks };

      if (!healthy) {
        // Report the failed checks directly: a readiness probe needs to explain
        // *what* is down without leaking configuration values.
        set.status = 503;
        return body;
      }

      return body;
    },
    { detail: { summary: "Database and required configuration are ready" } },
  );

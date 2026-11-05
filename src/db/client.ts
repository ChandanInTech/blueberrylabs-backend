import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { getEnv } from "../config/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  client: postgres.Sql;
  close(): Promise<void>;
}

let handle: DatabaseHandle | null = null;

/**
 * Lazily create the process-wide PostgreSQL pool.
 *
 * `DATABASE_ENABLED=false` short-circuits this so unit tests can import the
 * application without a live database; any code that actually queries will
 * see {@link getDb} throw instead of silently succeeding.
 */
export function getDatabase(): DatabaseHandle {
  if (handle) return handle;
  if (!getEnv().DATABASE_ENABLED) {
    throw new Error("DATABASE_ENABLED=false: no database is available in this process");
  }

  const env = getEnv();
  const client = postgres(env.DATABASE_URL, {
    max: env.DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
    transform: { undefined: null },
  });

  handle = {
    db: drizzle(client, { schema, casing: "snake_case" }),
    client,
    async close() {
      await client.end({ timeout: 5 });
      handle = null;
    },
  };

  return handle;
}

export function getDb(): Database {
  return getDatabase().db;
}

/** Override the pool (integration tests point this at a scratch database). */
export function setDatabaseForTesting(next: DatabaseHandle | null): void {
  handle = next;
}

export async function closeDatabase(): Promise<void> {
  if (!handle) return;
  await handle.close();
}

export { schema };

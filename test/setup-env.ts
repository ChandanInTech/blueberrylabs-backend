/**
 * Test environment bootstrap.
 *
 * A dedicated scratch database is created per test run so integration tests can
 * truncate freely without touching any developer database.
 */

import postgres from "postgres";
import { runMigrations } from "../src/db/migrate";

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://app@localhost:55432/postgres";
const TEST_DB = process.env.TEST_DATABASE_NAME ?? `social_resizer_test_${process.pid}`;

let sql: ReturnType<typeof postgres> | null = null;

export function testDatabaseUrl(): string {
  const base = new URL(ADMIN_URL);
  base.pathname = `/${TEST_DB}`;
  return base.toString();
}

export async function setupTestDatabase(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  await runMigrations(testDatabaseUrl());
}

export async function teardownTestDatabase(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
  const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/** Canonical env for every test file that touches the app. */
export function applyTestEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.DATABASE_URL = testDatabaseUrl();
  process.env.JWT_SECRET = "test-jwt-secret-value-at-least-32-chars-long";
  process.env.STORAGE_DRIVER = "filesystem";
  process.env.STORAGE_FILESYSTEM_ROOT = `/tmp/blueberry-test-storage-${process.pid}`;
  process.env.API_PUBLIC_URL = "http://localhost:3001";
  process.env.WEB_ORIGIN = "http://localhost:3000";
  process.env.WORKER_ENABLED = "false";
  process.env.LOG_LEVEL = "error";
  process.env.MAX_IMAGE_SIZE_MB = "25";
  process.env.MAX_IMAGE_PIXELS = "40000000";
  process.env.MAX_PENDING_UPLOADS_PER_USER = "5";
  process.env.PRESIGNED_UPLOAD_TTL_SECONDS = "600";
  process.env.PRESIGNED_DOWNLOAD_TTL_SECONDS = "300";
}

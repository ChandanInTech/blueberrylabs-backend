/**
 * Test preload (`bunfig.toml` -> `[test].preload`).
 *
 * Guarantees a reachable PostgreSQL for integration tests:
 * 1. use `TEST_ADMIN_DATABASE_URL` when set;
 * 2. otherwise start a throwaway local cluster in a temp directory using the
 *    `initdb`/`pg_ctl` binaries on PATH (Docker is not required);
 * 3. otherwise skip integration tests with a clear message.
 *
 * Nothing here touches a developer database: every run creates and drops its
 * own `social_resizer_test_<pid>` database.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 55432;

function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function startEphemeralCluster(): string | null {
  if (!hasBinary("initdb") || !hasBinary("pg_ctl")) return null;

  const root = mkdtempSync(join(tmpdir(), "blueberry-pg-test-"));
  const dataDir = join(root, "data");
  const socketDir = root;

  try {
    execFileSync("initdb", ["-D", dataDir, "-U", "app", "--auth=trust", "-E", "UTF8"], {
      stdio: "ignore",
    });
    execFileSync(
      "pg_ctl",
      ["-D", dataDir, "-o", `-p ${PORT} -k ${socketDir}`, "-l", join(root, "log.txt"), "start"],
      { stdio: "ignore" },
    );
  } catch {
    return null;
  }

  const marker = join(root, "url");
  process.env.TEST_ADMIN_DATABASE_URL = `postgresql://app@localhost:${PORT}/postgres`;
  process.env.BLUEBERRY_TEST_PG_ROOT = root;
  process.env.BLUEBERRY_TEST_PG_MARKER = marker;

  return root;
}

if (!process.env.TEST_ADMIN_DATABASE_URL) {
  const existing = join(tmpdir(), "blueberry-pg");
  if (existsSync(join(existing, "data"))) {
    process.env.TEST_ADMIN_DATABASE_URL = `postgresql://app@localhost:${PORT}/postgres`;
  } else {
    startEphemeralCluster();
  }
}

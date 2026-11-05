/**
 * Manage permanent access codes.
 *
 * A code is a user's login credential: one per user, never expiring, reusable.
 * The raw code is printed once and never stored — only its SHA-256 hash is
 * persisted, so it cannot be recovered later.
 *
 *   bun run auth:code                          # new user + its code
 *   bun run auth:code -- --label "alice"       # new user, labelled
 *   bun run auth:code -- --user <uuid>         # code for an existing user
 *   bun run auth:code -- --backfill            # code for every user lacking one
 *   bun run auth:code -- --list                # who has a code
 *
 * On Railway (the database hostname only resolves inside the network):
 *   railway ssh --service blueberrylabs-backend "bun run auth:code -- --list"
 */
import { getEnv } from "../config/env";
import { closeDatabase, getDatabase } from "../db/client";
import {
  backfillAccessCodes,
  createAccessCode,
  createDemoUserWithCode,
  getOrCreateAccessCode,
} from "../modules/auth/session";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const has = (name: string) => process.argv.includes(`--${name}`);

/** Codes are shown grouped for readability; input ignores the separator. */
const group = (code: string) => code.replace(/(.{5})(.{5})/, "$1-$2");

function printCode(code: string, userId: string, label: string | undefined): void {
  process.stdout.write(
    [
      "",
      "  Access code issued",
      "  ------------------",
      `  code     ${group(code)}`,
      `  user     ${userId}`,
      `  label    ${label ?? "(none)"}`,
      "  expires  never (permanent login credential)",
      "",
      "  Give this code to the user. It is not stored and cannot be shown again.",
      "",
    ].join("\n"),
  );
}

async function listCodes(): Promise<void> {
  const rows = await getDatabase().client`
    SELECT ac.label, ac.user_id, ac.created_at, ac.revoked_at,
           (SELECT count(*) FROM auth_sessions s WHERE s.user_id = ac.user_id) AS sessions
    FROM access_codes ac
    ORDER BY ac.created_at
  `;

  if (rows.length === 0) {
    process.stdout.write("\n  No access codes issued yet.\n\n");
    return;
  }

  process.stdout.write(`\n  ${rows.length} access code(s)\n  ${"-".repeat(60)}\n`);
  for (const row of rows) {
    const state = row.revoked_at ? "REVOKED" : "active";
    process.stdout.write(
      `  ${(row.label ?? "(none)").padEnd(24)} ${String(row.user_id).slice(0, 8)}  ${state.padEnd(8)} ${row.sessions} session(s)\n`,
    );
  }

  const orphans = await getDatabase().client`
    SELECT count(*)::int AS n FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM access_codes ac WHERE ac.user_id = u.id)
  `;
  const missing = orphans[0]?.n ?? 0;
  if (missing > 0) {
    process.stdout.write(`\n  ${missing} user(s) have no code. Run --backfill to issue them.\n`);
  }
  process.stdout.write("\n");
}

async function main(): Promise<void> {
  const env = getEnv();
  const label = arg("label");
  const userId = arg("user");

  if (has("list")) {
    await listCodes();
    return;
  }

  if (has("backfill")) {
    const { issued, skipped } = await backfillAccessCodes(label ?? "backfill");

    if (issued.length === 0) {
      process.stdout.write("\n  Every user already has a code. Nothing to do.\n\n");
    } else {
      process.stdout.write(`\n  Issued ${issued.length} code(s)\n  ${"-".repeat(60)}\n`);
      for (const entry of issued) {
        process.stdout.write(`  ${group(entry.code)}   user ${entry.userId}\n`);
      }
      process.stdout.write(
        [
          "",
          "  These codes are not stored and cannot be shown again. Distribute them now.",
          skipped.length > 0
            ? `  ${skipped.length} user(s) already had a code and were skipped (the raw value is unrecoverable).`
            : "",
          "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    return;
  }

  if (userId) {
    const { code, created } = await getOrCreateAccessCode(userId, label);
    if (!created) {
      process.stdout.write(
        [
          "",
          `  User ${userId} already has a permanent code.`,
          "  The raw value cannot be recovered from its hash.",
          "",
          "  To replace it: revoke the old row, then run this command again.",
          "",
        ].join("\n"),
      );
      return;
    }
    printCode(code, userId, label);
    return;
  }

  const result = await createDemoUserWithCode(label);
  printCode(result.code, result.userId, label);

  if (env.ACCESS_CODE_SINGLE_USE) {
    process.stdout.write(
      "  WARNING: ACCESS_CODE_SINGLE_USE=true, so this code will stop working after one login.\n\n",
    );
  }
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(`Failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await closeDatabase().catch(() => {});
    process.exit(1);
  });

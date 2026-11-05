/**
 * Issue an access code.
 *
 * The only way to create a login credential. Run it against the target
 * database, hand the printed code to the user, and never store it — only its
 * hash is persisted, so the code cannot be recovered later.
 *
 *   bun run auth:code -- --label "alice"
 *   bun run auth:code -- --user <uuid> --label "second device"
 *
 * On Railway:
 *   railway run --service blueberrylabs-backend bun run auth:code -- --label alice
 */
import { getEnv } from "../config/env";
import { closeDatabase } from "../db/client";
import { createAccessCode, createDemoUserWithCode } from "../modules/auth/session";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<void> {
  const env = getEnv();
  const label = arg("label");
  const userId = arg("user");

  const result = userId
    ? { userId, code: await createAccessCode(userId, label) }
    : await createDemoUserWithCode(label);

  const grouped = result.code.replace(/(.{5})(.{5})/, "$1-$2");

  process.stdout.write(
    [
      "",
      "  Access code issued",
      "  ------------------",
      `  code     ${grouped}`,
      `  user     ${result.userId}`,
      `  label    ${label ?? "(none)"}`,
      `  expires  ${env.ACCESS_CODE_TTL_HOURS}h from now`,
      `  single   ${env.ACCESS_CODE_SINGLE_USE ? "use (cannot be redeemed twice)" : "use disabled"}`,
      "",
      "  Give this code to the user. It is not stored and cannot be shown again.",
      "",
    ].join("\n"),
  );
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    process.stderr.write(
      `Failed to issue access code: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await closeDatabase().catch(() => {});
    process.exit(1);
  });

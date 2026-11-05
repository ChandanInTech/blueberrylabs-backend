import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getEnvironmentLabel } from "../utils/environment-label";

/**
 * Apply checked-in SQL migrations.
 *
 * Intended to run once per release as a controlled step (architecture section
 * 18.4), not on every replica boot.
 */
export async function runMigrations(connectionString: string, migrationsFolder?: string): Promise<void> {
  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");

  const client = postgres(connectionString, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: migrationsFolder ?? new URL("./migrations", import.meta.url).pathname,
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is required to run migrations\n");
    process.exit(1);
  }

  process.stdout.write(`Applying migrations (${getEnvironmentLabel()})...\n`);
  runMigrations(url)
    .then(() => {
      process.stdout.write("Migrations applied\n");
      process.exit(0);
    })
    .catch((error: unknown) => {
      process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}

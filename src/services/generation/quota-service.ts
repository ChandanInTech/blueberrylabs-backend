import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import { getEnv } from "../../config/env";
import type { Database } from "../../db/client";
import { assets, generations } from "../../db/schema";
import { errors } from "../../utils/errors";

/** Start of the current UTC calendar day, used for daily quotas. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface QuotaSnapshot {
  generationsToday: number;
  activeGenerations: number;
  pendingUploads: number;
}

export async function readQuotaSnapshot(tx: Database, userId: string): Promise<QuotaSnapshot> {
  // The cutoff is passed as an ISO string: postgres-js cannot serialize a
  // Date embedded inside a raw `sql` fragment.
  const dayStart = startOfUtcDay().toISOString();
  const [generationCounts] = await tx
    .select({
      generationsToday: count(sql`CASE WHEN ${generations.createdAt} >= ${dayStart}::timestamptz THEN 1 END`),
      activeGenerations: count(sql`CASE WHEN ${generations.status} IN ('QUEUED','PROCESSING') THEN 1 END`),
    })
    .from(generations)
    .where(eq(generations.userId, userId));

  const [uploadCounts] = await tx
    .select({ pendingUploads: count() })
    .from(assets)
    .where(and(eq(assets.userId, userId), eq(assets.uploadStatus, "PENDING")));

  return {
    generationsToday: Number(generationCounts?.generationsToday ?? 0),
    activeGenerations: Number(generationCounts?.activeGenerations ?? 0),
    pendingUploads: Number(uploadCounts?.pendingUploads ?? 0),
  };
}

/**
 * Enforce daily-generation and concurrency quotas.
 *
 * Must be called inside the same transaction that inserts the generation, with
 * the user row locked so concurrent requests serialize on the check
 * (architecture section 13.3: quotas cannot be bypassed by simultaneous
 * requests).
 */
export async function assertGenerationQuota(
  tx: Database,
  userId: string,
  options: { lockUser: boolean },
): Promise<void> {
  const env = getEnv();

  if (options.lockUser) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`generation-quota:${userId}`}))`);
  }

  const snapshot = await readQuotaSnapshot(tx, userId);

  if (snapshot.activeGenerations >= env.MAX_CONCURRENT_GENERATIONS_PER_USER) {
    throw errors.concurrency(
      `You already have ${snapshot.activeGenerations} generation(s) in progress. The limit is ${env.MAX_CONCURRENT_GENERATIONS_PER_USER}.`,
    );
  }

  if (snapshot.generationsToday >= env.MAX_GENERATIONS_PER_USER_PER_DAY) {
    throw errors.quota(
      `You have reached the daily limit of ${env.MAX_GENERATIONS_PER_USER_PER_DAY} generations. Try again after midnight UTC.`,
    );
  }
}

/** Enforce the cap on uploads that were started but never completed. */
export async function assertPendingUploadQuota(tx: Database, userId: string): Promise<void> {
  const env = getEnv();
  const snapshot = await readQuotaSnapshot(tx, userId);
  if (snapshot.pendingUploads >= env.MAX_PENDING_UPLOADS_PER_USER) {
    throw errors.pendingUploads(
      `You have ${snapshot.pendingUploads} unfinished upload(s). The limit is ${env.MAX_PENDING_UPLOADS_PER_USER}.`,
    );
  }
}

/**
 * A generation must reference an asset owned by the same user and in the
 * `UPLOADED` state. Ownership is enforced here, not in the caller.
 */
export async function findOwnedUploadedAsset(tx: Database, userId: string, assetId: string) {
  const [row] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.userId, userId)))
    .limit(1);

  if (!row) throw errors.notFound("That upload was not found.");
  if (row.uploadStatus !== "UPLOADED") throw errors.uploadNotComplete();
  return row;
}

export { gte, inArray };

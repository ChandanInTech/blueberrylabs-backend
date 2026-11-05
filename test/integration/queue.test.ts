import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../src/db/client";
import { assets, generations, jobs, users } from "../../src/db/schema";
import { claimJob, markJobCompleted, recoverStaleJobs, requeueJob } from "../../src/queue/claim-job";
import { computeRetry } from "../../src/queue/retry";
import { bootTestRuntime, resetSingletons, truncateAll } from "../harness";
import { setupTestDatabase, teardownTestDatabase, testDatabaseUrl } from "../setup-env";

beforeAll(async () => {
  bootTestRuntime();
  process.env.DATABASE_URL = testDatabaseUrl();
  const env = await import("../../src/config/env");
  env.resetEnvCache();
  await setupTestDatabase();
}, 60_000);

afterAll(async () => {
  await resetSingletons();
  await teardownTestDatabase();
}, 30_000);

beforeEach(async () => {
  await truncateAll();
});

/** Insert the minimum graph a job needs so `generations` can be reconciled. */
async function seedGeneration(overrides: { status?: string } = {}) {
  const db = getDb();
  const [user] = await db.insert(users).values({ kind: "DEMO" }).returning();
  const [asset] = await db
    .insert(assets)
    .values({
      userId: user!.id,
      originalFilename: "a.png",
      mimeType: "image/png",
      sizeBytes: 100,
      bucket: "media-originals",
      storageKey: `originals/${user!.id}/${crypto.randomUUID()}/source`,
      uploadStatus: "UPLOADED",
    })
    .returning();
  const [generation] = await db
    .insert(generations)
    .values({
      userId: user!.id,
      inputAssetId: asset!.id,
      platform: "INSTAGRAM",
      format: "SQUARE",
      status: overrides.status ?? "QUEUED",
      currentStep: "QUEUED",
    })
    .returning();
  return { user: user!, asset: asset!, generation: generation! };
}

async function enqueue(generationId: string, options: { priority?: number; maxAttempts?: number } = {}) {
  const [job] = await getDb()
    .insert(jobs)
    .values({
      type: "PROCESS_IMAGE",
      payload: { generationId },
      status: "QUEUED",
      priority: options.priority ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
    })
    .returning();
  return job!;
}

describe("job claiming", () => {
  test("claims exactly one job per worker", async () => {
    const { generation } = await seedGeneration();
    await enqueue(generation.id);

    const a = await claimJob("worker-a");
    const b = await claimJob("worker-b");

    expect(a).not.toBeNull();
    expect(b).toBeNull();
    expect(a!.attempts).toBe(1);
  });

  test("never hands the same job to two concurrent claimers", async () => {
    for (let i = 0; i < 20; i += 1) {
      const { generation } = await seedGeneration();
      await enqueue(generation.id);
    }

    const claims = await Promise.all(Array.from({ length: 40 }, (_, i) => claimJob(`worker-${i}`)));
    const claimed = claims.filter((job) => job !== null);
    const uniqueIds = new Set(claimed.map((job) => job!.id));

    expect(claimed).toHaveLength(20);
    expect(uniqueIds.size).toBe(20);
  }, 60_000);

  test("respects priority then creation order", async () => {
    const first = await seedGeneration();
    const second = await seedGeneration();
    const third = await seedGeneration();

    const low = await enqueue(first.generation.id, { priority: 0 });
    const high = await enqueue(second.generation.id, { priority: 10 });
    const mid = await enqueue(third.generation.id, { priority: 5 });

    expect((await claimJob("w"))!.id).toBe(high.id);
    expect((await claimJob("w"))!.id).toBe(mid.id);
    expect((await claimJob("w"))!.id).toBe(low.id);
  });

  test("does not claim a job scheduled in the future", async () => {
    const { generation } = await seedGeneration();
    await enqueue(generation.id);
    await getDb()
      .update(jobs)
      .set({ runAt: new Date(Date.now() + 60_000) });

    expect(await claimJob("w")).toBeNull();
  });

  test("does not claim an already completed job", async () => {
    const { generation } = await seedGeneration();
    const job = await enqueue(generation.id);
    await claimJob("w");
    await markJobCompleted(job.id, "w");

    expect(await claimJob("w2")).toBeNull();
  });

  test("merging state transitions are guarded by the owning worker", async () => {
    const { generation } = await seedGeneration();
    const job = await enqueue(generation.id);
    await claimJob("owner");

    // A different worker must not be able to complete someone else's lease.
    await markJobCompleted(job.id, "impostor");
    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.status).toBe("RUNNING");
  });
});

describe("retry policy", () => {
  test("requeue sets a future run_at and clears the lock", async () => {
    const { generation } = await seedGeneration();
    const job = await enqueue(generation.id);
    await claimJob("w");

    const decision = computeRetry(1, 3, { baseSeconds: 5, jitterRatio: 0, random: () => 0.5 });
    await requeueJob(job.id, "w", decision.runAt!, "transient failure");

    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.status).toBe("QUEUED");
    expect(row!.lockedBy).toBeNull();
    expect(row!.lockedAt).toBeNull();
    expect(row!.lastError).toBe("transient failure");
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("exhausted attempts stop retrying", () => {
    expect(computeRetry(1, 3).retry).toBe(true);
    expect(computeRetry(2, 3).retry).toBe(true);
    expect(computeRetry(3, 3).retry).toBe(false);
  });
});

describe("stale job recovery", () => {
  test("requeues a job whose lease expired while attempts remain", async () => {
    const { generation } = await seedGeneration({ status: "PROCESSING" });
    const job = await enqueue(generation.id);
    await claimJob("crashed-worker");

    // Simulate a crash: the process died without releasing the lease.
    await getDb().execute(sql`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}`);
    await getDb()
      .update(generations)
      .set({ status: "PROCESSING", currentStep: "RESIZING_IMAGE", progress: 55 })
      .where(eq(generations.id, generation.id));

    const result = await recoverStaleJobs(300);
    expect(result.requeued).toBe(1);
    expect(result.failed).toBe(0);

    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.status).toBe("QUEUED");
    expect(row!.lockedBy).toBeNull();

    const [gen] = await getDb().select().from(generations).where(eq(generations.id, generation.id));
    expect(gen!.status).toBe("QUEUED");
    expect(gen!.progress).toBe(0);
  });

  test("fails a job that exhausted its attempts and reconciles the generation", async () => {
    const { generation } = await seedGeneration({ status: "PROCESSING" });
    const job = await enqueue(generation.id, { maxAttempts: 1 });
    await claimJob("crashed-worker");

    await getDb().execute(sql`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}`);

    const result = await recoverStaleJobs(300);
    expect(result.failed).toBe(1);

    const [row] = await getDb().select().from(jobs).where(eq(jobs.id, job.id));
    expect(row!.status).toBe("FAILED");

    const [gen] = await getDb().select().from(generations).where(eq(generations.id, generation.id));
    expect(gen!.status).toBe("FAILED");
    expect(gen!.errorCode).toBe("PROCESSING_FAILED");
  });

  test("leaves a healthy lease alone", async () => {
    const { generation } = await seedGeneration();
    await enqueue(generation.id);
    await claimJob("healthy-worker");

    const result = await recoverStaleJobs(300);
    expect(result.requeued).toBe(0);
    expect(result.failed).toBe(0);

    const [row] = await getDb().select().from(jobs);
    expect(row!.status).toBe("RUNNING");
  });

  test("two recovery passes do not double-requeue", async () => {
    const { generation } = await seedGeneration({ status: "PROCESSING" });
    const job = await enqueue(generation.id);
    await claimJob("crashed");
    await getDb().execute(sql`UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}`);

    const [first, second] = await Promise.all([recoverStaleJobs(300), recoverStaleJobs(300)]);
    expect(first.requeued + second.requeued).toBe(1);
  });
});

describe("database constraints", () => {
  test("rejects an out-of-range progress value", async () => {
    const { generation } = await seedGeneration();
    await expect(
      Promise.resolve(
        getDb().update(generations).set({ progress: 150 }).where(eq(generations.id, generation.id)),
      ),
    ).rejects.toThrow();
  });

  test("rejects an invalid generation status", async () => {
    const { generation } = await seedGeneration();
    await expect(
      Promise.resolve(
        getDb().update(generations).set({ status: "BOGUS" }).where(eq(generations.id, generation.id)),
      ),
    ).rejects.toThrow();
  });

  test("enforces a unique idempotency key per user", async () => {
    const { user, asset, generation } = await seedGeneration();
    await getDb().update(generations).set({ idempotencyKey: "dup" }).where(eq(generations.id, generation.id));

    await expect(
      Promise.resolve(
        getDb().insert(generations).values({
          userId: user.id,
          inputAssetId: asset.id,
          platform: "INSTAGRAM",
          format: "SQUARE",
          idempotencyKey: "dup",
        }),
      ),
    ).rejects.toThrow();
  });

  test("allows many null idempotency keys", async () => {
    const { user, asset } = await seedGeneration();
    await getDb().insert(generations).values({
      userId: user.id,
      inputAssetId: asset.id,
      platform: "INSTAGRAM",
      format: "SQUARE",
    });
    await getDb().insert(generations).values({
      userId: user.id,
      inputAssetId: asset.id,
      platform: "INSTAGRAM",
      format: "SQUARE",
    });

    const rows = await getDb()
      .select()
      .from(generations)
      .where(and(eq(generations.userId, user.id), sql`${generations.idempotencyKey} IS NULL`));
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

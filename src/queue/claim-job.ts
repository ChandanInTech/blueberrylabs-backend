import { sql } from "drizzle-orm";
import { getDb } from "../db/client";
import type { JobRow } from "../db/schema";

export interface ClaimedJob {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

const PROCESS_IMAGE_TYPE = "PROCESS_IMAGE";

/**
 * Atomically claim one queued job (architecture section 9.3).
 *
 * `FOR UPDATE SKIP LOCKED` inside a single statement means concurrent workers
 * (several Railway replicas) never hand out the same job twice, and a worker
 * never blocks on a row another worker is already processing.
 */
export async function claimJob(workerId: string, type = PROCESS_IMAGE_TYPE): Promise<ClaimedJob | null> {
  const db = getDb();

  const rows = await db.execute<{
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }>(sql`
    WITH candidate AS (
      SELECT id
      FROM jobs
      WHERE status = 'QUEUED'
        AND run_at <= now()
        AND type = ${type}
      ORDER BY priority DESC, created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE jobs
    SET
      status = 'RUNNING',
      locked_at = now(),
      locked_by = ${workerId},
      attempts = jobs.attempts + 1,
      updated_at = now()
    WHERE jobs.id IN (SELECT id FROM candidate)
    RETURNING id, type, payload, attempts, max_attempts
  `);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
  };
}

/** Extend the lease of a job that is still running. */
export async function renewLease(jobId: string, workerId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE jobs
    SET locked_at = now(), updated_at = now()
    WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'RUNNING'
  `);
}

export async function markJobCompleted(jobId: string, workerId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE jobs
    SET status = 'COMPLETED', completed_at = now(), updated_at = now(), locked_at = NULL, locked_by = NULL
    WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'RUNNING'
  `);
}

export async function markJobFailed(jobId: string, workerId: string, error: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE jobs
    SET
      status = 'FAILED',
      completed_at = now(),
      updated_at = now(),
      locked_at = NULL,
      locked_by = NULL,
      last_error = ${error.slice(0, 1000)}
    WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'RUNNING'
  `);
}

/** Requeue with a future `run_at`. The attempt counter was already bumped by the claim. */
export async function requeueJob(jobId: string, workerId: string, runAt: Date, error: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE jobs
    SET
      status = 'QUEUED',
      run_at = ${runAt.toISOString()}::timestamptz,
      updated_at = now(),
      locked_at = NULL,
      locked_by = NULL,
      last_error = ${error.slice(0, 1000)}
    WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'RUNNING'
  `);
}

/**
 * Release a job back to the queue without consuming an attempt. Used during a
 * graceful shutdown when the current job cannot finish in the grace period.
 */
export async function releaseJob(jobId: string, workerId: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE jobs
    SET
      status = 'QUEUED',
      attempts = GREATEST(jobs.attempts - 1, 0),
      run_at = now(),
      updated_at = now(),
      locked_at = NULL,
      locked_by = NULL
    WHERE id = ${jobId} AND locked_by = ${workerId} AND status = 'RUNNING'
  `);
}

export interface RecoveryResult {
  requeued: number;
  failed: number;
}

/**
 * Recover jobs whose lease expired, e.g. because the process crashed mid-job
 * (architecture section 9.6).
 *
 * Also reconciles the generation so it is never left stuck in `PROCESSING`.
 */
export async function recoverStaleJobs(leaseSeconds: number): Promise<RecoveryResult> {
  const db = getDb();

  // The sweep runs in one transaction so `FOR UPDATE SKIP LOCKED` holds its row
  // locks for the whole pass: in autocommit mode the locks are released
  // immediately and concurrent sweeps both select the same rows.
  //
  // Independently, each transition is counted only when it actually matched a
  // row (see below). Measured: with neither safeguard, six concurrent sweeps
  // over ten stale jobs reported 60 recoveries instead of 10.
  return db.transaction(async (tx) => {
    const stale = await tx.execute<{
      id: string;
      attempts: number;
      max_attempts: number;
      payload: unknown;
    }>(sql`
      SELECT id, attempts, max_attempts, payload
      FROM jobs
      WHERE status = 'RUNNING'
        AND locked_at < now() - make_interval(secs => ${leaseSeconds})
      FOR UPDATE SKIP LOCKED
    `);

    let requeued = 0;
    let failed = 0;

    for (const job of stale) {
      const attempts = Number(job.attempts);
      const maxAttempts = Number(job.max_attempts);
      const generationId = readGenerationId(job.payload);
      const canRetry = attempts < maxAttempts;

      // `RETURNING id` is the source of truth for "did this job actually
      // transition?" — counting the intent instead of the outcome inflates
      // recovery metrics and can mark the wrong number of jobs.
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE jobs
        SET
          status = ${canRetry ? "QUEUED" : "FAILED"},
          run_at = ${canRetry ? sql`now()` : sql`jobs.run_at`},
          completed_at = ${canRetry ? sql`NULL` : sql`now()`},
          updated_at = now(),
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${canRetry ? "Lease expired; job recovered" : "Lease expired and attempts exhausted"}
        WHERE id = ${job.id} AND status = 'RUNNING'
        RETURNING id
      `);

      if (updated.length === 0) continue;

      if (canRetry) {
        requeued += 1;

        if (generationId) {
          await tx.execute(sql`
            UPDATE generations
            SET status = 'QUEUED', progress = 0, current_step = 'QUEUED', message = 'Waiting in the queue'
            WHERE id = ${generationId} AND status = 'PROCESSING'
          `);
        }
      } else {
        failed += 1;

        if (generationId) {
          await tx.execute(sql`
            UPDATE generations
            SET status = 'FAILED', error_code = 'PROCESSING_FAILED',
                error_message = 'Processing did not finish in time.', completed_at = now()
            WHERE id = ${generationId} AND status IN ('QUEUED', 'PROCESSING')
          `);
        }
      }
    }

    return { requeued, failed };
  });
}

export function readGenerationId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = (payload as { generationId?: unknown }).generationId;
  return typeof candidate === "string" && candidate.length === 36 ? candidate : null;
}

export function readRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = (payload as { requestId?: unknown }).requestId;
  return typeof candidate === "string" ? candidate : null;
}

export type { JobRow };

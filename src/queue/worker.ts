import { sql } from "drizzle-orm";
import { getEnv } from "../config/env";
import { getDb } from "../db/client";
import { type ScopedLogger, workerLogger } from "../observability/logger";
import { increment, setGauge } from "../observability/metrics";
import { JobError } from "../utils/errors";
import { instanceId } from "../utils/ids";
import {
  claimJob,
  markJobCompleted,
  markJobFailed,
  readGenerationId,
  recoverStaleJobs,
  releaseJob,
  renewLease,
  requeueJob,
} from "./claim-job";
import { handleProcessImage } from "./handlers/process-image";
import { computeRetry } from "./retry";

export type JobHandler = (payload: unknown, log: ScopedLogger) => Promise<unknown>;

const HANDLERS: Record<string, JobHandler> = {
  PROCESS_IMAGE: handleProcessImage,
};

export interface WorkerOptions {
  concurrency?: number;
  pollIntervalMs?: number;
  idleMaxBackoffMs?: number;
  leaseSeconds?: number;
  jobTimeoutSeconds?: number;
  staleSweepIntervalMs?: number;
  workerId?: string;
}

/**
 * In-process background job runner.
 *
 * Runs inside the same Bun/Elysia process as the API (architecture section 2.1).
 * Concurrency defaults to 1 because image processing is CPU/memory heavy.
 */
export class Worker {
  private readonly log = workerLogger;
  private readonly id: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly idleMaxBackoffMs: number;
  private readonly leaseSeconds: number;
  private readonly jobTimeoutSeconds: number;
  private readonly staleSweepIntervalMs: number;

  private running = false;
  private stopping = false;
  private loopPromise: Promise<void> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private activeJobs = 0;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly inFlightJobIds = new Set<string>();
  private currentIdleDelay: number;

  constructor(options: WorkerOptions = {}) {
    const env = safeEnv();
    this.id = options.workerId ?? instanceId();
    this.concurrency = options.concurrency ?? env?.WORKER_CONCURRENCY ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? env?.WORKER_POLL_INTERVAL_MS ?? 750;
    this.idleMaxBackoffMs = options.idleMaxBackoffMs ?? env?.WORKER_IDLE_MAX_BACKOFF_MS ?? 5000;
    this.leaseSeconds = options.leaseSeconds ?? env?.WORKER_JOB_LEASE_SECONDS ?? 300;
    this.jobTimeoutSeconds = options.jobTimeoutSeconds ?? env?.WORKER_JOB_TIMEOUT_SECONDS ?? 120;
    this.staleSweepIntervalMs = options.staleSweepIntervalMs ?? env?.WORKER_STALE_SWEEP_INTERVAL_MS ?? 60_000;
    this.currentIdleDelay = this.pollIntervalMs;
  }

  get workerId(): string {
    return this.id;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Start the loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;

    this.log.info("worker.started", {
      workerId: this.id,
      concurrency: this.concurrency,
      pollIntervalMs: this.pollIntervalMs,
      leaseSeconds: this.leaseSeconds,
    });

    void this.sweepStale();
    this.sweepTimer = setInterval(() => void this.sweepStale(), this.staleSweepIntervalMs);
    this.sweepTimer.unref?.();

    this.loopPromise = this.loop();
  }

  /** Stop claiming, let in-flight work finish (bounded), then resolve. */
  async stop(graceMs = 25_000): Promise<void> {
    if (!this.running) return;
    this.stopping = true;
    this.log.info("worker.stopping", { workerId: this.id, inFlight: this.activeJobs });

    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const deadline = Date.now() + graceMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...this.inFlight]), sleep(250)]);
    }

    if (this.inFlightJobIds.size > 0) {
      // Grace period expired: hand the work back so another instance (or this
      // one after restart) picks it up without burning an attempt.
      for (const jobId of this.inFlightJobIds) {
        await releaseJob(jobId, this.id).catch((error: unknown) => {
          this.log.exception("worker.release_failed", error, { jobId: this.id });
        });
      }
      this.log.warn("worker.released_in_flight", { jobIds: [...this.inFlightJobIds] });
    }

    await this.loopPromise?.catch(() => {});
    this.running = false;
    this.log.info("worker.stopped", { workerId: this.id });
  }

  /**
   * Claim and fully execute at most one job. Used by tests and by the
   * `bun run worker:once` operational drain.
   *
   * Returns `true` when a job was processed.
   */
  async runOnce(): Promise<boolean> {
    const job = await claimJob(this.id);
    if (!job) return false;

    this.activeJobs += 1;
    this.inFlightJobIds.add(job.id);
    const generationId = readGenerationId(job.payload) ?? undefined;
    const log = this.log.child({ jobId: job.id, generationId, attempt: job.attempts });

    try {
      await this.executeJob(job, log);
    } finally {
      this.activeJobs -= 1;
      this.inFlightJobIds.delete(job.id);
    }

    return true;
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      if (this.activeJobs >= this.concurrency) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      let claimed = false;
      try {
        const job = await claimJob(this.id);
        if (job) {
          claimed = true;
          this.currentIdleDelay = this.pollIntervalMs;
          this.runJob(job);
        }
      } catch (error) {
        increment("worker_errors_total", { phase: "claim" });
        this.log.exception("worker.claim_failed", error);
      }

      if (!claimed) {
        // Back off while idle so an empty queue does not hammer the database.
        await sleep(this.currentIdleDelay);
        this.currentIdleDelay = Math.min(this.idleMaxBackoffMs, Math.round(this.currentIdleDelay * 1.5));
      }
    }
  }

  private runJob(job: {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
    maxAttempts: number;
  }): void {
    this.activeJobs += 1;
    this.inFlightJobIds.add(job.id);
    setGauge("worker_active_jobs", this.activeJobs);

    const generationId = readGenerationId(job.payload) ?? undefined;
    const log = this.log.child({ jobId: job.id, generationId, attempt: job.attempts });

    const promise = this.executeJob(job, log)
      .catch((error: unknown) => {
        log.exception("worker.job_unhandled", error, { jobId: job.id });
      })
      .finally(() => {
        this.activeJobs -= 1;
        this.inFlightJobIds.delete(job.id);
        this.inFlight.delete(promise);
        setGauge("worker_active_jobs", this.activeJobs);
      });

    this.inFlight.add(promise);
  }

  private async executeJob(
    job: { id: string; type: string; payload: unknown; attempts: number; maxAttempts: number },
    log: ScopedLogger,
  ): Promise<void> {
    const started = Date.now();
    increment("jobs_started_total", { type: job.type });

    const handler = HANDLERS[job.type];
    if (!handler) {
      await markJobFailed(job.id, this.id, `No handler registered for job type ${job.type}`);
      increment("jobs_failed_total", { type: job.type });
      log.error("worker.no_handler", { jobId: job.id, type: job.type });
      return;
    }

    const leaseTimer = setInterval(
      () => {
        void renewLease(job.id, this.id).catch(() => {});
      },
      Math.max(1000, (this.leaseSeconds * 1000) / 3),
    );
    leaseTimer.unref?.();

    try {
      await withTimeout(
        handler(job.payload, log),
        this.jobTimeoutSeconds * 1000,
        `Job exceeded the ${this.jobTimeoutSeconds}s timeout`,
      );

      await markJobCompleted(job.id, this.id);
      increment("jobs_completed_total", { type: job.type });
      log.info("worker.job_completed", { jobId: job.id, durationMs: Date.now() - started });
    } catch (error) {
      await this.handleFailure(job, error, log, Date.now() - started);
    } finally {
      clearInterval(leaseTimer);
    }
  }

  private async handleFailure(
    job: { id: string; type: string; payload: unknown; attempts: number; maxAttempts: number },
    error: unknown,
    log: ScopedLogger,
    durationMs: number,
  ): Promise<void> {
    const retryable = error instanceof JobError ? error.retryable : !isPermanent(error);
    const message = error instanceof Error ? error.message : String(error);
    const decision = retryable
      ? computeRetry(job.attempts, job.maxAttempts)
      : { retry: false, runAt: null, delayMs: 0 };

    if (decision.retry && decision.runAt) {
      await requeueJob(job.id, this.id, decision.runAt, message);
      increment("jobs_retried_total", { type: job.type });
      log.warn("worker.job_retry_scheduled", {
        jobId: job.id,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
        delayMs: decision.delayMs,
        durationMs,
        errorMessage: message,
      });
      return;
    }

    await markJobFailed(job.id, this.id, message);
    increment("jobs_failed_total", { type: job.type });
    log.exception("worker.job_failed", error, {
      jobId: job.id,
      attempt: job.attempts,
      durationMs,
      retryable,
    });
  }

  private async sweepStale(): Promise<void> {
    try {
      const result = await recoverStaleJobs(this.leaseSeconds);
      if (result.requeued > 0 || result.failed > 0) {
        increment("jobs_recovered_total", { outcome: "requeued" }, result.requeued);
        increment("jobs_recovered_total", { outcome: "failed" }, result.failed);
        this.log.warn("worker.stale_jobs_recovered", { ...result });
      }
      await this.updateQueueDepth();
    } catch (error) {
      increment("worker_errors_total", { phase: "sweep" });
      this.log.exception("worker.stale_sweep_failed", error);
    }
  }

  private async updateQueueDepth(): Promise<void> {
    try {
      const rows = await getDb().execute<{ queued: number }>(
        sql`SELECT count(*)::int AS queued FROM jobs WHERE status = 'QUEUED'`,
      );
      setGauge("queue_depth", Number(rows[0]?.queued ?? 0));
    } catch {
      // Metrics must never break the loop.
    }
  }
}

function isPermanent(error: unknown): boolean {
  const candidate = error as { code?: string; status?: number };
  return (
    candidate?.code === "PRESET_NOT_SUPPORTED" ||
    candidate?.code === "VALIDATION_ERROR" ||
    candidate?.code === "UPLOAD_NOT_COMPLETE" ||
    candidate?.status === 400 ||
    candidate?.status === 415 ||
    candidate?.status === 422
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobError("PROCESSING_FAILED", message, { retryable: true })), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function safeEnv() {
  try {
    return getEnv();
  } catch {
    return null;
  }
}

export { HANDLERS };

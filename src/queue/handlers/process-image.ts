import { findPreset, type ProcessingStep, progressForStep } from "@social-resizer/contracts";
import { eq, sql } from "drizzle-orm";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";
import { assets, generation_events, generations } from "../../db/schema";
import type { ScopedLogger } from "../../observability/logger";
import { observe } from "../../observability/metrics";
import { messageForStep } from "../../services/generation/generation-service";
import { inspectSource, processImage } from "../../services/image/sharp-processor";
import { generatedKey, getStorage } from "../../services/storage";
import { errors, JobError } from "../../utils/errors";
import { readGenerationId } from "../claim-job";

export interface HandlerResult {
  skipped?: "already-completed" | "not-found";
}

/**
 * The `PROCESS_IMAGE` job handler.
 *
 * Idempotent by construction (section 9.7):
 * - returns early if the generation is already terminal;
 * - the output key is deterministic per generation, so a redelivered job
 *   overwrites rather than creating a second output asset;
 * - every state write is a guarded transition.
 */
export async function handleProcessImage(payload: unknown, log: ScopedLogger): Promise<HandlerResult> {
  const generationId = readGenerationId(payload);
  if (!generationId) {
    throw new JobError("VALIDATION_ERROR", "Job payload is missing a generationId", {
      retryable: false,
    });
  }

  const db = getDb();
  const env = getEnv();
  const storage = getStorage();

  const [generation] = await db.select().from(generations).where(eq(generations.id, generationId)).limit(1);

  if (!generation) {
    log.warn("image.generation_missing", { generationId });
    return { skipped: "not-found" };
  }

  if (generation.status === "COMPLETED" || generation.status === "FAILED") {
    log.info("image.generation_terminal", { generationId, status: generation.status });
    return { skipped: "already-completed" };
  }

  const preset = findPreset(generation.platform, generation.format);
  if (!preset) {
    await failGeneration(generationId, "PRESET_NOT_SUPPORTED", "That preset is no longer supported.");
    throw new JobError("PRESET_NOT_SUPPORTED", `Unknown preset ${generation.platform}:${generation.format}`, {
      retryable: false,
      safeMessage: "That preset is no longer supported.",
    });
  }

  const jobLog = log.child({ generationId, userId: generation.userId });
  const generationStarted = generation.createdAt.getTime();

  // Mark processing (guarded: only QUEUED -> PROCESSING).
  const started = await db
    .update(generations)
    .set({
      status: "PROCESSING",
      startedAt: generation.startedAt ?? new Date(),
      currentStep: "VALIDATING_INPUT",
      progress: progressForStep("VALIDATING_INPUT"),
      message: messageForStep("VALIDATING_INPUT", preset.platform),
    })
    .where(sql`${generations.id} = ${generationId} AND ${generations.status} = 'QUEUED'`)
    .returning({ id: generations.id });

  if (started.length === 0) {
    // Another worker or a recovery pass already moved it on.
    jobLog.info("image.transition_skipped", { reason: "generation not QUEUED" });
    return { skipped: "already-completed" };
  }

  await recordEvent(generationId, "PROCESSING", "VALIDATING_INPUT", preset.platform);

  try {
    const [asset] = await db.select().from(assets).where(eq(assets.id, generation.inputAssetId)).limit(1);

    // biome-ignore lint/complexity/useOptionalChain: an explicit null guard reads clearer here
    if (!asset || asset.uploadStatus !== "UPLOADED") {
      throw new JobError("UPLOAD_NOT_COMPLETE", "Input asset is not uploaded", {
        retryable: false,
        safeMessage: "The uploaded file is no longer available.",
      });
    }

    // ---- DOWNLOADING_INPUT -------------------------------------------------
    await advance(generationId, "DOWNLOADING_INPUT", preset.platform);
    const sourceBytes = await storage.getObject({ bucket: asset.bucket, key: asset.storageKey });
    if (sourceBytes.byteLength > env.MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      throw new JobError("FILE_TOO_LARGE", "Source exceeds the byte limit", {
        retryable: false,
        safeMessage: "That image is larger than the allowed size.",
      });
    }

    // ---- VALIDATING_INPUT (decode + pixel guard) ---------------------------
    const inspection = await inspectSource(sourceBytes);

    const [inputAsset] = await db
      .update(assets)
      .set({ width: inspection.width, height: inspection.height, mimeType: asset.mimeType })
      .where(eq(assets.id, asset.id))
      .returning({ id: assets.id });
    jobLog.debug("image.source_inspected", { inputAssetId: inputAsset?.id, ...inspection });

    // ---- RESIZING_IMAGE ----------------------------------------------------
    await advance(generationId, "RESIZING_IMAGE", preset.platform);
    const processed = await processImage(sourceBytes, preset, inspection);

    // ---- UPLOADING_OUTPUT --------------------------------------------------
    await advance(generationId, "UPLOADING_OUTPUT", preset.platform);
    const key = generatedKey(generation.userId, generationId, processed.extension);
    await storage.putObject({
      bucket: storage.generatedBucket,
      key,
      body: processed.body,
      contentType: processed.mimeType,
      cacheControl: "private, max-age=31536000, immutable",
    });

    // ---- FINALIZING --------------------------------------------------------
    await advance(generationId, "FINALIZING", preset.platform);

    // Reuse the existing output asset on retry so a redelivered job never
    // creates a second one.
    const outputAssetId = await upsertOutputAsset({
      existingOutputAssetId: generation.outputAssetId,
      userId: generation.userId,
      key,
      bucket: storage.generatedBucket,
      mimeType: processed.mimeType,
      sizeBytes: processed.body.byteLength,
      width: processed.width,
      height: processed.height,
      originalFilename: `${slug(preset.platform)}-${slug(preset.format)}.${processed.extension}`,
    });

    const completed = await db
      .update(generations)
      .set({
        status: "COMPLETED",
        progress: 100,
        currentStep: "COMPLETED",
        message: messageForStep("COMPLETED", preset.platform),
        outputAssetId,
        completedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      })
      .where(sql`${generations.id} = ${generationId} AND ${generations.status} = 'PROCESSING'`)
      .returning({ id: generations.id });

    if (completed.length === 0) {
      jobLog.warn("image.completion_transition_skipped", { generationId });
    }

    await recordEvent(generationId, "COMPLETED", "COMPLETED", preset.platform, {
      outputAssetId,
      width: processed.width,
      height: processed.height,
      mimeType: processed.mimeType,
      sizeBytes: processed.body.byteLength,
    });

    observe("generation_duration_seconds", (Date.now() - generationStarted) / 1000, {
      platform: preset.platform,
    });

    jobLog.info("image.generation_completed", {
      outputAssetId,
      width: processed.width,
      height: processed.height,
      mimeType: processed.mimeType,
      sizeBytes: processed.body.byteLength,
    });

    return {};
  } catch (cause) {
    const failure = describe(cause);
    await failGeneration(generationId, failure.code, failure.message);
    throw cause;
  }
}

async function advance(generationId: string, step: ProcessingStep, platform: string) {
  await getDb()
    .update(generations)
    .set({
      currentStep: step,
      progress: progressForStep(step),
      message: messageForStep(step, platform),
    })
    .where(sql`${generations.id} = ${generationId} AND ${generations.status} = 'PROCESSING'`);

  await recordEvent(generationId, "PROGRESS", step, platform);
}

async function recordEvent(
  generationId: string,
  eventType: "QUEUED" | "PROCESSING" | "PROGRESS" | "COMPLETED" | "FAILED",
  step: ProcessingStep,
  platform: string,
  metadata: Record<string, unknown> = {},
) {
  await getDb()
    .insert(generation_events)
    .values({
      generationId,
      eventType,
      progress: progressForStep(step),
      message: messageForStep(step, platform),
      metadata: { step, ...metadata },
    });
}

async function failGeneration(generationId: string, code: string, message: string) {
  await getDb()
    .update(generations)
    .set({
      status: "FAILED",
      errorCode: code,
      errorMessage: message,
      message,
      completedAt: new Date(),
    })
    .where(sql`${generations.id} = ${generationId} AND ${generations.status} IN ('QUEUED', 'PROCESSING')`);

  await getDb()
    .insert(generation_events)
    .values({ generationId, eventType: "FAILED", message, metadata: { code } });
}

function describe(cause: unknown): { code: string; message: string } {
  if (cause instanceof JobError) return { code: cause.code, message: cause.safeMessage };
  const candidate = cause as { code?: string; status?: number; message?: string };
  if (candidate?.code === "STORAGE_ERROR" || candidate?.status === 503) {
    return { code: "STORAGE_ERROR", message: "Storage was temporarily unavailable." };
  }
  return { code: "PROCESSING_FAILED", message: "We could not process that image." };
}

async function upsertOutputAsset(input: {
  existingOutputAssetId: string | null;
  userId: string;
  key: string;
  bucket: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  originalFilename: string;
}): Promise<string> {
  const db = getDb();

  if (input.existingOutputAssetId) {
    const [updated] = await db
      .update(assets)
      .set({
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        uploadStatus: "UPLOADED",
        uploadedAt: new Date(),
      })
      .where(eq(assets.id, input.existingOutputAssetId))
      .returning({ id: assets.id });
    if (updated) return updated.id;
  }

  const [created] = await db
    .insert(assets)
    .values({
      userId: input.userId,
      kind: "IMAGE",
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      width: input.width,
      height: input.height,
      bucket: input.bucket,
      storageKey: input.key,
      uploadStatus: "UPLOADED",
      uploadedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [assets.bucket, assets.storageKey],
      set: {
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        width: input.width,
        height: input.height,
        uploadStatus: "UPLOADED",
        uploadedAt: new Date(),
      },
    })
    .returning({ id: assets.id });

  if (!created) throw errors.internal(new Error("output asset upsert returned no row"));
  return created.id;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

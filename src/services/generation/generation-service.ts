import {
  type Format,
  findPreset,
  type Generation as GenerationDto,
  type GenerationError,
  type GenerationOutput,
  type GenerationStatus,
  type Platform,
  type ProcessingStep,
  progressForStep,
} from "@social-resizer/contracts";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getEnv } from "../../config/env";
import { type Database, getDb } from "../../db/client";
import type { GenerationRow } from "../../db/schema";
import { assets, generation_events, generations, jobs } from "../../db/schema";
import { increment } from "../../observability/metrics";
import { errors } from "../../utils/errors";
import { assertGenerationQuota, findOwnedUploadedAsset } from "./quota-service";

export interface CreateGenerationInput {
  userId: string;
  assetId: string;
  platform: Platform;
  format: Format;
  idempotencyKey: string | null;
  requestId: string;
}

export interface CreateGenerationResult {
  generationId: string;
  status: GenerationStatus;
  progress: number;
  created: boolean;
}

/** Human-readable, non-sensitive status copy. */
const STEP_MESSAGES: Record<ProcessingStep, string> = {
  QUEUED: "Waiting in the queue",
  VALIDATING_INPUT: "Checking your image",
  DOWNLOADING_INPUT: "Downloading your image",
  RESIZING_IMAGE: "Resizing your image",
  UPLOADING_OUTPUT: "Uploading the result",
  FINALIZING: "Finishing up",
  COMPLETED: "Your image is ready",
};

export function messageForStep(step: ProcessingStep, platform: string): string {
  if (step === "RESIZING_IMAGE") {
    return `Resizing image for ${platform.charAt(0)}${platform.slice(1).toLowerCase()}`;
  }
  return STEP_MESSAGES[step];
}

/**
 * Create a generation and its job in one transaction (section 9.2).
 *
 * Order matters: quota check → ownership check → idempotency check → insert.
 * If anything throws, neither the generation nor the job survives.
 */
export async function createGeneration(input: CreateGenerationInput): Promise<CreateGenerationResult> {
  const preset = findPreset(input.platform, input.format);
  if (!preset) throw errors.presetNotSupported();

  const db = getDb();

  return db.transaction(async (tx) => {
    await assertGenerationQuota(tx as unknown as Database, input.userId, { lockUser: true });
    await findOwnedUploadedAsset(tx as unknown as Database, input.userId, input.assetId);

    if (input.idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(generations)
        .where(
          and(eq(generations.userId, input.userId), eq(generations.idempotencyKey, input.idempotencyKey)),
        )
        .limit(1);

      if (existing) {
        const sameRequest =
          existing.inputAssetId === input.assetId &&
          existing.platform === input.platform &&
          existing.format === input.format;
        if (!sameRequest) throw errors.idempotencyConflict();
        return {
          generationId: existing.id,
          status: existing.status as GenerationStatus,
          progress: existing.progress,
          created: false,
        };
      }
    }

    const [generation] = await tx
      .insert(generations)
      .values({
        userId: input.userId,
        inputAssetId: input.assetId,
        platform: input.platform,
        format: input.format,
        status: "QUEUED",
        progress: 0,
        currentStep: "QUEUED",
        message: STEP_MESSAGES.QUEUED,
        idempotencyKey: input.idempotencyKey,
        requestId: input.requestId,
      })
      .returning();

    if (!generation) throw errors.internal(new Error("generation insert returned no row"));

    await tx.insert(jobs).values({
      type: "PROCESS_IMAGE",
      payload: { generationId: generation.id, requestId: input.requestId },
      status: "QUEUED",
      maxAttempts: getEnv().WORKER_MAX_ATTEMPTS,
    });

    await tx.insert(generation_events).values({
      generationId: generation.id,
      eventType: "QUEUED",
      progress: 0,
      message: STEP_MESSAGES.QUEUED,
      metadata: { platform: input.platform, format: input.format, requestId: input.requestId },
    });

    increment("generation_created_total", { platform: input.platform, format: input.format });

    return {
      generationId: generation.id,
      status: "QUEUED" as GenerationStatus,
      progress: 0,
      created: true,
    };
  });
}

/** Ownership-scoped read. Returns `null` for another user's generation. */
export async function findGeneration(userId: string, generationId: string): Promise<GenerationRow | null> {
  const [row] = await getDb()
    .select()
    .from(generations)
    .where(and(eq(generations.id, generationId), eq(generations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function requireGeneration(userId: string, generationId: string): Promise<GenerationRow> {
  const row = await findGeneration(userId, generationId);
  if (!row) throw errors.generationNotFound();
  return row;
}

export interface GenerationPage {
  items: Array<{
    id: string;
    status: GenerationStatus;
    progress: number;
    platform: Platform;
    format: Format;
    createdAt: Date;
    completedAt: Date | null;
    outputAssetId: string | null;
    outputWidth: number | null;
    outputHeight: number | null;
    thumbnailKey: string | null;
    thumbnailBucket: string | null;
  }>;
  nextCursor: string | null;
}

/** Cursor-paginated, newest-first list scoped to the owner. */
export async function listGenerations(
  userId: string,
  options: { limit: number; cursor?: { createdAt: Date; id: string } | null },
): Promise<GenerationPage> {
  const limit = Math.min(Math.max(options.limit, 1), 50);

  const cursorFilter = options.cursor
    ? sql`(${generations.createdAt}, ${generations.id}) < (${options.cursor.createdAt.toISOString()}::timestamptz, ${options.cursor.id}::uuid)`
    : undefined;

  const rows = await getDb()
    .select({
      id: generations.id,
      status: generations.status,
      progress: generations.progress,
      platform: generations.platform,
      format: generations.format,
      createdAt: generations.createdAt,
      completedAt: generations.completedAt,
      outputAssetId: generations.outputAssetId,
      outputWidth: assets.width,
      outputHeight: assets.height,
      thumbnailKey: sql<
        string | null
      >`CASE WHEN ${assets.uploadStatus} = 'UPLOADED' THEN ${assets.storageKey} END`,
      thumbnailBucket: sql<
        string | null
      >`CASE WHEN ${assets.uploadStatus} = 'UPLOADED' THEN ${assets.bucket} END`,
    })
    .from(generations)
    .leftJoin(assets, eq(assets.id, generations.outputAssetId))
    .where(cursorFilter ? and(eq(generations.userId, userId), cursorFilter) : eq(generations.userId, userId))
    .orderBy(desc(generations.createdAt), desc(generations.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map((row) => ({
      ...row,
      status: row.status as GenerationStatus,
      platform: row.platform as Platform,
      format: row.format as Format,
    })),
    nextCursor: hasMore && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  };
}

export function parseCursor(raw: string | undefined): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const separator = raw.lastIndexOf("|");
  if (separator < 0) return null;
  const createdAt = new Date(raw.slice(0, separator));
  const id = raw.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

/** Map the database row to the API DTO. Never leaks storage keys or signed URLs. */
export async function toGenerationDto(
  row: GenerationRow,
  fetchOutputAsset: (assetId: string) => Promise<{
    id: string;
    width: number | null;
    height: number | null;
    mimeType: string;
    sizeBytes: number;
    uploadStatus: string;
  } | null>,
): Promise<GenerationDto> {
  let output: GenerationOutput | null = null;

  if (row.status === "COMPLETED" && row.outputAssetId) {
    const asset = await fetchOutputAsset(row.outputAssetId);
    if (asset?.uploadStatus === "UPLOADED" && asset.width && asset.height) {
      output = {
        assetId: asset.id,
        width: asset.width,
        height: asset.height,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      };
    }
  }

  const error: GenerationError | null =
    row.status === "FAILED" && row.errorCode
      ? { code: row.errorCode as GenerationError["code"], message: row.errorMessage ?? "Processing failed." }
      : null;

  return {
    id: row.id,
    status: row.status as GenerationStatus,
    progress: row.progress,
    currentStep: (row.currentStep ?? "QUEUED") as ProcessingStep,
    message: row.message,
    platform: row.platform as Platform,
    format: row.format as Format,
    inputAssetId: row.inputAssetId,
    output,
    error,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

export { lt, progressForStep };

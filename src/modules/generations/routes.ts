import type {
  GenerationListResponse,
  GenerationStatusResponse,
  SignedUrlResponse,
} from "@social-resizer/contracts";
import { eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";
import { assets } from "../../db/schema";
import { rawHeaders, requireSession } from "../../middleware/auth";
import { enforce, rateLimitHeaders, rules } from "../../middleware/rate-limit";
import { getContext } from "../../middleware/request-context";
import {
  createGeneration,
  listGenerations,
  parseCursor,
  requireGeneration,
  toGenerationDto,
} from "../../services/generation/generation-service";
import { getStorage } from "../../services/storage";
import { errors } from "../../utils/errors";

async function outputAsset(assetId: string) {
  const [row] = await getDb()
    .select({
      id: assets.id,
      width: assets.width,
      height: assets.height,
      mimeType: assets.mimeType,
      sizeBytes: assets.sizeBytes,
      uploadStatus: assets.uploadStatus,
      bucket: assets.bucket,
      storageKey: assets.storageKey,
    })
    .from(assets)
    .where(eq(assets.id, assetId))
    .limit(1);
  return row ?? null;
}

export const generationRoutes = new Elysia({ prefix: "/generations", tags: ["generations"] })
  .post(
    "/",
    async (context) => {
      const principal = await requireSession(context);
      const { set, body } = context;
      const ctx = getContext(context.request);
      const headers = rawHeaders(context.request);

      const limit = await enforce(rules().generation, { userId: principal.userId, clientIp: ctx.clientIp });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const idempotencyKey = headers["idempotency-key"]?.trim() || null;
      if (idempotencyKey && idempotencyKey.length > 200) {
        throw errors.validation("Idempotency-Key must be 200 characters or fewer.");
      }

      const result = await createGeneration({
        userId: principal.userId,
        assetId: body.assetId,
        platform: body.platform,
        format: body.format,
        idempotencyKey,
        requestId: ctx.requestId,
      });

      ctx.log.info(result.created ? "generation.created" : "generation.idempotent_replay", {
        generationId: result.generationId,
        assetId: body.assetId,
        platform: body.platform,
        format: body.format,
        userId: principal.userId,
      });

      set.status = 202;
      return {
        generationId: result.generationId,
        status: result.status,
        progress: result.progress,
      };
    },
    {
      body: t.Object({
        assetId: t.String({ format: "uuid" }),
        platform: t.Union([t.Literal("INSTAGRAM"), t.Literal("TIKTOK"), t.Literal("YOUTUBE")]),
        format: t.Union([
          t.Literal("SQUARE"),
          t.Literal("PORTRAIT"),
          t.Literal("STORY"),
          t.Literal("COVER"),
          t.Literal("THUMBNAIL"),
        ]),
      }),
      headers: t.Object({ "idempotency-key": t.Optional(t.String()) }),
      detail: {
        summary: "Create a generation and enqueue the processing job",
        description:
          "Returns 202 with the queued generation. Repeat calls with the same Idempotency-Key return the existing generation; reusing a key for a different payload returns 409.",
      },
    },
  )
  .get(
    "/",
    async (context) => {
      const principal = await requireSession(context);
      const { query, set } = context;
      const limit = await enforce(rules().status, { userId: principal.userId });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const page = await listGenerations(principal.userId, {
        limit: query.limit ? Number(query.limit) : 20,
        cursor: parseCursor(query.cursor),
      });

      const storage = getStorage();
      const env = getEnv();

      const items = await Promise.all(
        page.items.map(async (item) => {
          let thumbnailUrl: string | null = null;
          if (item.status === "COMPLETED" && item.thumbnailKey && item.thumbnailBucket) {
            thumbnailUrl = (
              await storage.presignDownload({
                bucket: item.thumbnailBucket,
                key: item.thumbnailKey,
                expiresInSeconds: env.PRESIGNED_DOWNLOAD_TTL_SECONDS,
                responseContentType: "image/jpeg",
              })
            ).url;
          }
          return {
            id: item.id,
            status: item.status,
            progress: item.progress,
            platform: item.platform,
            format: item.format,
            createdAt: item.createdAt.toISOString(),
            completedAt: item.completedAt?.toISOString() ?? null,
            thumbnailUrl,
          };
        }),
      );

      const response: GenerationListResponse = { items, nextCursor: page.nextCursor };
      return response;
    },
    {
      query: t.Object({
        limit: t.Optional(t.String({ pattern: "^[0-9]{1,2}$" })),
        cursor: t.Optional(t.String({ maxLength: 120 })),
      }),
      detail: { summary: "List the current user's generations" },
    },
  )
  .get(
    "/:generationId",
    async (context) => {
      const principal = await requireSession(context);
      const { set, params } = context;
      const ctx = getContext(context.request);

      const limit = await enforce(rules().status, { userId: principal.userId });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const row = await requireGeneration(principal.userId, params.generationId);
      ctx.log.debug("generation.status_read", {
        generationId: row.id,
        status: row.status,
        progress: row.progress,
      });

      const response: GenerationStatusResponse = await toGenerationDto(row, outputAsset);
      return response;
    },
    {
      params: t.Object({ generationId: t.String({ format: "uuid" }) }),
      detail: { summary: "Get generation status and output metadata" },
    },
  )
  .post(
    "/:generationId/download-url",
    async (context) => {
      const principal = await requireSession(context);
      const { set, params } = context;
      const ctx = getContext(context.request);
      const env = getEnv();
      const storage = getStorage();

      const limit = await enforce(rules().downloadUrl, { userId: principal.userId });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const generation = await requireGeneration(principal.userId, params.generationId);
      if (generation.status !== "COMPLETED" || !generation.outputAssetId) {
        throw errors.invalidTransition("This generation does not have a result to download yet.");
      }

      const asset = await outputAsset(generation.outputAssetId);
      // biome-ignore lint/complexity/useOptionalChain: an explicit null guard reads clearer here
      if (!asset || asset.uploadStatus !== "UPLOADED") {
        throw errors.notFound("The processed image is not available.");
      }

      const extension = extensionFor(asset.mimeType);
      const signed = await storage.presignDownload({
        bucket: asset.bucket,
        key: asset.storageKey,
        expiresInSeconds: env.PRESIGNED_DOWNLOAD_TTL_SECONDS,
        responseContentType: asset.mimeType,
        responseContentDisposition: `attachment; filename="${filenameFor(generation.platform, generation.format, extension)}"`,
      });

      ctx.log.info("generation.download_url_issued", { generationId: generation.id, assetId: asset.id });

      const response: SignedUrlResponse = {
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        mimeType: asset.mimeType,
        filename: filenameFor(generation.platform, generation.format, extension),
      };
      return response;
    },
    {
      params: t.Object({ generationId: t.String({ format: "uuid" }) }),
      detail: { summary: "Get a short-lived signed URL for the processed image" },
    },
  );

function extensionFor(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function filenameFor(platform: string, format: string, extension: string): string {
  return `${platform.toLowerCase()}-${format.toLowerCase()}.${extension}`;
}

export { sql };

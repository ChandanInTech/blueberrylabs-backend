import type {
  AssetMetadata,
  CompleteUploadResponse,
  CreateUploadResponse,
  SignedUrlResponse,
} from "@social-resizer/contracts";
import { eq, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { getEnv } from "../../config/env";
import { getDb } from "../../db/client";
import { assets } from "../../db/schema";
import { requireSession } from "../../middleware/auth";
import { enforce, rateLimitHeaders, rules } from "../../middleware/rate-limit";
import { getContext } from "../../middleware/request-context";
import { increment } from "../../observability/metrics";
import { assertPendingUploadQuota } from "../../services/generation/quota-service";
import { getStorage, originalKey } from "../../services/storage";
import { errors } from "../../utils/errors";
import { formatBytes, sanitizeFilename, validateUploadMetadata } from "./validation";

const createUploadSchema = t.Object({
  filename: t.String({ minLength: 1, maxLength: 255 }),
  contentType: t.String({ minLength: 1, maxLength: 100 }),
  sizeBytes: t.Integer({ minimum: 1 }),
});

function toMetadata(row: typeof assets.$inferSelect): AssetMetadata {
  return {
    assetId: row.id,
    kind: "IMAGE",
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    uploadStatus: row.uploadStatus as AssetMetadata["uploadStatus"],
    createdAt: row.createdAt.toISOString(),
  };
}

async function findOwnedAsset(userId: string, assetId: string) {
  const [row] = await getDb()
    .select()
    .from(assets)
    .where(sql`${assets.id} = ${assetId} AND ${assets.userId} = ${userId}`)
    .limit(1);
  return row ?? null;
}

/** Upload-session creation and completion (architecture section 6.3). */
export const uploadRoutes = new Elysia({ prefix: "/uploads", tags: ["uploads"] })
  .post(
    "/",
    async (context) => {
      const principal = await requireSession(context);
      const { set, body } = context;
      const ctx = getContext(context.request);
      const env = getEnv();
      const storage = getStorage();

      const limit = await enforce(rules().upload, { userId: principal.userId, clientIp: ctx.clientIp });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const validation = validateUploadMetadata(
        {
          filename: sanitizeFilename(body.filename),
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        },
        { allowedTypes: env.ALLOWED_IMAGE_TYPES, maxBytes: env.MAX_IMAGE_SIZE_MB * 1024 * 1024 },
      );

      if (!validation.ok) {
        if (validation.code === "FILE_TOO_LARGE") throw errors.fileTooLarge(validation.message);
        if (validation.code === "UNSUPPORTED_MEDIA_TYPE") throw errors.unsupportedMedia(validation.message);
        throw errors.validation(validation.message);
      }

      const db = getDb();

      // Quota check and insert share a transaction so simultaneous requests
      // cannot both slip under the pending-upload cap.
      const created = await db.transaction(async (tx) => {
        await assertPendingUploadQuota(tx as never, principal.userId);

        const [row] = await tx
          .insert(assets)
          .values({
            userId: principal.userId,
            kind: "IMAGE",
            originalFilename: sanitizeFilename(body.filename),
            mimeType: body.contentType.split(";")[0]?.trim().toLowerCase() ?? body.contentType,
            sizeBytes: body.sizeBytes,
            bucket: storage.originalsBucket,
            // Placeholder key so the unique (bucket, storage_key) index holds
            // before the real key is known; replaced below in the same tx.
            storageKey: `pending/${principal.userId}/${crypto.randomUUID()}`,
            uploadStatus: "PENDING",
          })
          .returning();

        if (!row) throw errors.internal(new Error("asset insert returned no row"));

        const key = originalKey(principal.userId, row.id);
        const [withKey] = await tx
          .update(assets)
          .set({ storageKey: key })
          .where(eq(assets.id, row.id))
          .returning();

        return withKey ?? row;
      });

      const presigned = await storage.presignUpload({
        bucket: created.bucket,
        key: created.storageKey,
        contentType: created.mimeType,
        contentLength: created.sizeBytes,
        expiresInSeconds: env.PRESIGNED_UPLOAD_TTL_SECONDS,
      });

      ctx.log.info("upload.session_created", {
        assetId: created.id,
        sizeBytes: created.sizeBytes,
        mimeType: created.mimeType,
      });

      set.status = 201;

      const response: CreateUploadResponse = {
        assetId: created.id,
        uploadUrl: presigned.url,
        method: "PUT",
        headers: presigned.headers,
        expiresAt: presigned.expiresAt.toISOString(),
      };
      return response;
    },
    {
      body: createUploadSchema,
      detail: { summary: "Create an asset and a presigned upload URL" },
    },
  )
  .post(
    "/:assetId/complete",
    async (context) => {
      const principal = await requireSession(context);
      const { params, set } = context;
      const ctx = getContext(context.request);
      const env = getEnv();
      const storage = getStorage();

      const limit = await enforce(rules().uploadComplete, { userId: principal.userId });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const asset = await findOwnedAsset(principal.userId, params.assetId);
      if (!asset) throw errors.uploadNotFound();

      if (asset.uploadStatus === "UPLOADED") {
        // Idempotent: completing twice is a no-op success.
        const already: CompleteUploadResponse = { assetId: asset.id, uploadStatus: "UPLOADED" };
        return already;
      }

      // A presigned URL being issued is not proof the object exists: verify.
      const meta = await storage.headObject({ bucket: asset.bucket, key: asset.storageKey });
      if (!meta) {
        await getDb().update(assets).set({ uploadStatus: "FAILED" }).where(eq(assets.id, asset.id));
        increment("uploads_total", { outcome: "missing" });
        throw errors.uploadVerificationFailed(
          "We could not find the uploaded file. Please try uploading again.",
        );
      }

      if (meta.sizeBytes <= 0 || meta.sizeBytes > env.MAX_IMAGE_SIZE_MB * 1024 * 1024) {
        await storage.deleteObject({ bucket: asset.bucket, key: asset.storageKey }).catch(() => {});
        await getDb().update(assets).set({ uploadStatus: "FAILED" }).where(eq(assets.id, asset.id));
        increment("uploads_total", { outcome: "invalid_size" });
        throw errors.uploadVerificationFailed(
          `The uploaded file must be between 1 byte and ${formatBytes(env.MAX_IMAGE_SIZE_MB * 1024 * 1024)}.`,
        );
      }

      // The object store's reported type must still agree with what we signed.
      if (meta.contentType && meta.contentType.split(";")[0]?.trim().toLowerCase() !== asset.mimeType) {
        await storage.deleteObject({ bucket: asset.bucket, key: asset.storageKey }).catch(() => {});
        await getDb().update(assets).set({ uploadStatus: "FAILED" }).where(eq(assets.id, asset.id));
        increment("uploads_total", { outcome: "invalid_type" });
        throw errors.uploadVerificationFailed("The uploaded file type did not match the request.");
      }

      const [updated] = await getDb()
        .update(assets)
        .set({ uploadStatus: "UPLOADED", uploadedAt: new Date(), sizeBytes: meta.sizeBytes })
        .where(sql`${assets.id} = ${asset.id} AND ${assets.uploadStatus} = 'PENDING'`)
        .returning();

      increment("uploads_total", { outcome: "verified" });
      increment("upload_bytes_total", {}, meta.sizeBytes);

      ctx.log.info("upload.verified", {
        assetId: asset.id,
        sizeBytes: meta.sizeBytes,
        mimeType: asset.mimeType,
      });

      const response: CompleteUploadResponse = {
        assetId: (updated ?? asset).id,
        uploadStatus: "UPLOADED",
      };
      return response;
    },
    {
      params: t.Object({ assetId: t.String({ format: "uuid" }) }),
      detail: { summary: "Verify and finalize a completed upload" },
    },
  );

/** Asset metadata and signed asset URLs. */
export const assetRoutes = new Elysia({ prefix: "/assets", tags: ["assets"] })
  .get(
    "/:assetId",
    async (context) => {
      const principal = await requireSession(context);
      const asset = await findOwnedAsset(principal.userId, context.params.assetId);
      if (!asset) throw errors.notFound("That asset was not found.");
      return toMetadata(asset);
    },
    {
      params: t.Object({ assetId: t.String({ format: "uuid" }) }),
      detail: { summary: "Get owned asset metadata" },
    },
  )
  .get(
    "/:assetId/download-url",
    async (context) => {
      const principal = await requireSession(context);
      const { set, params } = context;
      const ctx = getContext(context.request);
      const env = getEnv();
      const storage = getStorage();

      const limit = await enforce(rules().downloadUrl, { userId: principal.userId });
      for (const [key, value] of Object.entries(rateLimitHeaders(limit))) set.headers[key] = value;

      const asset = await findOwnedAsset(principal.userId, params.assetId);
      if (!asset) throw errors.notFound("That asset was not found.");
      if (asset.uploadStatus !== "UPLOADED") throw errors.uploadNotComplete();

      const extension =
        asset.mimeType === "image/png" ? "png" : asset.mimeType === "image/webp" ? "webp" : "jpg";
      const signed = await storage.presignDownload({
        bucket: asset.bucket,
        key: asset.storageKey,
        expiresInSeconds: env.PRESIGNED_DOWNLOAD_TTL_SECONDS,
        responseContentType: asset.mimeType,
        responseContentDisposition: `attachment; filename="image.${extension}"`,
      });

      ctx.log.info("asset.download_url_issued", { assetId: asset.id });

      const response: SignedUrlResponse = {
        url: signed.url,
        expiresAt: signed.expiresAt.toISOString(),
        mimeType: asset.mimeType,
        filename: `image.${extension}`,
      };
      return response;
    },
    {
      params: t.Object({ assetId: t.String({ format: "uuid" }) }),
      detail: { summary: "Get a short-lived signed URL for an asset" },
    },
  );

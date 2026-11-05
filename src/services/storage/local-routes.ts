import { Elysia, t } from "elysia";
import { getEnv } from "../../config/env";
import type { FilesystemStorage } from "./filesystem";
import { getStorage } from "./index";

/**
 * Development-only routes that stand in for Railway Buckets when
 * `STORAGE_DRIVER=filesystem`.
 *
 * They intentionally mirror the shape of presigned S3 URLs: the same
 * `?expires=&signature=` query parameters, PUT semantics for uploads and GET
 * semantics for downloads. This keeps the frontend XHR upload path identical in
 * local development and production.
 */
export const localStorageRoutes = new Elysia({ name: "local-storage", tags: ["local-storage"] })
  .put(
    "/__storage/:bucket/*",
    async ({ params, query, request, set }) => {
      const storage = currentStorage();
      const key = (params as Record<string, string>)["*"] ?? "";

      const signature = String(query.signature ?? "");
      const expires = Number(query.expires ?? 0);
      const contentType = String(query.contentType ?? "");

      if (!storage.verify({ bucket: params.bucket, key, expires, contentType, signature })) {
        set.status = 403;
        return { error: { code: "INVALID_ORIGIN", message: "This upload URL is invalid or expired." } };
      }

      const declared = request.headers.get("content-type") ?? contentType;
      if (contentType && declared.split(";")[0]?.trim().toLowerCase() !== contentType) {
        set.status = 415;
        return { error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Content-Type mismatch." } };
      }

      const env = getEnv();
      const buffer = new Uint8Array(await request.arrayBuffer());
      if (buffer.byteLength > env.MAX_IMAGE_SIZE_MB * 1024 * 1024) {
        set.status = 413;
        return { error: { code: "FILE_TOO_LARGE", message: "That file is too large." } };
      }

      await storage.putObject({
        bucket: params.bucket,
        key,
        body: buffer,
        contentType: declared.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream",
      });

      set.status = 200;
      return null;
    },
    {
      query: t.Object({
        expires: t.String(),
        signature: t.String(),
        contentType: t.Optional(t.String()),
      }),
    },
  )
  .get(
    "/__storage/:bucket/*",
    async ({ params, query, set }) => {
      const storage = currentStorage();
      const key = (params as Record<string, string>)["*"] ?? "";

      const signature = String(query.signature ?? "");
      const expires = Number(query.expires ?? 0);

      if (!storage.verify({ bucket: params.bucket, key, expires, contentType: "", signature })) {
        set.status = 403;
        return { error: { code: "INVALID_ORIGIN", message: "This URL is invalid or expired." } };
      }

      const meta = await storage.headObject({ bucket: params.bucket, key });
      if (!meta) {
        set.status = 404;
        return { error: { code: "NOT_FOUND", message: "Not found." } };
      }

      const bytes = await storage.getObject({ bucket: params.bucket, key });
      const headers: Record<string, string> = {
        "Content-Type": meta.contentType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      };
      if (query.download) headers["Content-Disposition"] = String(query.download);
      return new Response(bytes, { headers });
    },
    {
      query: t.Object({
        expires: t.String(),
        signature: t.String(),
        download: t.Optional(t.String()),
      }),
    },
  );

/** The same singleton the rest of the app uses, so signatures always agree. */
function currentStorage(): FilesystemStorage {
  const storage = getStorage();
  if (storage.driver !== "filesystem") {
    throw new Error("Local storage routes are only available with STORAGE_DRIVER=filesystem");
  }
  return storage as FilesystemStorage;
}

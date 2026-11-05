import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../../config/env";
import { errors } from "../../utils/errors";
import type { ObjectMetadata, PresignedUpload, StorageService } from "./storage.interface";

/**
 * Railway Buckets adapter (S3-compatible).
 *
 * Two details of Railway Buckets shape this class:
 *
 * 1. Credentials are scoped to a single bucket — a key pair for
 *    `media-originals` is rejected by `media-generated` with 403. So each
 *    bucket gets its own client rather than sharing one.
 * 2. `railway bucket credentials` reports `urlStyle: virtual-host`, meaning the
 *    bucket name belongs in the host. Signing path-style URLs produces links
 *    the bucket refuses, so path style is opt-in via
 *    `RAILWAY_BUCKET_FORCE_PATH_STYLE`.
 *
 * Credentials never leave the server.
 */
export class RailwayBucketStorage implements StorageService {
  readonly driver = "s3" as const;
  readonly originalsBucket: string;
  readonly generatedBucket: string;

  private readonly clients: Record<"originals" | "generated", S3Client>;

  constructor(env: Env) {
    this.originalsBucket = env.RAILWAY_BUCKET_ORIGINALS;
    this.generatedBucket = env.RAILWAY_BUCKET_GENERATED;

    const build = (accessKeyId: string, secretAccessKey: string) =>
      new S3Client({
        region: env.RAILWAY_BUCKET_REGION || "auto",
        endpoint: env.RAILWAY_BUCKET_ENDPOINT,
        forcePathStyle: env.RAILWAY_BUCKET_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: accessKeyId || env.RAILWAY_BUCKET_ACCESS_KEY_ID,
          secretAccessKey: secretAccessKey || env.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
        },
      });

    this.clients = {
      originals: build(
        env.RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID,
        env.RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY,
      ),
      generated: build(
        env.RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID,
        env.RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY,
      ),
    };
  }

  /** Pick the client whose credentials are scoped to the requested bucket. */
  private clientFor(bucket: string): S3Client {
    if (bucket === this.originalsBucket) return this.clients.originals;
    if (bucket === this.generatedBucket) return this.clients.generated;
    // An unknown bucket would silently use the wrong credentials; fail loudly.
    throw errors.storage(`No storage credentials are configured for bucket "${bucket}".`);
  }

  async presignUpload(params: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    try {
      const command = new PutObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        ContentType: params.contentType,
        ContentLength: params.contentLength,
      });
      const url = await getSignedUrl(this.clientFor(params.bucket), command, {
        expiresIn: params.expiresInSeconds,
      });
      return {
        url,
        method: "PUT",
        headers: { "Content-Type": params.contentType },
        expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000),
      };
    } catch (cause) {
      throw errors.storage("We could not prepare the upload.", cause);
    }
  }

  async presignDownload(params: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    responseContentType?: string;
    responseContentDisposition?: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    try {
      const command = new GetObjectCommand({
        Bucket: params.bucket,
        Key: params.key,
        ...(params.responseContentType ? { ResponseContentType: params.responseContentType } : {}),
        ...(params.responseContentDisposition
          ? { ResponseContentDisposition: params.responseContentDisposition }
          : {}),
      });
      const url = await getSignedUrl(this.clientFor(params.bucket), command, {
        expiresIn: params.expiresInSeconds,
      });
      return { url, expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000) };
    } catch (cause) {
      throw errors.storage("We could not prepare the download.", cause);
    }
  }

  async headObject(params: { bucket: string; key: string }): Promise<ObjectMetadata | null> {
    try {
      const result = await this.clientFor(params.bucket).send(
        new HeadObjectCommand({ Bucket: params.bucket, Key: params.key }),
      );
      return {
        sizeBytes: Number(result.ContentLength ?? 0),
        contentType: result.ContentType ?? null,
        etag: result.ETag ?? null,
      };
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw errors.storage("We could not verify the uploaded file.", cause);
    }
  }

  async getObject(params: { bucket: string; key: string }): Promise<Uint8Array> {
    try {
      const result = await this.clientFor(params.bucket).send(
        new GetObjectCommand({ Bucket: params.bucket, Key: params.key }),
      );
      if (!result.Body) throw new Error("Empty object body");
      return await result.Body.transformToByteArray();
    } catch (cause) {
      if (isNotFound(cause)) throw errors.uploadNotFound();
      throw errors.storage("We could not read the uploaded file.", cause);
    }
  }

  async putObject(params: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    try {
      await this.clientFor(params.bucket).send(
        new PutObjectCommand({
          Bucket: params.bucket,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
          ...(params.cacheControl ? { CacheControl: params.cacheControl } : {}),
        }),
      );
    } catch (cause) {
      throw errors.storage("We could not store the processed image.", cause);
    }
  }

  async deleteObject(params: { bucket: string; key: string }): Promise<void> {
    try {
      await this.clientFor(params.bucket).send(
        new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key }),
      );
    } catch {
      // Deletion is best-effort; a leftover object is not worth failing a request.
    }
  }
}

function isNotFound(cause: unknown): boolean {
  const candidate = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    candidate?.name === "NotFound" ||
    candidate?.name === "NoSuchKey" ||
    candidate?.$metadata?.httpStatusCode === 404
  );
}

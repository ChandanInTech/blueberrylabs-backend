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
 * Railway exposes bucket credentials through its dashboard; the endpoint,
 * region, access key and secret are mapped into `RAILWAY_BUCKET_*` variables by
 * the deployment config. Credentials never leave the server.
 */
export class RailwayBucketStorage implements StorageService {
  readonly driver = "s3" as const;
  readonly originalsBucket: string;
  readonly generatedBucket: string;
  private readonly client: S3Client;

  constructor(env: Env) {
    this.client = new S3Client({
      region: env.RAILWAY_BUCKET_REGION || "auto",
      endpoint: env.RAILWAY_BUCKET_ENDPOINT,
      // Railway Buckets are S3-compatible with path-style addressing.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.RAILWAY_BUCKET_ACCESS_KEY_ID,
        secretAccessKey: env.RAILWAY_BUCKET_SECRET_ACCESS_KEY,
      },
    });
    this.originalsBucket = env.RAILWAY_BUCKET_ORIGINALS;
    this.generatedBucket = env.RAILWAY_BUCKET_GENERATED;
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
      const url = await getSignedUrl(this.client, command, { expiresIn: params.expiresInSeconds });
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
      const url = await getSignedUrl(this.client, command, { expiresIn: params.expiresInSeconds });
      return { url, expiresAt: new Date(Date.now() + params.expiresInSeconds * 1000) };
    } catch (cause) {
      throw errors.storage("We could not prepare the download.", cause);
    }
  }

  async headObject(params: { bucket: string; key: string }): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
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
      const result = await this.client.send(new GetObjectCommand({ Bucket: params.bucket, Key: params.key }));
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
      await this.client.send(
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
      await this.client.send(new DeleteObjectCommand({ Bucket: params.bucket, Key: params.key }));
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

/**
 * Storage abstraction.
 *
 * The API never proxies image bytes; it only mints short-lived presigned URLs.
 * Anything that needs to move bytes server-side (the worker) goes through this
 * interface so a local filesystem adapter can stand in for Railway Buckets in
 * development and tests.
 */

export interface PresignedUpload {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface ObjectMetadata {
  sizeBytes: number;
  contentType: string | null;
  etag: string | null;
}

export interface StorageService {
  readonly driver: "s3" | "filesystem";

  /** Bucket holding uploaded sources. */
  readonly originalsBucket: string;
  /** Bucket holding processed outputs. */
  readonly generatedBucket: string;

  presignUpload(params: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;

  presignDownload(params: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    responseContentType?: string;
    responseContentDisposition?: string;
  }): Promise<{ url: string; expiresAt: Date }>;

  /** `HEAD` equivalent. Returns `null` when the object does not exist. */
  headObject(params: { bucket: string; key: string }): Promise<ObjectMetadata | null>;

  /** Read an object fully into memory. Only used for validated, size-capped images. */
  getObject(params: { bucket: string; key: string }): Promise<Uint8Array>;

  putObject(params: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<void>;

  deleteObject(params: { bucket: string; key: string }): Promise<void>;
}

/** Build the bucket/key pair for a source upload. Keys are never user-supplied. */
export function originalKey(userId: string, assetId: string): string {
  return `originals/${userId}/${assetId}/source`;
}

/** Deterministic per-generation output key, so a retried job overwrites rather than duplicates. */
export function generatedKey(userId: string, generationId: string, extension: string): string {
  return `generated/${userId}/${generationId}/output.${extension}`;
}

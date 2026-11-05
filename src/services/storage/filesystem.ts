import { createHmac } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ObjectMetadata, PresignedUpload, StorageService } from "./storage.interface";

/**
 * Local S3-compatible stand-in.
 *
 * Writes objects under a directory and mints signed local URLs served by
 * `/__storage/...` on the API. Used for local development and integration
 * tests when Railway Bucket credentials are unavailable (architecture section
 * 25.13: implement a clean interface and a local test adapter).
 *
 * The HMAC signature scheme here is *not* S3 authentication; it only proves the
 * server issued the URL and that it has not expired.
 */
export class FilesystemStorage implements StorageService {
  readonly driver = "filesystem" as const;
  readonly originalsBucket: string;
  readonly generatedBucket: string;

  constructor(
    private readonly root: string,
    buckets: { originals: string; generated: string },
    private readonly secret: string,
    private readonly publicBaseUrl: string,
    private readonly allowedTypes: string[],
  ) {
    this.originalsBucket = buckets.originals;
    this.generatedBucket = buckets.generated;
  }

  private pathFor(bucket: string, key: string): string {
    const base = resolve(this.root, bucket);
    const target = resolve(base, key);
    // Defence in depth: generated keys are never user-supplied, but a traversal
    // bug should not be able to escape the storage root.
    if (!target.startsWith(`${base}/`)) throw new Error("Invalid storage key");
    return target;
  }

  async presignUpload(params: {
    bucket: string;
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    if (!this.allowedTypes.includes(params.contentType)) {
      throw new Error(`Unsupported content type ${params.contentType}`);
    }
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    const signature = this.sign(params.bucket, params.key, expiresAt.getTime(), params.contentType);
    const url = new URL(`/__storage/${params.bucket}/${params.key}`, this.publicBaseUrl);
    url.searchParams.set("expires", String(expiresAt.getTime()));
    url.searchParams.set("contentType", params.contentType);
    url.searchParams.set("signature", signature);

    return {
      url: url.toString(),
      method: "PUT",
      headers: { "Content-Type": params.contentType },
      expiresAt,
    };
  }

  async presignDownload(params: {
    bucket: string;
    key: string;
    expiresInSeconds: number;
    responseContentType?: string;
    responseContentDisposition?: string;
  }): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    const signature = this.sign(params.bucket, params.key, expiresAt.getTime(), "");
    const url = new URL(`/__storage/${params.bucket}/${params.key}`, this.publicBaseUrl);
    url.searchParams.set("expires", String(expiresAt.getTime()));
    url.searchParams.set("signature", signature);
    if (params.responseContentDisposition) {
      url.searchParams.set("download", params.responseContentDisposition);
    }
    return { url: url.toString(), expiresAt };
  }

  async headObject(params: { bucket: string; key: string }): Promise<ObjectMetadata | null> {
    const filePath = this.pathFor(params.bucket, params.key);
    const metaPath = `${filePath}.meta.json`;
    try {
      const info = await stat(filePath);
      let contentType: string | null = null;
      try {
        const meta = JSON.parse(await readFile(metaPath, "utf8")) as { contentType?: string };
        contentType = meta.contentType ?? null;
      } catch {
        contentType = null;
      }
      return { sizeBytes: info.size, contentType, etag: `"${info.size}-${info.mtimeMs}"` };
    } catch {
      return null;
    }
  }

  async getObject(params: { bucket: string; key: string }): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(params.bucket, params.key)));
  }

  async putObject(params: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    const filePath = this.pathFor(params.bucket, params.key);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, params.body);
    await writeFile(`${filePath}.meta.json`, JSON.stringify({ contentType: params.contentType }));
  }

  async deleteObject(params: { bucket: string; key: string }): Promise<void> {
    const filePath = this.pathFor(params.bucket, params.key);
    await rm(filePath, { force: true });
    await rm(`${filePath}.meta.json`, { force: true });
  }

  /** Verify a presigned PUT/GET URL produced by this adapter. */
  verify(payload: {
    bucket: string;
    key: string;
    expires: number;
    contentType: string;
    signature: string;
  }): boolean {
    if (!Number.isFinite(payload.expires) || payload.expires < Date.now()) return false;
    const expected = this.sign(payload.bucket, payload.key, payload.expires, payload.contentType);
    return timingSafeExpect(expected, payload.signature);
  }

  private sign(bucket: string, key: string, expires: number, contentType: string): string {
    return createHmac("sha256", this.secret)
      .update(`${bucket}\n${key}\n${expires}\n${contentType}`)
      .digest("base64url");
  }

  /** Absolute path helper so the local storage route can stream files. */
  resolvePath(bucket: string, key: string): string {
    return this.pathFor(bucket, key);
  }

  joinPath(...parts: string[]): string {
    return join(...parts);
  }
}

function timingSafeExpect(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return mismatch === 0;
}

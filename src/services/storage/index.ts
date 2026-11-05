import { getEnv } from "../../config/env";
import { FilesystemStorage } from "./filesystem";
import { RailwayBucketStorage } from "./railway-bucket";
import type { StorageService } from "./storage.interface";

let cached: StorageService | null = null;

/**
 * Resolve the configured storage driver.
 *
 * `s3` talks to Railway Buckets. `filesystem` is the local/test adapter and
 * serves presigned URLs through the API itself.
 */
export function getStorage(): StorageService {
  if (cached) return cached;
  const env = getEnv();

  if (env.STORAGE_DRIVER === "filesystem") {
    cached = new FilesystemStorage(
      env.STORAGE_FILESYSTEM_ROOT,
      { originals: env.RAILWAY_BUCKET_ORIGINALS, generated: env.RAILWAY_BUCKET_GENERATED },
      env.JWT_SECRET,
      env.API_PUBLIC_URL,
      env.ALLOWED_IMAGE_TYPES,
    );
  } else {
    cached = new RailwayBucketStorage(env);
  }

  return cached;
}

/** Replace the driver. Test-only. */
export function setStorageForTesting(storage: StorageService | null): void {
  cached = storage;
}

export type { StorageService } from "./storage.interface";
export { generatedKey, originalKey } from "./storage.interface";

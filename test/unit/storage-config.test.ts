import { afterEach, describe, expect, test } from "bun:test";
import { EnvValidationError, getEnv, resetEnvCache } from "../../src/config/env";

const base = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/test",
  DEMO_SESSION_SECRET: "a".repeat(32),
  STORAGE_DRIVER: "s3",
  RAILWAY_BUCKET_ENDPOINT: "https://t3.storageapi.dev",
};

/** Every key this suite touches, so one test cannot leak into the next. */
const MANAGED_KEYS = [
  "DATABASE_URL",
  "DEMO_SESSION_SECRET",
  "STORAGE_DRIVER",
  "RAILWAY_BUCKET_ENDPOINT",
  "RAILWAY_BUCKET_REGION",
  "RAILWAY_BUCKET_FORCE_PATH_STYLE",
  "RAILWAY_BUCKET_ACCESS_KEY_ID",
  "RAILWAY_BUCKET_SECRET_ACCESS_KEY",
  "RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID",
  "RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY",
  "RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID",
  "RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY",
] as const;

/** Snapshot of the managed keys before the suite runs, restored after each test. */
const ORIGINAL = new Map<string, string | undefined>(MANAGED_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const original = ORIGINAL.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  resetEnvCache();
});

function withEnv(overrides: Record<string, string | undefined>) {
  for (const key of MANAGED_KEYS) delete process.env[key];
  const merged: Record<string, string | undefined> = { ...base, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache();
}

describe("storage configuration", () => {
  test("accepts per-bucket credentials", () => {
    withEnv({
      RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID: "orig-key",
      RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY: "orig-secret",
      RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID: "gen-key",
      RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY: "gen-secret",
    });
    const env = getEnv();
    expect(env.RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID).toBe("orig-key");
    expect(env.RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID).toBe("gen-key");
  });

  test("accepts a shared credential pair as a fallback", () => {
    withEnv({
      RAILWAY_BUCKET_ACCESS_KEY_ID: "shared-key",
      RAILWAY_BUCKET_SECRET_ACCESS_KEY: "shared-secret",
      RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID: undefined,
      RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID: undefined,
    });
    expect(() => getEnv()).not.toThrow();
  });

  test("rejects a bucket with no usable credentials", () => {
    // Railway scopes credentials per bucket, so a missing pair is a real
    // misconfiguration rather than something to paper over at runtime.
    withEnv({
      RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID: "orig-key",
      RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY: "orig-secret",
      RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID: undefined,
      RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY: undefined,
      RAILWAY_BUCKET_ACCESS_KEY_ID: undefined,
      RAILWAY_BUCKET_SECRET_ACCESS_KEY: undefined,
    });
    expect(() => getEnv()).toThrow(EnvValidationError);
    expect(() => getEnv()).toThrow(/GENERATED/);
  });

  test("defaults to virtual-host addressing", () => {
    withEnv({
      RAILWAY_BUCKET_ACCESS_KEY_ID: "k",
      RAILWAY_BUCKET_SECRET_ACCESS_KEY: "s",
      RAILWAY_BUCKET_FORCE_PATH_STYLE: undefined,
    });
    // Railway reports urlStyle: virtual-host; path style would sign URLs the
    // bucket rejects.
    expect(getEnv().RAILWAY_BUCKET_FORCE_PATH_STYLE).toBe(false);
  });

  test("path style can be opted into", () => {
    withEnv({
      RAILWAY_BUCKET_ACCESS_KEY_ID: "k",
      RAILWAY_BUCKET_SECRET_ACCESS_KEY: "s",
      RAILWAY_BUCKET_FORCE_PATH_STYLE: "true",
    });
    expect(getEnv().RAILWAY_BUCKET_FORCE_PATH_STYLE).toBe(true);
  });
});

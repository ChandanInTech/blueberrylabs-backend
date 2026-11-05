import { describe, expect, test } from "bun:test";
import { EnvValidationError, getEnv, resetEnvCache } from "../../src/config/env";

const base = {
  DATABASE_URL: "postgresql://app:app@localhost:5432/test",
  DEMO_SESSION_SECRET: "a".repeat(32),
  STORAGE_DRIVER: "filesystem",
};

function withEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...base, ...overrides };
}

describe("environment validation", () => {
  test("parses defaults", () => {
    const env = Object.assign({}, process.env, withEnv({}));
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    process.env = env as NodeJS.ProcessEnv;
    resetEnvCache();
    const parsed = getEnv();
    expect(parsed.PORT).toBe(3001);
    expect(parsed.MAX_IMAGE_SIZE_MB).toBe(25);
    expect(parsed.WORKER_CONCURRENCY).toBe(1);
    expect(parsed.ALLOWED_IMAGE_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  test("splits CSV values and trims whitespace", () => {
    process.env = Object.assign(
      {},
      process.env,
      withEnv({ ALLOWED_IMAGE_TYPES: " image/jpeg , image/png " }),
    );
    resetEnvCache();
    expect(getEnv().ALLOWED_IMAGE_TYPES).toEqual(["image/jpeg", "image/png"]);
  });

  test("rejects a short session secret", () => {
    process.env = Object.assign({}, process.env, withEnv({ DEMO_SESSION_SECRET: "short" }));
    resetEnvCache();
    expect(() => getEnv()).toThrow(EnvValidationError);
  });

  test("requires bucket credentials for the s3 driver", () => {
    process.env = Object.assign({}, process.env, withEnv({ STORAGE_DRIVER: "s3" }));
    resetEnvCache();
    expect(() => getEnv()).toThrow(/RAILWAY_BUCKET_ENDPOINT/);
  });

  test("coerces numeric strings", () => {
    process.env = Object.assign({}, process.env, withEnv({ PORT: "8080", MAX_IMAGE_PIXELS: "1000" }));
    resetEnvCache();
    const env = getEnv();
    expect(env.PORT).toBe(8080);
    expect(env.MAX_IMAGE_PIXELS).toBe(1000);
  });
});

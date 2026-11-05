import { z } from "zod";

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    );

const bool = (fallback: "true" | "false") =>
  z
    .enum(["true", "false"])
    .default(fallback)
    .transform((value) => value === "true");

const int = (defaultValue: number, min = 0) => z.coerce.number().int().min(min).default(defaultValue);

const positives = (...values: number[]) => {
  const invalid = values.filter((value) => value <= 0);
  if (invalid.length > 0) {
    throw new Error(`Expected positive numbers, received: ${invalid.join(", ")}`);
  }
};

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3001, 1),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  /** Set to "false" when the DB pool should not be created (unit tests). */
  DATABASE_ENABLED: bool("true"),
  DATABASE_POOL_MAX: int(10, 1),

  WEB_ORIGIN: z.string().min(1).default("http://localhost:3000"),
  API_PUBLIC_URL: z.string().min(1).default("http://localhost:3001"),

  DEMO_SESSION_SECRET: z.string().min(16, "DEMO_SESSION_SECRET must be at least 16 chars"),
  DEMO_SESSION_TTL_HOURS: int(24, 1),
  /** When true, cookies are marked Secure. Defaults to on in production. */
  COOKIE_SECURE: z.enum(["true", "false", "auto"]).default("auto"),
  /**
   * Cookie SameSite policy.
   *
   * `lax` is the safe default and works when the frontend and API share a
   * site. When they are on different registrable domains (for example
   * `*.vercel.app` calling `*.up.railway.app`), the browser treats every
   * request as cross-site and `lax` cookies are never sent — the session
   * silently disappears. `none` is required there, and browsers only accept
   * `SameSite=None` together with `Secure`.
   */
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  STORAGE_DRIVER: z.enum(["s3", "filesystem"]).default("s3"),
  STORAGE_FILESYSTEM_ROOT: z.string().default("./.storage"),

  RAILWAY_BUCKET_ENDPOINT: z.string().default(""),
  RAILWAY_BUCKET_REGION: z.string().default("auto"),
  /** Shared credentials, used when per-bucket credentials are not supplied. */
  RAILWAY_BUCKET_ACCESS_KEY_ID: z.string().default(""),
  RAILWAY_BUCKET_SECRET_ACCESS_KEY: z.string().default(""),
  /**
   * Railway Buckets issue credentials scoped to a single bucket, so each bucket
   * needs its own key pair. Falls back to the shared pair when unset.
   */
  RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID: z.string().default(""),
  RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY: z.string().default(""),
  RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID: z.string().default(""),
  RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY: z.string().default(""),
  /** Railway Buckets use virtual-host addressing; set true only for path-style endpoints. */
  RAILWAY_BUCKET_FORCE_PATH_STYLE: bool("false"),
  RAILWAY_BUCKET_ORIGINALS: z.string().default("media-originals"),
  RAILWAY_BUCKET_GENERATED: z.string().default("media-generated"),

  PRESIGNED_UPLOAD_TTL_SECONDS: int(600, 30),
  PRESIGNED_DOWNLOAD_TTL_SECONDS: int(300, 30),

  MAX_IMAGE_SIZE_MB: int(25, 1),
  MAX_IMAGE_PIXELS: int(40_000_000, 1),
  ALLOWED_IMAGE_TYPES: csv("image/jpeg,image/png,image/webp"),

  WORKER_ENABLED: bool("true"),
  WORKER_CONCURRENCY: int(1, 1),
  WORKER_POLL_INTERVAL_MS: int(750, 50),
  WORKER_IDLE_MAX_BACKOFF_MS: int(5_000, 100),
  WORKER_JOB_LEASE_SECONDS: int(300, 10),
  WORKER_JOB_TIMEOUT_SECONDS: int(120, 5),
  WORKER_MAX_ATTEMPTS: int(3, 1),
  WORKER_RETRY_BASE_SECONDS: int(5, 1),
  WORKER_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.25),
  WORKER_STALE_SWEEP_INTERVAL_MS: int(60_000, 1_000),

  RATE_LIMIT_DEMO_AUTH: int(10, 1),
  RATE_LIMIT_DEMO_AUTH_WINDOW_MINUTES: int(15, 1),
  RATE_LIMIT_UPLOAD_PER_MINUTE: int(10, 1),
  RATE_LIMIT_UPLOAD_COMPLETE_PER_MINUTE: int(10, 1),
  RATE_LIMIT_GENERATION_PER_MINUTE: int(3, 1),
  RATE_LIMIT_STATUS_PER_MINUTE: int(120, 1),
  RATE_LIMIT_DOWNLOAD_URL_PER_MINUTE: int(30, 1),
  RATE_LIMIT_GENERAL_PER_MINUTE: int(300, 1),

  MAX_CONCURRENT_GENERATIONS_PER_USER: int(2, 1),
  MAX_GENERATIONS_PER_USER_PER_DAY: int(20, 1),
  MAX_PENDING_UPLOADS_PER_USER: int(5, 1),

  IMAGE_JPEG_QUALITY: int(85, 1),
  /** Background colour composited under transparent sources when flattening to JPEG. */
  IMAGE_TRANSPARENT_BACKGROUND: z.string().default("#ffffff"),
  /** Keep PNG output (instead of JPEG) when the source has an alpha channel. */
  IMAGE_PRESERVE_TRANSPARENCY: bool("true"),

  SENTRY_DSN: z.string().default(""),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
  METRICS_ENABLED: bool("true"),

  /** Overrides the auto-generated instance id used for job leases. */
  INSTANCE_ID: z.string().default(""),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join("\n  - ")}`);
    this.name = "EnvValidationError";
  }
}

function parse(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  const env = result.data;
  positives(
    env.PORT,
    env.DEMO_SESSION_TTL_HOURS,
    env.PRESIGNED_UPLOAD_TTL_SECONDS,
    env.PRESIGNED_DOWNLOAD_TTL_SECONDS,
    env.MAX_IMAGE_SIZE_MB,
    env.WORKER_CONCURRENCY,
  );

  if (env.ALLOWED_IMAGE_TYPES.length === 0) {
    throw new EnvValidationError(["ALLOWED_IMAGE_TYPES: at least one MIME type is required"]);
  }

  if (env.STORAGE_DRIVER === "s3") {
    const missing: string[] = [];
    if (env.RAILWAY_BUCKET_ENDPOINT.trim() === "") {
      missing.push("RAILWAY_BUCKET_ENDPOINT: required when STORAGE_DRIVER=s3");
    }

    // Each bucket needs a usable key pair: either its own, or the shared one.
    const pairs = [
      [
        "ORIGINALS",
        env.RAILWAY_BUCKET_ORIGINALS_ACCESS_KEY_ID,
        env.RAILWAY_BUCKET_ORIGINALS_SECRET_ACCESS_KEY,
      ],
      [
        "GENERATED",
        env.RAILWAY_BUCKET_GENERATED_ACCESS_KEY_ID,
        env.RAILWAY_BUCKET_GENERATED_SECRET_ACCESS_KEY,
      ],
    ] as const;

    for (const [label, keyId, secret] of pairs) {
      const hasOwn = keyId.trim() !== "" && secret.trim() !== "";
      const hasShared =
        env.RAILWAY_BUCKET_ACCESS_KEY_ID.trim() !== "" && env.RAILWAY_BUCKET_SECRET_ACCESS_KEY.trim() !== "";
      if (!hasOwn && !hasShared) {
        missing.push(
          `RAILWAY_BUCKET_${label}_ACCESS_KEY_ID / RAILWAY_BUCKET_${label}_SECRET_ACCESS_KEY (or the shared RAILWAY_BUCKET_ACCESS_KEY_ID / RAILWAY_BUCKET_SECRET_ACCESS_KEY): required when STORAGE_DRIVER=s3`,
        );
      }
    }

    if (missing.length > 0) {
      throw new EnvValidationError(missing);
    }
  }

  return env;
}

let cached: Env | null = null;

/** Parsed, validated environment. Throws {@link EnvValidationError} on bad config. */
export function getEnv(): Env {
  cached ??= parse(process.env);
  return cached;
}

/** Clear the cache. Test-only. */
export function resetEnvCache(): void {
  cached = null;
}

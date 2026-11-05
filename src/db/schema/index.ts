import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull().default("DEMO"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const demo_sessions = pgTable(
  "demo_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the raw session token. The raw token never reaches the database. */
    tokenHash: text("token_hash").notNull(),
    /** SHA-256 of the CSRF token; the raw value lives only in a readable cookie. */
    csrfTokenHash: text("csrf_token_hash").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    revokedAt: timestamptz("revoked_at"),
  },
  (table) => [
    uniqueIndex("demo_sessions_token_hash_idx").on(table.tokenHash),
    index("demo_sessions_user_id_idx").on(table.userId),
    index("demo_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Access codes: the only way to obtain a token.
 *
 * The raw code is shown to the operator once and never stored — only its
 * SHA-256 hash is persisted, so a database leak does not yield usable codes.
 */
export const access_codes = pgTable(
  "access_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** SHA-256 of the normalised code. */
    codeHash: text("code_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Free-text note for the operator, e.g. who the code was issued to. */
    label: text("label"),
    expiresAt: timestamptz("expires_at").notNull(),
    /** Set when redeemed; a single-use code cannot be redeemed twice. */
    redeemedAt: timestamptz("redeemed_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("access_codes_code_hash_idx").on(table.codeHash),
    index("access_codes_user_id_idx").on(table.userId),
    index("access_codes_expires_at_idx").on(table.expiresAt),
  ],
);

/**
 * Issued tokens.
 *
 * A JWT cannot be withdrawn on its own, so every token carries a `jti` that
 * points at a row here. Logout sets `revoked_at`, and the auth middleware
 * rejects a token whose row is missing, revoked, or expired — which is what
 * makes "log out" take effect immediately instead of at token expiry.
 */
export const auth_sessions = pgTable(
  "auth_sessions",
  {
    /** Equals the JWT `jti`. */
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamptz("expires_at").notNull(),
    revokedAt: timestamptz("revoked_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("auth_sessions_user_id_idx").on(table.userId),
    index("auth_sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const assets = pgTable(
  "assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("IMAGE"),
    /** Display-only; never used to build an object key. */
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    width: integer("width"),
    height: integer("height"),
    bucket: text("bucket").notNull(),
    storageKey: text("storage_key").notNull(),
    uploadStatus: text("upload_status").notNull().default("PENDING"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    uploadedAt: timestamptz("uploaded_at"),
  },
  (table) => [
    index("assets_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("assets_upload_status_created_idx").on(table.uploadStatus, table.createdAt),
    uniqueIndex("assets_bucket_storage_key_idx").on(table.bucket, table.storageKey),
    check("assets_kind_check", sql`${table.kind} IN ('IMAGE')`),
    check("assets_upload_status_check", sql`${table.uploadStatus} IN ('PENDING', 'UPLOADED', 'FAILED')`),
    check("assets_size_bytes_check", sql`${table.sizeBytes} > 0`),
  ],
);

export const generations = pgTable(
  "generations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    inputAssetId: uuid("input_asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "restrict" }),
    outputAssetId: uuid("output_asset_id").references(() => assets.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    format: text("format").notNull(),
    status: text("status").notNull().default("QUEUED"),
    progress: integer("progress").notNull().default(0),
    currentStep: text("current_step"),
    message: text("message"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    idempotencyKey: text("idempotency_key"),
    /** Originating HTTP request id, for lifecycle correlation. */
    requestId: text("request_id"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    startedAt: timestamptz("started_at"),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    index("generations_user_created_idx").on(table.userId, table.createdAt.desc()),
    index("generations_status_created_idx").on(table.status, table.createdAt),
    index("generations_input_asset_idx").on(table.inputAssetId),
    uniqueIndex("generations_user_idempotency_key_idx")
      .on(table.userId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      "generations_status_check",
      sql`${table.status} IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')`,
    ),
    check("generations_progress_check", sql`${table.progress} BETWEEN 0 AND 100`),
    check("generations_platform_check", sql`${table.platform} IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE')`),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("QUEUED"),
    /** Higher runs first, per section 9.3 (`ORDER BY priority DESC`). */
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamptz("run_at").notNull().defaultNow(),
    lockedAt: timestamptz("locked_at"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    completedAt: timestamptz("completed_at"),
  },
  (table) => [
    index("jobs_claim_idx").on(table.status, table.runAt, table.priority.desc(), table.createdAt),
    index("jobs_locked_at_idx").on(table.lockedAt),
    check("jobs_status_check", sql`${table.status} IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')`),
    check("jobs_type_check", sql`${table.type} IN ('PROCESS_IMAGE')`),
    check("jobs_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export const rate_limit_buckets = pgTable("rate_limit_buckets", {
  /** Hashed principal + operation. Never a raw IP or user id. */
  key: text("key").primaryKey(),
  windowStart: timestamptz("window_start").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  expiresAt: timestamptz("expires_at").notNull(),
});

export const generation_events = pgTable(
  "generation_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => generations.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    progress: integer("progress"),
    message: text("message"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("generation_events_generation_idx").on(table.generationId, table.createdAt),
    check(
      "generation_events_type_check",
      sql`${table.eventType} IN ('QUEUED', 'PROCESSING', 'PROGRESS', 'COMPLETED', 'FAILED')`,
    ),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type DemoSessionRow = typeof demo_sessions.$inferSelect;
export type AccessCodeRow = typeof access_codes.$inferSelect;
export type AuthSessionRow = typeof auth_sessions.$inferSelect;
export type AssetRow = typeof assets.$inferSelect;
export type GenerationRow = typeof generations.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type GenerationEventRow = typeof generation_events.$inferSelect;

CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text DEFAULT 'IMAGE' NOT NULL,
	"original_filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"upload_status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone,
	CONSTRAINT "assets_kind_check" CHECK ("assets"."kind" IN ('IMAGE')),
	CONSTRAINT "assets_upload_status_check" CHECK ("assets"."upload_status" IN ('PENDING', 'UPLOADED', 'FAILED')),
	CONSTRAINT "assets_size_bytes_check" CHECK ("assets"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "demo_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generation_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"generation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"progress" integer,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_events_type_check" CHECK ("generation_events"."event_type" IN ('QUEUED', 'PROCESSING', 'PROGRESS', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE "generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"input_asset_id" uuid NOT NULL,
	"output_asset_id" uuid,
	"platform" text NOT NULL,
	"format" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"current_step" text,
	"message" text,
	"error_code" text,
	"error_message" text,
	"idempotency_key" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "generations_status_check" CHECK ("generations"."status" IN ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "generations_progress_check" CHECK ("generations"."progress" BETWEEN 0 AND 100),
	CONSTRAINT "generations_platform_check" CHECK ("generations"."platform" IN ('INSTAGRAM', 'TIKTOK', 'YOUTUBE'))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "jobs_type_check" CHECK ("jobs"."type" IN ('PROCESS_IMAGE')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text DEFAULT 'DEMO' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_sessions" ADD CONSTRAINT "demo_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_events" ADD CONSTRAINT "generation_events_generation_id_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_input_asset_id_assets_id_fk" FOREIGN KEY ("input_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generations" ADD CONSTRAINT "generations_output_asset_id_assets_id_fk" FOREIGN KEY ("output_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_user_created_idx" ON "assets" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "assets_upload_status_created_idx" ON "assets" USING btree ("upload_status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_bucket_storage_key_idx" ON "assets" USING btree ("bucket","storage_key");--> statement-breakpoint
CREATE UNIQUE INDEX "demo_sessions_token_hash_idx" ON "demo_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "demo_sessions_user_id_idx" ON "demo_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "demo_sessions_expires_at_idx" ON "demo_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "generation_events_generation_idx" ON "generation_events" USING btree ("generation_id","created_at");--> statement-breakpoint
CREATE INDEX "generations_user_created_idx" ON "generations" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "generations_status_created_idx" ON "generations" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "generations_input_asset_idx" ON "generations" USING btree ("input_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "generations_user_idempotency_key_idx" ON "generations" USING btree ("user_id","idempotency_key") WHERE "generations"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at","priority" DESC NULLS LAST,"created_at");--> statement-breakpoint
CREATE INDEX "jobs_locked_at_idx" ON "jobs" USING btree ("locked_at");
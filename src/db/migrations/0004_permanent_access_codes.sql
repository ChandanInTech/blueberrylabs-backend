-- Access codes become the permanent login credential: one per user, never
-- expiring, reusable (architecture section 5).
--
-- Hand-written rather than generated because the generated version would fail
-- on any database that already has two codes for one user, and because the
-- existing rows need converting, not just the schema.

-- 1. A permanent code has no expiry. Existing codes are converted below, so the
--    column must accept NULL first.
ALTER TABLE "access_codes" ALTER COLUMN "expires_at" DROP NOT NULL;
--> statement-breakpoint

-- 2. Collapse any duplicate codes down to the oldest one per user. Without this
--    the unique index in step 3 cannot be created. The oldest row is kept
--    because it is the one most likely to have been handed out already.
DELETE FROM "access_codes" a
USING "access_codes" b
WHERE a."user_id" = b."user_id"
  AND (a."created_at" > b."created_at" OR (a."created_at" = b."created_at" AND a."id" > b."id"));
--> statement-breakpoint

-- 3. One code per user, enforced by the database rather than by convention.
DROP INDEX IF EXISTS "access_codes_user_id_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "access_codes_user_id_idx" ON "access_codes" USING btree ("user_id");
--> statement-breakpoint

-- 4. Convert every existing code to a permanent one: no expiry, and clear the
--    single-use marker so a previously redeemed code works again. This is the
--    point of the change — a user's code is their login, forever.
UPDATE "access_codes"
SET "expires_at" = NULL,
    "redeemed_at" = NULL
WHERE "revoked_at" IS NULL;

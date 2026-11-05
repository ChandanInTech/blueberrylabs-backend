import { sql } from "drizzle-orm";
import { getEnv } from "../config/env";
import { getDb } from "../db/client";
import { increment } from "../observability/metrics";
import { rateLimitKey } from "../utils/crypto";
import { errors } from "../utils/errors";

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Stable operation name; also used in metric labels and logs. */
  operation: string;
  limit: number;
  windowSeconds: number;
  /** Which dimensions to count against. All listed dimensions must pass. */
  dimensions: Array<"user" | "ip">;
}

interface Principal {
  userId?: string;
  clientIp?: string;
}

/**
 * Atomic fixed-window limiter backed by the `consume_rate_limit` SQL function.
 *
 * Every listed dimension is consumed in the same decision: a shared demo
 * principal cannot be used to bypass IP limits, and IP limits cannot be used to
 * bypass per-user limits.
 */
export async function consume(rule: RateLimitRule, principal: Principal): Promise<RateLimitResult> {
  const dimensions = rule.dimensions.filter((dimension) =>
    dimension === "user" ? Boolean(principal.userId) : Boolean(principal.clientIp),
  );

  if (dimensions.length === 0) {
    // Unauthenticated and no trustworthy IP: nothing to key on. Fail closed for
    // security-sensitive rules, open for read-only fallbacks.
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetAt: new Date(Date.now() + rule.windowSeconds * 1000),
      retryAfterSeconds: 0,
    };
  }

  const db = getDb();
  let strictest: RateLimitResult | null = null;

  for (const dimension of dimensions) {
    const raw = dimension === "user" ? principal.userId : principal.clientIp;
    if (!raw) continue;

    const key = rateLimitKey(rule.operation, dimension, raw);
    const rows = await db.execute<{
      allowed: boolean;
      remaining: number;
      reset_at: Date | string;
    }>(sql`SELECT * FROM consume_rate_limit(${key}, ${rule.limit}, ${rule.windowSeconds})`);

    const row = rows[0];
    if (!row) continue;

    const resetAt = row.reset_at instanceof Date ? row.reset_at : new Date(row.reset_at);
    const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
    const result: RateLimitResult = {
      allowed: Boolean(row.allowed),
      limit: rule.limit,
      remaining: Number(row.remaining),
      resetAt,
      retryAfterSeconds,
    };

    if (!result.allowed) {
      increment("rate_limit_rejections_total", { operation: rule.operation });
      return result;
    }

    if (!strictest || result.remaining < strictest.remaining) strictest = result;
  }

  return (
    strictest ?? {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetAt: new Date(Date.now() + rule.windowSeconds * 1000),
      retryAfterSeconds: 0,
    }
  );
}

/** Throwing wrapper used by route handlers. */
export async function enforce(rule: RateLimitRule, principal: Principal): Promise<RateLimitResult> {
  const result = await consume(rule, principal);
  if (!result.allowed) {
    throw errors.rateLimit(
      result.retryAfterSeconds,
      `Too many requests for ${rule.operation.replaceAll(".", " ")}. Please try again in ${result.retryAfterSeconds}s.`,
    );
  }
  return result;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.retryAfterSeconds),
  };
}

/** The configured rule set. Limits are environment-configurable (section 13.1). */
export function rules() {
  const env = getEnv();
  return {
    demoAuth: {
      operation: "auth.login",
      limit: env.RATE_LIMIT_DEMO_AUTH,
      windowSeconds: env.RATE_LIMIT_DEMO_AUTH_WINDOW_MINUTES * 60,
      dimensions: ["ip"],
    },
    upload: {
      operation: "uploads.create",
      limit: env.RATE_LIMIT_UPLOAD_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user", "ip"],
    },
    uploadComplete: {
      operation: "uploads.complete",
      limit: env.RATE_LIMIT_UPLOAD_COMPLETE_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user"],
    },
    generation: {
      operation: "generations.create",
      limit: env.RATE_LIMIT_GENERATION_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user"],
    },
    status: {
      operation: "generations.status",
      limit: env.RATE_LIMIT_STATUS_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user"],
    },
    downloadUrl: {
      operation: "download.url",
      limit: env.RATE_LIMIT_DOWNLOAD_URL_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user"],
    },
    general: {
      operation: "general",
      limit: env.RATE_LIMIT_GENERAL_PER_MINUTE,
      windowSeconds: 60,
      dimensions: ["user", "ip"],
    },
  } satisfies Record<string, RateLimitRule>;
}

export type RuleName = keyof ReturnType<typeof rules>;

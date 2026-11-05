import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "../config/env";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Constant-time string comparison that never throws on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Hash a rate-limit dimension so raw IPs and user ids never land in the
 * database (architecture section 13.2).
 */
export function rateLimitKey(operation: string, dimension: string, value: string): string {
  return sha256(`${getEnv().DEMO_SESSION_SECRET}:${operation}:${dimension}:${value}`);
}

export const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

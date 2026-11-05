import { getEnv } from "../config/env";
import { errors } from "../utils/errors";

/**
 * Origin allow-list enforcement.
 *
 * Cookies are SameSite=Lax, which already blocks most cross-site state changes,
 * but we additionally validate `Origin` on every unsafe method. This is applied
 * globally in the composition root so no individual route can forget it.
 */

export const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function allowedOrigins(): Set<string> {
  const env = getEnv();
  const origins = new Set<string>();
  for (const entry of env.WEB_ORIGIN.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore malformed entries rather than failing to boot.
    }
  }
  return origins;
}

/**
 * A request with no `Origin` header (server-to-server, curl, a same-origin
 * navigation) passes: the browser is the only actor that can attach a forged
 * cross-site origin, and it always sends one on unsafe requests.
 */
export function isOriginAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;

  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    return false;
  }

  // The API's own origin is always acceptable (same-origin fetch and the local
  // storage adapter's presigned PUTs).
  if (host && normalized === `http://${host}`) return true;
  if (host && normalized === `https://${host}`) return true;

  return allowedOrigins().has(normalized);
}

export function assertSafeOrigin(method: string, origin: string | undefined, host: string | undefined): void {
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return;
  if (!isOriginAllowed(origin, host)) throw errors.invalidOrigin();
}

import type { ApiErrorBody } from "@social-resizer/contracts";
import { logger } from "../observability/logger";
import { AppError } from "../utils/errors";
import type { RequestContext } from "./request-context";

export interface ErrorResponse {
  status: number;
  body: ApiErrorBody;
  headers: Record<string, string>;
}

export const SAFE_INTERNAL_MESSAGE = "Something went wrong. Please try again.";

/**
 * Map any thrown value to the single public error shape (section 12.6).
 *
 * Internal exception details, stack traces and SQL errors never reach the
 * client: unknown errors collapse to a generic 500.
 */
export function toErrorResponse(error: unknown, ctx: RequestContext): ErrorResponse {
  const headers: Record<string, string> = { "X-Request-Id": ctx.requestId };

  if (error instanceof AppError) {
    const message = error.expose ? error.message : SAFE_INTERNAL_MESSAGE;
    const body: ApiErrorBody = {
      error: {
        code: error.code,
        message,
        requestId: ctx.requestId,
        ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
    };

    if (error.retryAfterSeconds !== undefined) {
      headers["Retry-After"] = String(error.retryAfterSeconds);
    }

    const level = error.status >= 500 ? "error" : "warn";
    ctx.log[level]("request.failed", {
      code: error.code,
      status: error.status,
      errorMessage: error.message,
    });

    return { status: error.status, body, headers };
  }

  const validation = asValidationError(error);
  if (validation) {
    ctx.log.warn("request.validation_failed", { errorMessage: validation });
    return {
      status: 400,
      body: {
        error: { code: "VALIDATION_ERROR", message: validation, requestId: ctx.requestId },
      },
      headers,
    };
  }

  logger.exception("request.unhandled_error", error, { requestId: ctx.requestId });
  return {
    status: 500,
    body: {
      error: { code: "INTERNAL_ERROR", message: SAFE_INTERNAL_MESSAGE, requestId: ctx.requestId },
    },
    headers,
  };
}

/** Elysia/TypeBox validation failures and JSON parse failures. */
function asValidationError(error: unknown): string | null {
  const candidate = error as {
    code?: string;
    name?: string;
    message?: string;
    type?: string;
    validator?: unknown;
    errors?: unknown;
  };
  if (!candidate || typeof candidate !== "object") return null;

  if (candidate.name === "ValidationError" || candidate.name === "TypeBoxError") {
    return sanitizeValidationMessage(candidate.message ?? "Invalid request payload.");
  }
  // Elysia's built-in VALIDATION error
  if (candidate.code === "VALIDATION") {
    const first = Array.isArray(candidate.errors) ? candidate.errors[0] : null;
    const schemaPath = (first as { schema?: { path?: string }; path?: string } | null)?.schema?.path;
    const summary = (first as { summary?: string } | null)?.summary;
    return sanitizeValidationMessage(
      [schemaPath?.replace(/^\//, ""), summary].filter(Boolean).join(": ") || "Invalid request payload.",
    );
  }
  if (candidate.code === "PARSE") {
    return "Request body could not be parsed as JSON.";
  }
  return null;
}

function sanitizeValidationMessage(message: string): string {
  // Strip absolute paths and schema internals; keep the human-readable part.
  return message
    .replace(/\s+at .*$/s, "")
    .replace(/\/[^\s]*\/src\//g, "")
    .slice(0, 300);
}

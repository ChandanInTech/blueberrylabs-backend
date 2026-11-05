/** Stable error codes returned by the API. */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INVALID_ORIGIN",
  "CSRF_TOKEN_INVALID",
  "RATE_LIMIT_EXCEEDED",
  "QUOTA_EXCEEDED",
  "CONCURRENCY_LIMIT_EXCEEDED",
  "TOO_MANY_PENDING_UPLOADS",
  "UNSUPPORTED_MEDIA_TYPE",
  "FILE_TOO_LARGE",
  "IMAGE_TOO_LARGE",
  "UPLOAD_NOT_FOUND",
  "UPLOAD_NOT_COMPLETE",
  "UPLOAD_VERIFICATION_FAILED",
  "IDEMPOTENCY_CONFLICT",
  "PRESET_NOT_SUPPORTED",
  "GENERATION_NOT_FOUND",
  "INVALID_STATE_TRANSITION",
  "PROCESSING_FAILED",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
  "NOT_READY",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    retryAfterSeconds?: number;
  };
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as ApiErrorBody).error === "object" &&
    (value as ApiErrorBody).error !== null &&
    typeof (value as ApiErrorBody).error.code === "string" &&
    typeof (value as ApiErrorBody).error.message === "string"
  );
}

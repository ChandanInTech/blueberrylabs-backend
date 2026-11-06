import type { ErrorCode } from "@social-resizer/contracts";

/**
 * An error that maps deterministically to an HTTP response.
 *
 * Anything else thrown inside a route is treated as an internal error and its
 * message is never sent to the client.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  /** Set when the message is safe to show a user verbatim. */
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    options: { retryAfterSeconds?: number; expose?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.expose = options.expose ?? true;
  }
}

export const errors = {
  unauthenticated: (message = "Please sign in to continue.") => new AppError("UNAUTHENTICATED", 401, message),
  forbidden: (message = "You do not have access to this resource.") =>
    new AppError("FORBIDDEN", 403, message),
  notFound: (message = "Resource not found.") => new AppError("NOT_FOUND", 404, message),
  validation: (message = "The request could not be validated.") =>
    new AppError("VALIDATION_ERROR", 400, message),
  invalidOrigin: () => new AppError("INVALID_ORIGIN", 403, "Request origin is not allowed."),
  rateLimit: (retryAfterSeconds: number, message = "Too many requests. Please try again shortly.") =>
    new AppError("RATE_LIMIT_EXCEEDED", 429, message, { retryAfterSeconds }),
  quota: (message = "You have reached the daily generation limit.") =>
    new AppError("QUOTA_EXCEEDED", 429, message),
  concurrency: (message = "Too many generations are already running. Please wait for one to finish.") =>
    new AppError("CONCURRENCY_LIMIT_EXCEEDED", 429, message),
  pendingUploads: (message = "Too many pending uploads. Finish or discard one first.") =>
    new AppError("TOO_MANY_PENDING_UPLOADS", 429, message),
  unsupportedMedia: (message = "That file type is not supported.") =>
    new AppError("UNSUPPORTED_MEDIA_TYPE", 415, message),
  fileTooLarge: (message = "That file is larger than the allowed limit.") =>
    new AppError("FILE_TOO_LARGE", 413, message),
  imageTooLarge: (message = "That image has too many pixels to process.") =>
    new AppError("IMAGE_TOO_LARGE", 422, message),
  uploadNotFound: () => new AppError("UPLOAD_NOT_FOUND", 404, "Upload not found."),
  uploadNotComplete: () => new AppError("UPLOAD_NOT_COMPLETE", 409, "The upload has not been verified yet."),
  uploadVerificationFailed: (message = "We could not verify the uploaded file.") =>
    new AppError("UPLOAD_VERIFICATION_FAILED", 422, message),
  idempotencyConflict: () =>
    new AppError(
      "IDEMPOTENCY_CONFLICT",
      409,
      "This idempotency key was already used for a different request.",
    ),
  presetNotSupported: (message = "That platform and format combination is not supported.") =>
    new AppError("PRESET_NOT_SUPPORTED", 400, message),
  generationNotFound: () => new AppError("GENERATION_NOT_FOUND", 404, "Generation not found."),
  invalidTransition: (message = "That state change is not allowed.") =>
    new AppError("INVALID_STATE_TRANSITION", 409, message),
  storage: (message = "The storage service is temporarily unavailable.", cause?: unknown) =>
    new AppError("STORAGE_ERROR", 503, message, { cause }),
  internal: (cause?: unknown) =>
    new AppError("INTERNAL_ERROR", 500, "Something went wrong. Please try again.", {
      expose: false,
      cause,
    }),
  notReady: (message = "The service is not ready yet.") => new AppError("NOT_READY", 503, message),
};

/**
 * Worker-side failure classification (architecture section 9.5).
 *
 * `retryable` errors are transient (storage/network/DB blips); `permanent`
 * errors mean the input itself is unusable and retrying cannot help.
 */
export class JobError extends Error {
  readonly retryable: boolean;
  readonly code: ErrorCode;
  readonly safeMessage: string;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable: boolean; safeMessage?: string; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JobError";
    this.code = code;
    this.retryable = options.retryable;
    this.safeMessage = options.safeMessage ?? "We could not process that image.";
  }
}

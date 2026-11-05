import { z } from "zod";
import { MIME_EXTENSIONS } from "../../utils/crypto";

export const ALLOWED_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

/** Extension -> the MIME types that extension is allowed to carry. */
const EXTENSION_MIME: Record<string, string[]> = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};

export interface UploadValidationContext {
  allowedTypes: string[];
  maxBytes: number;
}

export interface UploadMetadata {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export type UploadValidationResult =
  | { ok: true; extension: string }
  | { ok: false; code: "UNSUPPORTED_MEDIA_TYPE" | "FILE_TOO_LARGE" | "VALIDATION_ERROR"; message: string };

export const uploadRequestSchema = z
  .object({
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().trim().min(1).max(100),
    sizeBytes: z.number().int().positive(),
  })
  .strict();

/**
 * Validate upload metadata before a presigned URL is issued.
 *
 * Both the declared MIME type and the filename extension are checked, and the
 * two must agree, so `evil.exe` cannot masquerade as `image/png`. The real
 * bytes are validated again by Sharp in the worker.
 */
export function validateUploadMetadata(
  input: UploadMetadata,
  context: UploadValidationContext,
): UploadValidationResult {
  const dot = input.filename.lastIndexOf(".");
  if (dot <= 0 || dot === input.filename.length - 1) {
    return { ok: false, code: "UNSUPPORTED_MEDIA_TYPE", message: "That file has no usable extension." };
  }

  const extension = input.filename.slice(dot + 1).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: `Only ${context.allowedTypes.map(describeType).join(", ")} images are supported.`,
    };
  }

  const normalizedType = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!context.allowedTypes.includes(normalizedType)) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: `Only ${context.allowedTypes.map(describeType).join(", ")} images are supported.`,
    };
  }

  const expected = EXTENSION_MIME[extension];
  // biome-ignore lint/complexity/useOptionalChain: explicit null guard, not a chain
  if (!expected || !expected.includes(normalizedType)) {
    return {
      ok: false,
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "The file extension does not match its content type.",
    };
  }

  if (input.sizeBytes > context.maxBytes) {
    return {
      ok: false,
      code: "FILE_TOO_LARGE",
      message: `That file is ${formatBytes(input.sizeBytes)}; the limit is ${formatBytes(context.maxBytes)}.`,
    };
  }

  if (input.sizeBytes <= 0) {
    return { ok: false, code: "VALIDATION_ERROR", message: "The file appears to be empty." };
  }

  return { ok: true, extension: MIME_EXTENSIONS[normalizedType] ?? extension };
}

export function extensionFor(contentType: string): string | null {
  return MIME_EXTENSIONS[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] ?? null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describeType(mime: string): string {
  if (mime === "image/jpeg") return "JPEG";
  if (mime === "image/png") return "PNG";
  if (mime === "image/webp") return "WebP";
  return mime;
}

/** Strip any path components from a user-supplied filename. Display only. */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  return base.replace(/[^\w.\-() ]+/g, "_").slice(0, 200) || "image";
}

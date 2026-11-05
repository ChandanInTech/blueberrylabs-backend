import type { Preset } from "@social-resizer/contracts";
import sharp from "sharp";
import { getEnv } from "../../config/env";
import { observe } from "../../observability/metrics";
import { errors, JobError } from "../../utils/errors";

export interface ProcessedImage {
  body: Uint8Array;
  mimeType: string;
  extension: string;
  width: number;
  height: number;
  /** True when a transparent source was flattened onto a solid background. */
  flattened: boolean;
}

export interface SourceInspection {
  width: number;
  height: number;
  format: string | null;
  hasAlpha: boolean;
}

/**
 * Inspect a source image and enforce pixel limits before any real work happens.
 * This is the decompression-bomb guard from section 6.6.
 */
export async function inspectSource(buffer: Uint8Array): Promise<SourceInspection> {
  const env = getEnv();
  try {
    const metadata = await sharp(buffer, {
      failOn: "error",
      limitInputPixels: env.MAX_IMAGE_PIXELS,
      // Only read headers, not pixels.
      sequentialRead: true,
    }).metadata();

    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (width === 0 || height === 0) {
      throw new JobError("PROCESSING_FAILED", "Image has no dimensions", {
        retryable: false,
        safeMessage: "That file does not look like a valid image.",
      });
    }

    if (width * height > env.MAX_IMAGE_PIXELS) {
      throw new JobError("IMAGE_TOO_LARGE", `Image is ${width}x${height}`, {
        retryable: false,
        safeMessage: `That image is larger than the ${Math.round(env.MAX_IMAGE_PIXELS / 1_000_000)} megapixel limit.`,
      });
    }

    return {
      width,
      height,
      format: metadata.format ?? null,
      hasAlpha: Boolean(metadata.hasAlpha),
    };
  } catch (cause) {
    if (cause instanceof JobError) throw cause;

    // Sharp enforces `limitInputPixels` itself and throws before the explicit
    // dimension check above. Surface that as the specific, user-actionable
    // error instead of a generic decode failure.
    if (isPixelLimitError(cause)) {
      throw new JobError("IMAGE_TOO_LARGE", "Image exceeds the configured pixel limit", {
        retryable: false,
        safeMessage: `That image is larger than the ${Math.round(getEnv().MAX_IMAGE_PIXELS / 1_000_000)} megapixel limit.`,
        cause,
      });
    }

    throw new JobError("PROCESSING_FAILED", "Could not decode the source image", {
      retryable: false,
      safeMessage: "That file could not be read as an image.",
      cause,
    });
  }
}

/** Sharp reports this as a plain Error with a stable message prefix. */
function isPixelLimitError(cause: unknown): boolean {
  return cause instanceof Error && /pixel limit/i.test(cause.message);
}

/** Sharp options that cap input pixels for every decode. */
export function sharpOptions() {
  return {
    failOn: "error" as const,
    limitInputPixels: getEnv().MAX_IMAGE_PIXELS,
  };
}

/**
 * Resize/crop to the preset's exact dimensions using `fit: cover` and centre
 * positioning, so nothing is stretched.
 *
 * Output format:
 * - transparent sources keep PNG when `IMAGE_PRESERVE_TRANSPARENCY` is on;
 * - everything else is normalised to JPEG at the configured quality, with any
 *   alpha flattened onto a configured background colour instead of being
 *   silently discarded.
 */
export async function processImage(
  buffer: Uint8Array,
  preset: Preset,
  source: SourceInspection,
): Promise<ProcessedImage> {
  const env = getEnv();
  const started = performance.now();
  const keepAlpha = source.hasAlpha && env.IMAGE_PRESERVE_TRANSPARENCY;

  try {
    let pipeline = sharp(buffer, sharpOptions())
      // Honour EXIF orientation before cropping, so portrait phone photos are
      // not silently rotated.
      .rotate()
      .resize(preset.width, preset.height, { fit: "cover", position: "centre" });

    if (!keepAlpha) {
      pipeline = pipeline.flatten({ background: env.IMAGE_TRANSPARENT_BACKGROUND });
    }

    const output = keepAlpha
      ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
      : await pipeline
          .jpeg({ quality: env.IMAGE_JPEG_QUALITY, mozjpeg: true, chromaSubsampling: "4:4:4" })
          .toBuffer();

    const mimeType = keepAlpha ? "image/png" : "image/jpeg";
    const extension = keepAlpha ? "png" : "jpg";

    observe("image_processing_duration_seconds", (performance.now() - started) / 1000, {
      platform: preset.platform,
    });

    return {
      body: new Uint8Array(output),
      mimeType,
      extension,
      width: preset.width,
      height: preset.height,
      flattened: source.hasAlpha && !keepAlpha,
    };
  } catch (cause) {
    throw new JobError("PROCESSING_FAILED", "Sharp failed to process the image", {
      retryable: false,
      safeMessage: "We could not resize that image.",
      cause,
    });
  }
}

/** Strip metadata (default in Sharp) and expose nothing else. */
export function describeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof JobError) {
    return { code: error.code, message: error.safeMessage, retryable: error.retryable };
  }
  if (error instanceof Error && (error as Error & { status?: number }).status === 503) {
    return { code: "STORAGE_ERROR", message: "Storage was temporarily unavailable.", retryable: true };
  }
  return { code: "PROCESSING_FAILED", message: "We could not process that image.", retryable: true };
}

export { errors };

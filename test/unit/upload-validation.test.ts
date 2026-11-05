import { describe, expect, test } from "bun:test";
import { sanitizeFilename, validateUploadMetadata } from "../../src/modules/uploads/validation";

const ctx = {
  allowedTypes: ["image/jpeg", "image/png", "image/webp"],
  maxBytes: 25 * 1024 * 1024,
};

describe("upload metadata validation", () => {
  test("accepts a matching png", () => {
    const result = validateUploadMetadata(
      { filename: "photo.png", contentType: "image/png", sizeBytes: 1024 },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  test("accepts a content type with parameters", () => {
    const result = validateUploadMetadata(
      { filename: "photo.jpg", contentType: "image/jpeg; charset=binary", sizeBytes: 10 },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  test("rejects a disallowed mime type", () => {
    const result = validateUploadMetadata(
      { filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 10 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  test("rejects an extension that does not match the mime type", () => {
    const result = validateUploadMetadata(
      { filename: "evil.exe", contentType: "image/png", sizeBytes: 10 },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects a png named .jpg", () => {
    const result = validateUploadMetadata(
      { filename: "photo.jpg", contentType: "image/png", sizeBytes: 10 },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects files over the byte limit", () => {
    const result = validateUploadMetadata(
      { filename: "big.png", contentType: "image/png", sizeBytes: 26 * 1024 * 1024 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("FILE_TOO_LARGE");
  });

  test("rejects a file with no extension", () => {
    const result = validateUploadMetadata(
      { filename: "photo", contentType: "image/png", sizeBytes: 10 },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects zero-byte files", () => {
    const result = validateUploadMetadata(
      { filename: "empty.png", contentType: "image/png", sizeBytes: 0 },
      ctx,
    );
    expect(result.ok).toBe(false);
  });

  test("strips path traversal out of the display filename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\pic.png")).toBe("pic.png");
    expect(sanitizeFilename("my photo!.png")).toBe("my photo_.png");
  });
});

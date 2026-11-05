import { beforeAll, describe, expect, test } from "bun:test";
import { findPreset, PRESETS } from "@social-resizer/contracts";
import { inspectSource, processImage } from "../../src/services/image/sharp-processor";
import { imageMetadata, makeImage } from "../fixtures";

// The processor reads env for limits; give it a valid, self-contained config.
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://app:app@localhost:5432/test";
  process.env.JWT_SECRET ??= "a".repeat(32);
  process.env.STORAGE_DRIVER ??= "filesystem";
});

describe("sharp processor", () => {
  test("produces the exact target dimensions for every preset", async () => {
    const source = await makeImage(400, 300, { format: "jpeg" });
    const inspection = await inspectSource(source);

    for (const preset of PRESETS) {
      const presetRef = findPreset(preset.platform, preset.format);
      expect(presetRef).toBeDefined();
      const output = await processImage(source, presetRef!, inspection);

      const meta = await imageMetadata(output.body);
      expect(meta.width).toBe(preset.width);
      expect(meta.height).toBe(preset.height);
      expect(output.width).toBe(preset.width);
      expect(output.height).toBe(preset.height);
    }
  }, 30_000);

  test("normalises opaque sources to jpeg", async () => {
    const source = await makeImage(300, 300, { format: "png" });
    const inspection = await inspectSource(source);
    expect(inspection.hasAlpha).toBe(false);

    const output = await processImage(source, findPreset("INSTAGRAM", "SQUARE")!, inspection);
    expect(output.mimeType).toBe("image/jpeg");
    expect(output.extension).toBe("jpg");
    expect((await imageMetadata(output.body)).format).toBe("jpeg");
  });

  test("preserves transparency as png when the source has alpha", async () => {
    const source = await makeImage(300, 300, { format: "png", alpha: true });
    const inspection = await inspectSource(source);
    expect(inspection.hasAlpha).toBe(true);

    const output = await processImage(source, findPreset("INSTAGRAM", "STORY")!, inspection);
    expect(output.mimeType).toBe("image/png");
    expect(output.extension).toBe("png");
    expect(output.flattened).toBe(false);
    const meta = await imageMetadata(output.body);
    expect(meta.hasAlpha).toBe(true);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1920);
  }, 30_000);

  test("crops with cover rather than stretching", async () => {
    // A 1000x100 source cropped to 1:1 must not squash the image: the aspect
    // ratio change comes from centre cropping, so the output is square.
    const source = await makeImage(1000, 100);
    const inspection = await inspectSource(source);
    const output = await processImage(source, findPreset("INSTAGRAM", "SQUARE")!, inspection);
    const meta = await imageMetadata(output.body);
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1080);
  });

  test("rejects images above the pixel limit", async () => {
    const { resetEnvCache } = await import("../../src/config/env");
    const previous = process.env.MAX_IMAGE_PIXELS;
    process.env.MAX_IMAGE_PIXELS = "1000";
    resetEnvCache();

    try {
      const source = await makeImage(200, 200);
      await expect(inspectSource(source)).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    } finally {
      // `process.env.X = undefined` would store the string "undefined".
      if (previous === undefined) delete process.env.MAX_IMAGE_PIXELS;
      else process.env.MAX_IMAGE_PIXELS = previous;
      resetEnvCache();
    }
  });

  test("rejects bytes that are not an image", async () => {
    const notAnImage = new Uint8Array(Buffer.from("this is definitely not an image"));
    await expect(inspectSource(notAnImage)).rejects.toMatchObject({ code: "PROCESSING_FAILED" });
  });

  test("strips metadata from the output", async () => {
    const source = await makeImage(200, 200);
    const inspection = await inspectSource(source);
    const output = await processImage(source, findPreset("YOUTUBE", "THUMBNAIL")!, inspection);
    const meta = await imageMetadata(output.body);
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
  });
});

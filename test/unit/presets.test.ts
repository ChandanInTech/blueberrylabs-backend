import { describe, expect, test } from "bun:test";
import {
  findPreset,
  formatsForPlatform,
  isFormat,
  isPlatform,
  PRESETS,
  presetKey,
} from "@social-resizer/contracts";

describe("preset registry", () => {
  test("contains exactly the five MVP presets", () => {
    expect(PRESETS).toHaveLength(5);
  });

  test("matches the documented dimensions", () => {
    const cases: Array<[string, string, number, number]> = [
      ["INSTAGRAM", "SQUARE", 1080, 1080],
      ["INSTAGRAM", "PORTRAIT", 1080, 1350],
      ["INSTAGRAM", "STORY", 1080, 1920],
      ["TIKTOK", "COVER", 1080, 1920],
      ["YOUTUBE", "THUMBNAIL", 1280, 720],
    ];
    for (const [platform, format, width, height] of cases) {
      const preset = findPreset(platform, format);
      expect(preset).toBeDefined();
      expect(preset?.width).toBe(width);
      expect(preset?.height).toBe(height);
    }
  });

  test("rejects unsupported platform/format pairs", () => {
    expect(findPreset("INSTAGRAM", "THUMBNAIL")).toBeUndefined();
    expect(findPreset("TIKTOK", "SQUARE")).toBeUndefined();
    expect(findPreset("MYSPACE", "SQUARE")).toBeUndefined();
  });

  test("validates enum guards", () => {
    expect(isPlatform("INSTAGRAM")).toBe(true);
    expect(isPlatform("instagram")).toBe(false);
    expect(isPlatform(123)).toBe(false);
    expect(isFormat("THUMBNAIL")).toBe(true);
    expect(isFormat("thumbnail")).toBe(false);
  });

  test("groups formats by platform", () => {
    expect(formatsForPlatform("INSTAGRAM").map((p) => p.format)).toEqual(["SQUARE", "PORTRAIT", "STORY"]);
    expect(formatsForPlatform("TIKTOK").map((p) => p.format)).toEqual(["COVER"]);
    expect(formatsForPlatform("YOUTUBE").map((p) => p.format)).toEqual(["THUMBNAIL"]);
  });

  test("aspect ratios match the documentation", () => {
    expect(findPreset("INSTAGRAM", "SQUARE")?.aspectRatio).toBe("1:1");
    expect(findPreset("INSTAGRAM", "PORTRAIT")?.aspectRatio).toBe("4:5");
    expect(findPreset("INSTAGRAM", "STORY")?.aspectRatio).toBe("9:16");
    expect(findPreset("TIKTOK", "COVER")?.aspectRatio).toBe("9:16");
    expect(findPreset("YOUTUBE", "THUMBNAIL")?.aspectRatio).toBe("16:9");
  });

  test("keys are stable", () => {
    expect(presetKey("INSTAGRAM", "SQUARE")).toBe("INSTAGRAM:SQUARE");
  });
});

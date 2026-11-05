/**
 * Canonical platform/format preset registry.
 *
 * The backend is authoritative for these values and validates every
 * selection against them; the frontend only renders them.
 */

export const PLATFORMS = ["INSTAGRAM", "TIKTOK", "YOUTUBE"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const FORMATS = ["SQUARE", "PORTRAIT", "STORY", "COVER", "THUMBNAIL"] as const;
export type Format = (typeof FORMATS)[number];

/** Preset registry as required by the architecture document, section 7.1. */
export const IMAGE_PRESETS = {
  instagram: {
    square: { width: 1080, height: 1080 },
    portrait: { width: 1080, height: 1350 },
    story: { width: 1080, height: 1920 },
  },
  tiktok: {
    cover: { width: 1080, height: 1920 },
  },
  youtube: {
    thumbnail: { width: 1280, height: 720 },
  },
} as const;

export interface Preset {
  readonly platform: Platform;
  readonly format: Format;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly aspectRatio: string;
}

/**
 * Flat, API-facing preset list. Derived from {@link IMAGE_PRESETS} so the
 * two can never drift apart.
 */
export const PRESETS: readonly Preset[] = [
  {
    platform: "INSTAGRAM",
    format: "SQUARE",
    label: "Instagram Square post",
    width: 1080,
    height: 1080,
    aspectRatio: "1:1",
  },
  {
    platform: "INSTAGRAM",
    format: "PORTRAIT",
    label: "Instagram Portrait post",
    width: 1080,
    height: 1350,
    aspectRatio: "4:5",
  },
  {
    platform: "INSTAGRAM",
    format: "STORY",
    label: "Instagram Story",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
  },
  {
    platform: "TIKTOK",
    format: "COVER",
    label: "TikTok Cover",
    width: 1080,
    height: 1920,
    aspectRatio: "9:16",
  },
  {
    platform: "YOUTUBE",
    format: "THUMBNAIL",
    label: "YouTube Thumbnail",
    width: 1280,
    height: 720,
    aspectRatio: "16:9",
  },
];

/** Every platform/format pair the API accepts, as a lookup table. */
export const PRESET_LOOKUP: ReadonlyMap<string, Preset> = new Map(
  PRESETS.map((preset) => [presetKey(preset.platform, preset.format), preset]),
);

export function presetKey(platform: Platform, format: Format): string {
  return `${platform}:${format}`;
}

/** Resolve a preset, or `undefined` when the pair is not supported. */
export function findPreset(platform: string, format: string): Preset | undefined {
  return PRESET_LOOKUP.get(`${platform}:${format}`);
}

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value);
}

/** Formats offered for a platform, in registry order. */
export function formatsForPlatform(platform: Platform): readonly Preset[] {
  return PRESETS.filter((preset) => preset.platform === platform);
}

import sharp from "sharp";

/** Build a synthetic source image in memory: no binary fixtures in git. */
export async function makeImage(
  width: number,
  height: number,
  options: { format?: "jpeg" | "png" | "webp"; alpha?: boolean } = {},
): Promise<Uint8Array> {
  const { format = "jpeg", alpha = false } = options;

  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      raw[index] = Math.round((x / width) * 255);
      raw[index + 1] = Math.round((y / height) * 255);
      raw[index + 2] = 128;
      if (alpha) raw[index + 3] = x < width / 2 ? 255 : 0;
    }
  }

  let pipeline = sharp(raw, { raw: { width, height, channels } });
  if (format === "png") pipeline = pipeline.png();
  else if (format === "webp") pipeline = pipeline.webp();
  else pipeline = pipeline.jpeg({ quality: 90 });

  return new Uint8Array(await pipeline.toBuffer());
}

export async function imageMetadata(bytes: Uint8Array) {
  return sharp(bytes).metadata();
}

import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";

export async function buildModelTrafficHarness(dir) {
  await build({
    entryPoints: ["src/main/model-images.ts"],
    outfile: join(dir, "model-images.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
}

export async function validateModelTraffic(application) {
  const result = await application.evaluate(({ nativeImage }) => {
    const encode = global.ModelImageHarness.optimizeModelImage;
    const width = 1280;
    const height = 720;
    const bitmap = Buffer.alloc(width * height * 4);
    let seed = 71;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const offset = (y * width + x) * 4;
        const light = 30 + Math.round((180 * x) / width) + (seed >>> 28);
        bitmap[offset] = bitmap[offset + 1] = bitmap[offset + 2] = light;
        bitmap[offset + 3] = 255;
      }
    const original = nativeImage.createFromBitmap(bitmap, { width, height });
    const png = original.toDataURL();
    const optimized = encode(png);
    const decoded = nativeImage.createFromDataURL(optimized);
    const decodedPixels = decoded.toBitmap();
    let error = 0;
    for (let i = 0; i < bitmap.length; i += 4) error += Math.abs(bitmap[i] - decodedPixels[i]);
    bitmap[3] = 80;
    const alpha = nativeImage.createFromBitmap(bitmap, { width, height });
    const alphaOutput = encode(alpha.toDataURL());
    const transparentPreserved = nativeImage
      .createFromDataURL(alphaOutput)
      .toBitmap()
      .equals(alpha.toBitmap());
    const small = nativeImage
      .createFromBitmap(Buffer.from([0, 0, 0, 255]), { width: 1, height: 1 })
      .toDataURL();
    let refused = false;
    try {
      encode("data:image/png;base64,SYNTHETIC_PRIVATE_PIXELS");
    } catch (error) {
      refused = !error.message.includes("SYNTHETIC_PRIVATE_PIXELS");
    }
    const flatPixels = Buffer.alloc(width * height * 4, 255);
    const diagram = nativeImage.createFromBitmap(flatPixels, { width, height }).toDataURL();
    return {
      png,
      optimized,
      before: Buffer.byteLength(png),
      after: Buffer.byteLength(optimized),
      size: decoded.getSize(),
      jpeg: optimized.startsWith("data:image/jpeg;"),
      meanError: error / (width * height),
      transparentPreserved,
      alphaPng: alphaOutput.startsWith("data:image/png;"),
      small: encode(small) === small,
      jpegUnchanged: encode(optimized) === optimized,
      diagram: encode(diagram) === diagram,
      refused,
      recovered: encode(png) === optimized,
    };
  });
  assert.deepEqual(result.size, { width: 1280, height: 720 });
  for (const key of [
    "jpeg",
    "transparentPreserved",
    "alphaPng",
    "small",
    "jpegUnchanged",
    "diagram",
    "refused",
    "recovered",
  ])
    assert.equal(result[key], true, key);
  assert.ok(result.meanError < 8, "Synthetic grayscale compression must limit average pixel error");
  assert.ok(
    result.after < result.before * 0.5,
    "Photographic PNG fixture must shrink by at least 50%",
  );
  console.log(
    `Imagem sintética 1280×720: ${result.before} → ${result.after} bytes de data URL; dimensões/transparência e recuperação conferidas (não mede TLS total).`,
  );
  return { png: result.png, optimized: result.optimized };
}

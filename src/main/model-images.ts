import { nativeImage } from "electron";

/** No resize: desktop coordinates and small text retain their original geometry. */
export function optimizeModelImage(dataUrl: string): string {
  try {
    if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new Error();
    const image = nativeImage.createFromDataURL(dataUrl);
    const size = image.getSize();
    if (image.isEmpty() || size.width > 8192 || size.height > 8192) throw new Error();
    // Keep small images and already compressed JPEGs; avoid repeated lossy encoding.
    if (dataUrl.startsWith("data:image/jpeg;") || dataUrl.length < 128 * 1024) return dataUrl;
    const png = `data:image/png;base64,${image.toPNG().toString("base64")}`;
    let best = png.length < dataUrl.length ? png : dataUrl;
    const bitmap = image.toBitmap();
    // JPEG has no alpha channel. Keep transparency, including translucent edges.
    for (let offset = 3; offset < bitmap.length; offset += 4)
      if (bitmap[offset] !== 255) return best;
    const jpeg = `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
    // Text/diagrams usually win with PNG. Use JPEG only for a substantial reduction.
    if (jpeg.length < best.length * 0.8) best = jpeg;
    return best;
  } catch {
    // Native decoder failures must never expose pixels, base64 or paths.
    throw new Error("Não foi possível otimizar a imagem. Tente capturar ou colar novamente.");
  }
}

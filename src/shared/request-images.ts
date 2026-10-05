import { z } from "zod";
import type { RequestImage } from "./types";

export const maxRequestImages = 4;
export const maxRequestImageBytes = 4 * 1024 * 1024;
export const maxRequestImagePixels = 20_000_000;
export const maxRequestImageDimension = 8192;
export const maxImageDataUrlLength = Math.ceil(maxRequestImageBytes / 3) * 4 + 32;

export function requestImageBytes(image: RequestImage): number {
  const base64 = image.dataUrl.slice(image.dataUrl.indexOf(",") + 1);
  return (base64.length / 4) * 3 - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
}

function imageIssue(dataUrl: string): string | null {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (
    !/^data:image\/(png|jpeg);base64,/.test(dataUrl) ||
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
  )
    return "Cole uma imagem PNG ou JPEG válida.";
  if (requestImageBytes({ dataUrl }) > maxRequestImageBytes)
    return "As imagens devem somar no máximo 4 MB por mensagem.";
  const bytes = atob(base64);
  const byte = (offset: number) => bytes.charCodeAt(offset);
  let width = 0;
  let height = 0;
  if (dataUrl.startsWith("data:image/png;")) {
    if (
      bytes.length < 33 ||
      bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
      bytes.slice(12, 16) !== "IHDR"
    )
      return "Imagem PNG inválida.";
    const uint32 = (offset: number) =>
      byte(offset) * 2 ** 24 +
      byte(offset + 1) * 2 ** 16 +
      byte(offset + 2) * 256 +
      byte(offset + 3);
    if (uint32(8) !== 13) return "Imagem PNG inválida.";
    width = uint32(16);
    height = uint32(20);
  } else {
    if (byte(0) !== 255 || byte(1) !== 216) return "Imagem JPEG inválida.";
    let offset = 2;
    while (offset + 3 < bytes.length) {
      if (byte(offset++) !== 255) break;
      while (byte(offset) === 255) offset++;
      const marker = byte(offset++);
      if (marker === 217 || marker === 218) break;
      const length = byte(offset) * 256 + byte(offset + 1);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) break;
        height = byte(offset + 3) * 256 + byte(offset + 4);
        width = byte(offset + 5) * 256 + byte(offset + 6);
        break;
      }
      offset += length;
    }
  }
  if (!width || !height) return "Imagem inválida ou incompleta.";
  if (
    width > maxRequestImageDimension ||
    height > maxRequestImageDimension ||
    width * height > maxRequestImagePixels
  )
    return "Imagem muito grande: limite de 8192 pixels por lado e 20 megapixels.";
  return null;
}

export const requestImageSchema = z
  .object({
    dataUrl: z
      .string()
      .max(maxImageDataUrlLength, "As imagens devem somar no máximo 4 MB por mensagem.")
      .superRefine((dataUrl, context) => {
        if (dataUrl.length > maxImageDataUrlLength) return;
        const issue = imageIssue(dataUrl);
        if (issue) context.addIssue({ code: "custom", message: issue });
      }),
  })
  .strict();

export const requestImagesSchema = z
  .array(requestImageSchema)
  .max(maxRequestImages, "Envie no máximo 4 imagens por mensagem.")
  .superRefine((images, context) => {
    if (images.reduce((total, image) => total + requestImageBytes(image), 0) > maxRequestImageBytes)
      context.addIssue({
        code: "custom",
        message: "As imagens devem somar no máximo 4 MB por mensagem.",
      });
  });

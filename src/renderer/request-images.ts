import { requestImageSchema, maxRequestImageBytes } from "../shared/request-images";
import type { RequestImage } from "../shared/types";

export async function readPastedImage(file: File): Promise<RequestImage> {
  if (!["image/png", "image/jpeg"].includes(file.type))
    throw new Error("Cole uma imagem PNG ou JPEG. Outros formatos não são aceitos.");
  if (file.size > maxRequestImageBytes)
    throw new Error("As imagens devem somar no máximo 4 MB por mensagem.");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reader.onabort = () =>
      reject(new Error("Não foi possível ler a imagem colada."));
    reader.readAsDataURL(file);
  });
  const result = requestImageSchema.safeParse({ dataUrl });
  if (!result.success) throw new Error(result.error.issues[0].message);
  await new Promise<void>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Imagem inválida ou incompleta. Cole outra imagem."));
    image.src = dataUrl;
  });
  return result.data;
}

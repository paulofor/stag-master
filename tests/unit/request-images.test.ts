import { describe, expect, it } from "vitest";
import { actionSchema } from "../../src/shared/validation";
import {
  requestImageSchema,
  requestImageBytes,
  maxRequestImageBytes,
} from "../../src/shared/request-images";
import fixture from "../fixtures/request-image.json";

describe("anexos raster limitados", () => {
  const image = { dataUrl: fixture.dataUrl };
  it("aceita PNG sintético com texto ou sozinho e preserva mensagens antigas", () => {
    expect(
      actionSchema.parse({ type: "send", text: "  tela do sistema  ", images: [image] }),
    ).toMatchObject({ text: "tela do sistema", images: [image] });
    expect(actionSchema.parse({ type: "send", text: "", images: [image] })).toMatchObject({
      text: "",
      images: [image],
    });
    expect(actionSchema.parse({ type: "send", text: "texto" })).toEqual({
      type: "send",
      text: "texto",
    });
    expect(requestImageBytes(image)).toBe(
      Buffer.from(fixture.dataUrl.split(",")[1], "base64").length,
    );
  });
  it.each([
    "https://example.invalid/image.png",
    "file:///C:/image.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/gif;base64,R0lGODlh",
    "data:image/png;base64,%%%",
    "data:image/png;base64,AAAA",
    "data:image/png;base64,",
    fixture.dataUrl.replace("png", "jpeg"),
  ])("recusa endereço, formato, bytes ou MIME inválidos sem ecoar conteúdo (%#)", (dataUrl) => {
    const parsed = requestImageSchema.safeParse({ dataUrl });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).not.toContain(dataUrl);
  });
  it("recusa vazio, campos arbitrários, quantidade, volume e dimensões antes da decodificação", () => {
    for (const action of [
      { type: "send", text: " " },
      { type: "send", text: "", images: [] },
      { type: "send", text: "texto", images: [{ ...image, path: "private" }] },
      { type: "send", text: "texto", images: Array.from({ length: 5 }, () => image) },
    ])
      expect(actionSchema.safeParse(action).success).toBe(false);
    const pixels = Buffer.from(image.dataUrl.split(",")[1], "base64");
    const tooLarge = {
      dataUrl: `data:image/png;base64,${Buffer.concat([pixels, Buffer.alloc(maxRequestImageBytes)]).toString("base64")}`,
    };
    expect(requestImageSchema.safeParse(tooLarge).success).toBe(false);
    const heavy = {
      dataUrl: `data:image/png;base64,${Buffer.concat([pixels, Buffer.alloc(3 * 1024 * 1024)]).toString("base64")}`,
    };
    expect(actionSchema.safeParse({ type: "send", text: "", images: [heavy, heavy] }).success).toBe(
      false,
    );
    for (const [width, height] of [
      [8193, 2],
      [5000, 5000],
      [0, 2],
    ]) {
      const bytes = Buffer.from(pixels);
      bytes.writeUInt32BE(width, 16);
      bytes.writeUInt32BE(height, 20);
      expect(
        requestImageSchema.safeParse({
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        }).success,
      ).toBe(false);
    }
  });
});

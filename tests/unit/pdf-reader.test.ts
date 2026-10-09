import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  writeFile,
  rm,
  realpath,
  mkdir,
  symlink,
  link,
  open,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PdfReader } from "../../src/main/pdf-reader";
import { pdfArguments, pdfTool, pdfInstructions, pdfTimeout } from "../../src/main/pdf-tools";
import { assistantInstructions } from "../../src/main/policy";
import { createCanvas, loadImage } from "@napi-rs/canvas";
// @ts-expect-error Versioned JavaScript fixture, shared with Electron.
import { syntheticReaderPdf } from "../fixtures/browser-pdf.mjs";
let root: string;
let reader: PdfReader;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "stag-pdf-")));
  reader = new PdfReader(resolve("src/main/pdf-worker.mjs"));
  await writeFile(join(root, "documento.pdf"), syntheticReaderPdf());
});
afterEach(async () => {
  reader.cancel();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
const run = (args = {}) => reader.execute({ action: "read", path: "documento.pdf", ...args }, root);
const text = (result: Awaited<ReturnType<typeof run>>) =>
  JSON.parse((result.contentItems[0] as { text: string }).text);

it("extrai texto real paginado, total e revisão sem scripts, gravação ou instalação externa", async () => {
  const info = text(await run({ action: "info" }));
  expect(info).toMatchObject({ kind: "untrusted", totalPages: 2, path: "documento.pdf" });
  const first = text(await run({ pages: 1, sha256: info.sha256 }));
  expect(first.pages[0].text).toContain("REQUISITO 10039");
  expect(first.pages[0].text).not.toContain("SYNTHETIC_INERT_ONLY");
  expect(first.next).toEqual({ firstPage: 2, offset: 0 });
  const second = text(await run({ ...first.next, sha256: info.sha256 }));
  expect(second.pages[0].text).toContain("REGRA DE REMESSA");
  expect(second.next).toBeNull();
  expect(await readdir(root)).toEqual(["documento.pdf"]);
});
it("limita texto e continua sem omitir ou duplicar a página truncada", async () => {
  const content = "REGRA ".repeat(11000);
  await writeFile(join(root, "documento.pdf"), syntheticReaderPdf({ texts: [content] }));
  const first = text(await run());
  expect(first.pages[0].text).toHaveLength(60000);
  expect(first.pages[0].truncated).toBe(true);
  expect(first.next).toEqual({ firstPage: 1, offset: 60000 });
  const second = text(await run(first.next));
  expect(second.next).toBeNull();
  expect((first.pages[0].text + second.pages[0].text).replace(/\s+/g, " ").trim()).toBe(
    content.trim(),
  );
});
it("sinaliza página sem texto e renderiza imagem real para interpretação visual", async () => {
  await writeFile(
    join(root, "documento.pdf"),
    syntheticReaderPdf({ imageOnly: true, texts: [""] }),
  );
  expect(text(await run()).pages[0]).toMatchObject({ text: "", noText: true });
  const image = await run({ action: "render", page: 1 });
  expect(text(image).image).toMatchObject({ page: 1, width: 800, height: 800 });
  const url = (image.contentItems[1] as { imageUrl: string }).imageUrl;
  expect(Buffer.from(url.split(",")[1], "base64").subarray(0, 3).toString("hex")).toBe("ffd8ff");
  const decoded = await loadImage(Buffer.from(url.split(",")[1], "base64"));
  const canvas = createCanvas(800, 800),
    context = canvas.getContext("2d");
  context.drawImage(decoded, 0, 0);
  const pixel = context.getImageData(200, 400, 1, 1).data;
  expect(pixel[2]).toBeGreaterThan(240);
  expect(pixel[0]).toBeLessThan(10);
});
it("recusa corrupção/proteção, páginas e revisão antigas; recuperação explícita funciona", async () => {
  for (const args of [
    { firstPage: 3 },
    { offset: 2000 },
    { action: "render", page: 4 },
    { sha256: "a".repeat(64) },
  ])
    await expect(run(args)).rejects.toThrow();
  await writeFile(join(root, "documento.pdf"), "%PDF-1.4\nSYNTHETIC_INCOMPLETE");
  await expect(run()).rejects.toThrow("inválido");
  await writeFile(join(root, "documento.pdf"), syntheticReaderPdf({ encrypted: true }));
  await expect(run()).rejects.toThrow("senha");
  await writeFile(join(root, "documento.pdf"), syntheticReaderPdf());
  expect(text(await run()).totalPages).toBe(2);
});

it("recusa imagem interna excessiva sem retornar página vazia como leitura válida", async () => {
  await writeFile(
    join(root, "documento.pdf"),
    syntheticReaderPdf({ imageOnly: true, texts: [""], imageWidth: 5000 }),
  );
  await expect(run({ action: "render", page: 1 })).rejects.toThrow("limites");
});
it.each([
  "../documento.pdf",
  "/documento.pdf",
  "C:\\documento.pdf",
  "https://invalid/documento.pdf",
  ".git/documento.pdf",
  ".codex/documento.pdf",
  ".stag/documento.pdf",
  "../auth.json",
  "documento.pdf:stream",
  "arquivo.txt",
])("recusa destino %s", async (path) => {
  await expect(run({ path })).rejects.toThrow();
});
it("recusa links, hardlinks, excesso de tamanho e raiz não canônica", async () => {
  const alias = join(root, "alias");
  await mkdir(join(root, "interno"));
  await symlink(join(root, "interno"), alias, process.platform === "win32" ? "junction" : "dir");
  await expect(run({ path: "alias/documento.pdf" })).rejects.toThrow("links");
  await expect(reader.execute({ action: "info", path: "documento.pdf" }, alias)).rejects.toThrow(
    "links",
  );
  await link(join(root, "documento.pdf"), join(root, "link.pdf"));
  await expect(run({ path: "link.pdf" })).rejects.toThrow("links");
  await rm(join(root, "link.pdf"));
  const file = await open(join(root, "grande.pdf"), "w");
  await file.truncate(100 * 1024 * 1024 + 1);
  await file.close();
  await expect(run({ path: "grande.pdf" })).rejects.toThrow("100 MiB");
});
it("descarta resultado se arquivo muda durante a leitura", async () => {
  let changed!: Promise<void>;
  reader = new PdfReader(resolve("src/main/pdf-worker.mjs"), () => {
    changed = writeFile(join(root, "documento.pdf"), syntheticReaderPdf({ texts: ["ALTERADO"] }));
  });
  await expect(run()).rejects.toThrow(/mudou|inválido/);
  await changed;
});
it("timeout após handshake encerra worker; cancelamento e tentativa posterior recuperam", async () => {
  const worker = join(root, "hold.mjs");
  await writeFile(
    worker,
    "process.stdout.write('{\"ready\":true}\\n'); process.stdin.resume(); setInterval(()=>{},1000);",
  );
  const timer = vi.spyOn(globalThis, "setTimeout");
  let expire!: () => void;
  reader = new PdfReader(worker, () => {
    // Startup uses the normal timeout. Only after handshake do we advance its deadline.
    const call = timer.mock.calls.filter((call) => call[1] === pdfTimeout).at(-1)!;
    expire = call[0] as () => void;
    queueMicrotask(expire);
  });
  await expect(run()).rejects.toThrow("um minuto");
  timer.mockRestore();
  reader = new PdfReader(worker, () => reader.cancel());
  await expect(run()).rejects.toThrow("cancelada");
  reader = new PdfReader(resolve("src/main/pdf-worker.mjs"));
  expect(text(await run()).totalPages).toBe(2);
});
it("transmite contrato e valida intervalo/campos sem permissões adicionais", () => {
  for (const mode of ["project", "read", "windows"] as const)
    expect(assistantInstructions(mode, "win32", false, false)).toContain(pdfInstructions);
  expect(pdfTool.inputSchema.properties.action.enum).toEqual(["info", "read", "render"]);
  expect(pdfArguments.safeParse({ action: "read", path: "x.pdf", pages: 11 }).success).toBe(false);
  expect(pdfArguments.safeParse({ action: "render", path: "x.pdf", page: 0 }).success).toBe(false);
  expect(
    pdfArguments.safeParse({ action: "read", path: "x.pdf", password: "synthetic" }).success,
  ).toBe(false);
});

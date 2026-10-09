// Only bounded bytes from the main process. No PDF URL/path, JavaScript, attachment or network API.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
const require = createRequire(import.meta.url);
const assets = dirname(require.resolve("pdfjs-dist/package.json"));
const textLimit = 60_000;
console.log = console.warn = console.error = () => {};
const send = (result) => process.stdout.write(JSON.stringify(result), () => process.exit(0));
process.stdout.write('{"ready":true}\n');
let loading;
try {
  let header = Buffer.alloc(0),
    data,
    position = 0,
    args;
  for await (let chunk of process.stdin) {
    if (!data) {
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline < 0) {
        if (header.length > 4096) throw new Error("invalid");
        continue;
      }
      if (newline > 4096) throw new Error("invalid");
      const request = JSON.parse(header.subarray(0, newline).toString("utf8"));
      if (
        !Number.isInteger(request.bytes) ||
        request.bytes <= 0 ||
        request.bytes > 100 * 1024 * 1024
      )
        throw new Error("limit");
      args = request.args;
      data = new Uint8Array(request.bytes);
      chunk = header.subarray(newline + 1);
      header = null;
    }
    if (position + chunk.length > data.length) throw new Error("limit");
    data.set(chunk, position);
    position += chunk.length;
  }
  if (!data || position !== data.length) throw new Error("invalid");
  loading = getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    stopAtErrors: true,
    maxImageSize: 20_000_000,
    canvasMaxAreaInBytes: 16_000_000,
    cMapUrl: join(assets, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(assets, "standard_fonts") + "/",
    wasmUrl: join(assets, "wasm") + "/",
    verbosity: 0,
  });
  const pdf = await loading.promise;
  if (pdf.numPages > 10000) throw new Error("limit");
  let result = { totalPages: pdf.numPages };
  if (args.action === "read") {
    if (args.firstPage > pdf.numPages) throw new Error("page");
    const pages = [];
    let next = null,
      budget = textLimit;
    const last = Math.min(pdf.numPages, args.firstPage + args.pages - 1);
    for (let pageNumber = args.firstPage; pageNumber <= last; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      let text = "";
      // Stream avoids constructing the complete TextContent for a large page.
      const stream = page.streamTextContent().getReader();
      const offset = pageNumber === args.firstPage ? args.offset : 0;
      try {
        while (true) {
          const { done, value } = await stream.read();
          if (done) break;
          for (const item of value.items)
            if (typeof item.str === "string") {
              text += item.str + (item.hasEOL ? "\n" : " ");
              if (text.length > 10_000_000) throw new Error("limit");
            }
          if (text.length > offset + budget) break;
        }
      } finally {
        await stream.cancel(new Error("Limite de texto do leitor PDF"));
        stream.releaseLock();
      }
      if (offset > text.length) throw new Error("page");
      const selected = text.slice(offset, offset + budget);
      const truncated = text.length > offset + budget;
      pages.push({ page: pageNumber, text: selected, noText: !text.trim(), truncated });
      budget -= selected.length;
      page.cleanup();
      if (truncated) {
        next = { firstPage: pageNumber, offset: offset + selected.length };
        break;
      }
      if (!budget && pageNumber < pdf.numPages) {
        next = { firstPage: pageNumber + 1, offset: 0 };
        break;
      }
    }
    if (!next && last < pdf.numPages) next = { firstPage: last + 1, offset: 0 };
    result = { ...result, pages, next };
  } else if (args.action === "render") {
    if (args.page > pdf.numPages) throw new Error("page");
    const page = await pdf.getPage(args.page);
    // PDF.js may end an empty operator list after refusing an oversized/corrupt image.
    // Never report that blank output as a successful visual reading.
    if (!(await page.getOperatorList()).fnArray.length) throw new Error("empty");
    const base = page.getViewport({ scale: 1 });
    if (![base.width, base.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000))
      throw new Error("limit");
    const viewport = page.getViewport({
      scale: Math.min(2, 1600 / Math.max(base.width, base.height)),
    });
    const canvas = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvasContext: canvas.context, viewport, background: "rgb(255,255,255)" })
        .promise;
      const image = canvas.canvas.toBuffer("image/jpeg", 85);
      if (image.length > 4 * 1024 * 1024) throw new Error("limit");
      result.image = {
        page: args.page,
        width: canvas.canvas.width,
        height: canvas.canvas.height,
        base64: image.toString("base64"),
      };
    } finally {
      pdf.canvasFactory.destroy(canvas);
      page.cleanup();
    }
  } else if (args.action !== "info") throw new Error("invalid");
  await loading.destroy();
  send(result);
} catch (error) {
  await loading?.destroy().catch(() => {});
  send({
    error:
      error?.name === "PasswordException"
        ? "password"
        : /maximum allowed size/.test(error?.message || "")
          ? "limit"
          : ["page", "limit", "empty"].includes(error?.message)
            ? error.message
            : "invalid",
  });
}

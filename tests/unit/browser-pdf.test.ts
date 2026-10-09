import { expect, it } from "vitest";
import { browserPdfResource, pdfViewerOrigin, pdfViewerPage } from "../../src/main/browser-pdf";

const pdfUrl = "http://127.0.0.1/synthetic.pdf";
function request(overrides: object = {}) {
  return {
    url: `${pdfViewerOrigin}main.js`,
    method: "GET",
    resourceType: "script",
    webContentsId: 2,
    frame: { url: pdfViewerPage, top: { url: pdfUrl }, parent: { url: pdfUrl } },
    ...overrides,
  } as Electron.OnBeforeRequestListenerDetails;
}

it("permite somente o visualizador embutido dentro do PDF HTTP(S) identificado pelo main", () => {
  for (const details of [
    request(),
    request({ url: "chrome://resources/js/assert.js" }),
    request({
      url: pdfViewerPage,
      resourceType: "subFrame",
      frame: { url: "about:blank", top: { url: pdfUrl }, parent: { url: pdfUrl } },
    }),
    request({
      url: `${pdfViewerOrigin}pdf_embedder.css`,
      resourceType: "stylesheet",
      frame: { url: pdfUrl, top: { url: pdfUrl } },
    }),
  ])
    expect(browserPdfResource(details, pdfUrl, 2)).toBe(true);
});

it.each([
  { url: "file:///private" },
  { url: "chrome://settings/" },
  { url: "chrome://resources.attacker.invalid/main.js" },
  { url: "chrome-extension://another-extension/main.js" },
  { url: pdfViewerOrigin.replace(/\/$/, "@attacker.invalid/main.js") },
  { resourceType: "mainFrame", url: pdfViewerPage },
  { resourceType: "subFrame", url: "chrome://resources/index.html" },
  { method: "POST" },
  { webContentsId: 3 },
  { frame: null },
  { frame: { url: pdfViewerPage, top: null } },
  {
    frame: { url: pdfViewerPage, top: { url: "http://127.0.0.1/other" }, parent: { url: pdfUrl } },
  },
  {
    frame: { url: "http://127.0.0.1/ordinary.html", top: { url: pdfUrl }, parent: { url: pdfUrl } },
  },
  {
    frame: { url: pdfViewerPage, top: { url: pdfUrl }, parent: { url: "http://127.0.0.1/other" } },
  },
])("recusa recursos fora do contexto interno: %j", (overrides) => {
  expect(browserPdfResource(request(overrides), pdfUrl, 2)).toBe(false);
});

it("não permite recursos internos sem PDF ou com frame perdido", () => {
  expect(browserPdfResource(request(), null, 2)).toBe(false);
  const details = request();
  Object.defineProperty(details.frame, "top", {
    get() {
      throw new Error("Frame perdido");
    },
  });
  expect(browserPdfResource(details, pdfUrl, 2)).toBe(false);
});

// Chromium's bundled PDF viewer, not an installed extension or a public navigation target.
export const pdfViewerOrigin = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
export const pdfViewerPage = `${pdfViewerOrigin}index.html`;
export const pdfSnapshotNote =
  "PDF no visualizador integrado. O snapshot não extrai o texto do PDF. Use download com este pageId para salvar o PDF no projeto e então stag_pdf info/read para texto paginado ou render para visualizar uma página, inclusive digitalizada. Históricos sem stag_pdf exigem nova conversa. Leitura pode consultar PDFs locais existentes, mas não salva downloads. screenshot captura apenas a página visível; a troca de páginas do visualizador é manual. Não use shell, HTTP ou navegador externo para buscar o arquivo.";

export function browserPdfResource(
  details: Electron.OnBeforeRequestListenerDetails,
  pdfUrl: string | null,
  contentsId: number,
): boolean {
  if (!pdfUrl || details.webContentsId !== contentsId || details.method !== "GET" || !details.frame)
    return false;
  try {
    const frame = details.frame;
    if (frame.top?.url !== pdfUrl) return false;
    if (details.resourceType === "subFrame")
      return details.url === pdfViewerPage && frame.parent?.url === pdfUrl;
    if (
      details.resourceType === "stylesheet" &&
      details.url === `${pdfViewerOrigin}pdf_embedder.css`
    )
      return frame.url === pdfUrl;
    return (
      frame.url === pdfViewerPage &&
      frame.parent?.url === pdfUrl &&
      ["stylesheet", "script", "image", "font", "xhr", "other"].includes(details.resourceType) &&
      (details.url.startsWith(pdfViewerOrigin) || details.url.startsWith("chrome://resources/"))
    );
  } catch {
    // A detached frame is not authority to load internal resources.
    return false;
  }
}

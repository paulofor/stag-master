import type { NativeImage, WebContents } from "electron";

export const browserCaptureError =
  "Não foi possível capturar a imagem desta aba. A leitura de texto pode continuar. Use Restaurar visualização e tente novamente; se persistir, pare o assistente e recarregue a página.";
export const browserCaptureHidden =
  "Para capturar a imagem, deixe a janela do STAG Plus e esta aba do navegador visíveis. A leitura de texto pode continuar enquanto a imagem estiver indisponível.";

// Electron's CopyFromSurfaceError names. Retry only a failed read of the same page,
// never navigation/input, unknown failures or a timeout whose capture is still pending.
const transientErrors = new Set([
  "UnknownVizError",
  "VizSentEmptyBitmap",
  "Frame Gone",
  "EmbeddingTokenChanged",
]);

export async function captureBrowserPage(
  contents: WebContents,
  signal: AbortSignal,
  checkCurrent: () => void,
): Promise<NativeImage> {
  const check = () => {
    if (signal.aborted) throw new Error("Captura cancelada.");
    checkCurrent();
  };
  check();
  const throttling = contents.getBackgroundThrottling();
  let abort: () => void = () => {};
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Temporarily request rendering while the app is unfocused. The driver checks
    // native visibility; never show/focus it or change the system's sleep/lock policy.
    contents.setBackgroundThrottling(false);
    const canceled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new Error("Captura cancelada."));
      signal.addEventListener("abort", abort, { once: true });
    });
    const capture = async () => {
      for (const wait of [0, 250, 750]) {
        if (wait)
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, wait);
          });
        check();
        try {
          contents.invalidate();
          const image = await contents.capturePage(undefined, {
            // Let Chromium produce a surface without showing/focusing any native window.
            stayHidden: false,
            stayAwake: false,
          });
          check();
          if (image.isEmpty()) throw new Error("VizSentEmptyBitmap");
          return image;
        } catch (error) {
          check();
          if (!(error instanceof Error) || !transientErrors.has(error.message))
            throw new Error(browserCaptureError);
        }
      }
      throw new Error(browserCaptureError);
    };
    return await Promise.race([capture(), canceled]);
  } finally {
    clearTimeout(retryTimer);
    signal.removeEventListener("abort", abort);
    if (!contents.isDestroyed()) contents.setBackgroundThrottling(throttling);
  }
}

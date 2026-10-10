import type { DownloadItem, Event, WebContents } from "electron";
import { browserDownloadLimit, BrowserDownloadError } from "./browser-download";
import type { BrowserDownloadInfo } from "../shared/types";

/** One native export, armed only by the queued download operation, never by remote IPC. */
export class BrowserDownloadCapture {
  private item?: DownloadItem;
  private settled = false;
  private redirects = new Map<number, number>();
  private failure?: Error;
  private resolve!: (metadata: { filename: string; mime: string }) => void;
  private reject!: (error: Error) => void;
  private result = new Promise<{ filename: string; mime: string }>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  constructor(
    private options: {
      contents: WebContents;
      path: string;
      source: string;
      signal: AbortSignal;
      check: () => void;
      url: (url: string) => string;
      progress: (state: BrowserDownloadInfo) => void;
    },
  ) {
    void this.result.catch(() => {});
    options.signal.addEventListener("abort", this.abort, { once: true });
    if (options.signal.aborted) this.abort();
  }
  private abort = () => this.stop(new BrowserDownloadError("Download cancelado."));
  private stop(error: Error) {
    if (this.settled) return;
    this.failure ||= error;
    if (this.item)
      this.item.cancel(); // Wait for done before the file owner cleans staging.
    else this.finish();
  }
  private finish(metadata?: { filename: string; mime: string }) {
    if (this.settled) return;
    this.settled = true;
    this.options.signal.removeEventListener("abort", this.abort);
    if (metadata && !this.failure) this.resolve(metadata);
    else this.reject(this.failure || new BrowserDownloadError("A exportação não foi concluída."));
  }
  private validate(item: DownloadItem) {
    this.options.check();
    const origin = new URL(this.options.source).origin;
    if (item.getInitiatorOrigin() !== origin)
      throw new BrowserDownloadError(
        "A exportação veio de outra origem. Use um alvo da página atual.",
      );
    const urls = item.getURLChain();
    if (!urls.length || urls.length > 6)
      throw new BrowserDownloadError("Redirecionamento de download inválido.");
    let previous = this.options.source;
    for (const url of urls) {
      if (url.startsWith("blob:")) {
        if (new URL(url).origin !== origin)
          throw new BrowserDownloadError("Blob de outra origem recusado.");
      } else if (!url.startsWith("data:")) {
        this.options.url(url);
        if (previous.startsWith("https:") && !url.startsWith("https:"))
          throw new BrowserDownloadError(
            "O download recusou um redirecionamento de HTTPS para HTTP.",
          );
      }
      previous = url;
    }
    if (
      item.getTotalBytes() > browserDownloadLimit ||
      item.getReceivedBytes() > browserDownloadLimit
    )
      throw new BrowserDownloadError("O arquivo excede o limite de 100 MiB por download.");
  }
  redirect(id: number, from: string, to: string) {
    if (this.settled) return false;
    try {
      const count = (this.redirects.get(id) || 0) + 1;
      this.redirects.set(id, count);
      this.options.url(to);
      if (count > 5 || (from.startsWith("https:") && !to.startsWith("https:")))
        throw new BrowserDownloadError(
          "Redirecionamento de exportação recusado: limite ou downgrade HTTPS.",
        );
      return true;
    } catch {
      this.stop(
        new BrowserDownloadError(
          "Redirecionamento de exportação recusado. Confira o destino e o certificado.",
        ),
      );
      return false;
    }
  }
  accept(event: Event, item: DownloadItem, contents: WebContents): boolean {
    if (this.settled || this.item || contents !== this.options.contents) return false;
    try {
      this.validate(item);
    } catch (error) {
      event.preventDefault();
      this.stop(error as Error);
      return true;
    }
    this.item = item;
    item.once("done", (_event, state) => {
      if (state !== "completed")
        this.failure ||= new BrowserDownloadError(
          "A exportação foi interrompida; nenhum arquivo foi confirmado. Confira a página antes de tentar novamente.",
        );
      try {
        this.validate(item);
      } catch (error) {
        this.failure ||= error as Error;
      }
      this.finish({ filename: item.getFilename(), mime: item.getMimeType() });
    });
    item.on("updated", (_event, state) => {
      if (this.settled) return;
      try {
        this.validate(item);
        if (state === "interrupted")
          throw new BrowserDownloadError(
            "A exportação foi interrompida. Confira a página antes de tentar novamente.",
          );
        this.options.progress({
          status: "downloading",
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() || null,
          message: "Baixando exportação da página…",
        });
      } catch (error) {
        this.stop(error as Error);
      }
    });
    try {
      item.setSavePath(this.options.path);
    } catch {
      this.stop(new BrowserDownloadError("Não foi possível preparar a gravação da exportação."));
    }
    return true;
  }
  async run(start: () => Promise<unknown>) {
    try {
      if (!this.settled) await start();
    } catch {
      this.stop(
        new BrowserDownloadError(
          "O alvo mudou ou não iniciou uma exportação. Faça novo snapshot antes de tentar novamente.",
        ),
      );
    }
    return this.result;
  }
}

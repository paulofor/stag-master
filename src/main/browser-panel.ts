import { BrowserWindow, WebContentsView, session } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  browserArguments,
  browserConfirmationReason,
  browserUrl,
  type BrowserArguments,
} from "./browser-tools";
import { browserDocument } from "./browser-document";
import type { BrowserControl, BrowserInfo } from "../shared/types";
import type { ToolResult } from "./desktop-tools";

const blankInfo = (): BrowserInfo => ({
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
});
export class BrowserPanel extends EventEmitter {
  private view!: WebContentsView;
  private info = blankInfo();
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = true;
  private pageId: string | null = null;
  private generation = 0;
  private disposed = false;
  constructor(private window: BrowserWindow) {
    super();
    this.reset();
  }
  snapshot(): BrowserInfo {
    return { ...this.info };
  }
  private publish(): void {
    if (!this.disposed) this.emit("state", this.snapshot());
  }
  reset(): void {
    this.generation++;
    this.pageId = null;
    if (this.view) {
      const old = this.view.webContents;
      this.window.contentView.removeChildView(this.view);
      old.stop();
      const oldSession = old.session;
      old.close();
      void oldSession.clearStorageData().catch(() => {});
      void oldSession.clearCache().catch(() => {});
    }
    this.info = blankInfo();
    const browserSession = session.fromPartition(`stag-browser-${randomUUID()}`, { cache: false });
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.on("will-download", (event) => {
      event.preventDefault();
      if (browserSession !== this.view.webContents.session) return;
      this.info.error = "Download bloqueado. Use o navegador externo para baixar arquivos.";
      this.publish();
    });
    // Subframes and redirects cannot reach local protocols/files or launch external applications.
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      let permitted =
        details.url === "about:blank" ||
        (!["mainFrame", "subFrame"].includes(details.resourceType) &&
          /^(data|blob):/.test(details.url));
      try {
        browserUrl(details.url);
        permitted = true;
      } catch {
        /* Remote pages cannot reach local protocols. */
      }
      if (details.resourceType === "webSocket") {
        const url = new URL(details.url);
        permitted = ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password;
      }
      callback({ cancel: !permitted });
    });
    this.view = new WebContentsView({
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        allowRunningInsecureContent: false,
        disableDialogs: true,
        navigateOnDragDrop: false,
      },
    });
    this.view.setBackgroundColor("#ffffff");
    this.window.contentView.addChildView(this.view);
    const contents = this.view.webContents;
    contents.setWindowOpenHandler(() => {
      if (contents !== this.view.webContents) return { action: "deny" };
      this.info.error = "Nova janela bloqueada. Abra o endereço nesta barra do navegador.";
      this.publish();
      return { action: "deny" };
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    const guard = (event: Electron.Event, url: string) => {
      try {
        browserUrl(url);
      } catch {
        event.preventDefault();
        this.info.error = "O navegador permite somente endereços HTTP(S) sem credenciais na URL.";
        this.publish();
      }
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame && contents === this.view.webContents) this.pageId = null;
    });
    const update = () => {
      if (contents !== this.view.webContents || contents.isDestroyed()) return;
      this.info.url = contents.getURL() === "about:blank" ? "" : contents.getURL();
      this.info.title = contents.getTitle();
      this.info.loading = contents.isLoading();
      this.info.canGoBack = contents.navigationHistory.canGoBack();
      this.info.canGoForward = contents.navigationHistory.canGoForward();
      this.view.setVisible(
        this.visible && !!this.info.url && this.bounds.width > 0 && this.bounds.height > 0,
      );
      this.publish();
    };
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", update);
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (contents === this.view.webContents && mainFrame && code !== -3) {
        this.info.error = `Não foi possível carregar a página (código ${code}). Confira o endereço ou recarregue.`;
        update();
      }
    });
    contents.on("render-process-gone", () => {
      if (contents !== this.view.webContents) return;
      this.pageId = null;
      this.info.loading = false;
      this.info.error = "O navegador encerrou. Recarregue a página para continuar.";
      this.publish();
    });
    this.setBounds(this.bounds);
    this.publish();
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.setBounds(this.bounds);
  }
  setBounds(bounds: typeof this.bounds): void {
    const [width, height] = this.window.getContentSize();
    if (bounds.x + bounds.width > width + 1 || bounds.y + bounds.height > height + 1)
      throw new Error("Limites do navegador fora da janela.");
    this.bounds = bounds;
    // Keep a usable viewport for model operations while a compact window shows the conversation tab.
    this.view.setBounds(
      bounds.width && bounds.height
        ? bounds
        : { x: 0, y: 0, width: Math.min(640, width), height: Math.min(720, height) },
    );
    this.view.setVisible(this.visible && !!this.info.url && bounds.width > 0 && bounds.height > 0);
  }
  cancel(): void {
    this.generation++;
    this.pageId = null;
    if (!this.view.webContents.isDestroyed()) this.view.webContents.stop();
  }
  private async document(request: Parameters<typeof browserDocument>[0]): Promise<unknown> {
    const result = (await this.bounded(
      this.view.webContents.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `(() => { try { return { ok: true, value: (${browserDocument.toString()})(${JSON.stringify(request)}) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Falha ao ler a página." }; } })()`,
        },
      ]),
    )) as { ok: boolean; value?: unknown; error?: string };
    if (!result.ok)
      throw new Error(
        result.error?.slice(0, 500) ||
          "Não foi possível ler a página. Recarregue e faça um novo snapshot.",
      );
    return result.value;
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    const contents = this.view.webContents;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (generation === this.generation && !contents.isDestroyed()) this.cancel();
            reject(
              new Error(
                "O navegador demorou para responder. Recarregue a página ou revogue e autorize novamente.",
              ),
            );
          }, 30000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async confirmationReason(input: BrowserArguments): Promise<string | null> {
    if ("url" in input) browserUrl(input.url);
    let reason = browserConfirmationReason(input);
    if ("ref" in input) {
      this.checkPage(input.pageId);
      const probe = (await this.document({
        action: "probe",
        pageId: input.pageId,
        ref: input.ref,
      })) as { reason: string | null };
      reason ||= probe.reason;
    }
    return reason;
  }
  private checkPage(id: string): void {
    if (!this.pageId || id !== this.pageId)
      throw new Error("A página mudou. Faça um novo snapshot antes de interagir.");
  }
  async control(input: BrowserControl): Promise<void> {
    this.pageId = null;
    this.info.error = null;
    this.publish();
    const contents = this.view.webContents;
    if (input.action === "navigate") {
      await this.bounded(contents.loadURL(browserUrl(input.url)));
    } else if (input.action === "reload") contents.reload();
    else if (input.action === "back" && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    else if (input.action === "forward" && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    else throw new Error("Não há página para navegar nessa direção.");
  }
  async execute(raw: unknown): Promise<ToolResult> {
    const input = browserArguments.parse(raw);
    const generation = this.generation;
    let result: unknown = { success: true };
    if (input.action === "navigate" || input.action === "back" || input.action === "forward") {
      await this.control(input);
      if (generation !== this.generation) throw new Error("Operação do navegador cancelada.");
      result = {
        url: this.info.url,
        title: this.info.title,
        note: "Use snapshot para ler a página e obter referências.",
      };
    } else if (input.action === "snapshot") {
      this.pageId = randomUUID();
      result = await this.document({ action: "snapshot", pageId: this.pageId });
    } else if (input.action === "screenshot") {
      const image = await this.bounded(this.view.webContents.capturePage());
      if (generation !== this.generation) throw new Error("Captura cancelada.");
      const size = image.getSize();
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: `Navegador: ${size.width}×${size.height} pixels. Interações usam refs do snapshot, não coordenadas do desktop.`,
          },
          { type: "inputImage", imageUrl: image.toDataURL() },
        ],
      };
    } else if (input.action === "scroll")
      result = await this.document({ action: "scroll", delta: input.delta });
    else {
      this.checkPage(input.pageId);
      result = await this.document({
        ...input,
        action: input.action === "press" ? "focus" : input.action,
      });
      if (generation !== this.generation) throw new Error("Operação do navegador cancelada.");
      if (input.action === "press") {
        this.window.focus();
        this.view.webContents.focus();
        const keyCode = input.key === "Control+A" ? "A" : input.key;
        const modifiers: Electron.KeyboardInputEvent["modifiers"] =
          input.key === "Control+A" ? ["control"] : [];
        this.view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        this.view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }
    }
    if (generation !== this.generation) throw new Error("Operação do navegador cancelada.");
    return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] };
  }
  dispose(): void {
    this.disposed = true;
    this.generation++;
    if (!this.view.webContents.isDestroyed()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
  }
}

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
import { browserLoadError } from "./browser-errors";
import { browserCaptureError, browserCaptureHidden, captureBrowserPage } from "./browser-capture";
import { browserPdfResource, pdfSnapshotNote } from "./browser-pdf";
import {
  browserTabs,
  browserTabLabels,
  type BrowserTab,
  type BrowserControl,
  type BrowserInfo,
  type BrowserPageInfo,
} from "../shared/types";
import type { ToolResult } from "./desktop-tools";

const blankInfo = (): BrowserPageInfo => ({
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  error: null,
});
type BrowserBounds = { x: number; y: number; width: number; height: number };
function fitsWindow(bounds: BrowserBounds, [width, height]: number[]): boolean {
  return bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1;
}
const timeoutMessage =
  "O navegador demorou para responder. Se a página estiver em branco, use Restaurar visualização. Para recarregar, pare o assistente primeiro.";
class BrowserTimeoutError extends Error {}
class BrowserPage extends EventEmitter {
  view!: WebContentsView;
  private info = blankInfo();
  private loadFailure: string | null = null;
  private timedOut = false;
  private captureController: AbortController | null = null;
  private pdfUrl: string | null = null;
  private mainRequestId: number | null = null;
  private bounds = { x: 0, y: 0, width: 0, height: 0 };
  private visible = true;
  private pageId: string | null = null;
  private generation = 0;
  private disposed = false;
  private profileId: string | null = null;
  private configuredSessions = new WeakSet<Electron.Session>();
  constructor(
    private window: BrowserWindow,
    private tab: BrowserTab,
  ) {
    super();
    this.reset();
    this.window.on("resize", this.restoreBounds);
    this.window.on("restore", this.restoreBounds);
    this.window.on("show", this.restoreBounds);
    this.window.on("hide", this.cancelCapture);
    this.window.on("minimize", this.cancelCapture);
  }
  snapshot(): BrowserPageInfo {
    return { ...this.info };
  }
  private publish(): void {
    if (!this.disposed) this.emit("state", this.snapshot());
  }
  reset(profileId = this.profileId): void {
    this.captureController?.abort();
    this.generation++;
    this.pageId = null;
    if (this.view) {
      const old = this.view.webContents;
      this.window.contentView.removeChildView(this.view);
      old.stop();
      const oldSession = old.session;
      oldSession.webRequest.onBeforeRequest((_details, callback) => callback({ cancel: true }));
      oldSession.flushStorageData();
      old.close();
      if (!oldSession.isPersistent()) {
        void oldSession.clearStorageData().catch(() => {});
        void oldSession.clearCache().catch(() => {});
      }
    }
    this.profileId = profileId;
    this.info = blankInfo();
    this.loadFailure = null;
    this.timedOut = false;
    this.pdfUrl = null;
    this.mainRequestId = null;
    const browserSession = session.fromPartition(
      profileId
        ? `persist:stag-project-${profileId}${this.tab === "system" ? "-system" : ""}`
        : `stag-browser-${randomUUID()}`,
      { cache: false },
    );
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setDevicePermissionHandler(() => false);
    if (!this.configuredSessions.has(browserSession)) {
      this.configuredSessions.add(browserSession);
      browserSession.on("will-download", (event) => {
        event.preventDefault();
        if (this.disposed || browserSession !== this.view.webContents.session) return;
        this.info.error = "Download bloqueado. Use o navegador externo para baixar arquivos.";
        this.publish();
      });
    }
    // Subframes and redirects cannot reach local protocols/files or launch external applications.
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      if (
        details.resourceType === "mainFrame" &&
        details.webContentsId === this.view?.webContents.id
      ) {
        this.pdfUrl = null;
        this.mainRequestId = details.id;
      }
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
      if (!permitted && this.view)
        permitted = browserPdfResource(details, this.pdfUrl, this.view.webContents.id);
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
    browserSession.webRequest.onHeadersReceived((details, callback) => {
      if (
        contents === this.view.webContents &&
        details.webContentsId === contents.id &&
        details.resourceType === "mainFrame" &&
        details.id === this.mainRequestId
      ) {
        const headers = Object.entries(details.responseHeaders || {});
        const type = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1][0] || "";
        const disposition =
          headers.find(([name]) => name.toLowerCase() === "content-disposition")?.[1][0] || "";
        this.pdfUrl =
          details.statusCode >= 200 &&
          details.statusCode < 300 &&
          /^application\/pdf(?:\s*;|$)/i.test(type.trim()) &&
          !/^attachment(?:\s*;|$)/i.test(disposition.trim())
            ? details.url
            : null;
      }
      callback({});
    });
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
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && contents === this.view.webContents) {
        this.captureController?.abort();
        this.pageId = null;
        if (!inPlace) {
          this.loadFailure = null;
          this.info.error = null;
        }
      }
    });
    const update = () => {
      if (contents !== this.view.webContents || contents.isDestroyed()) return;
      this.info.url = contents.getURL() === "about:blank" ? "" : contents.getURL();
      this.info.title = contents.getTitle();
      this.info.loading = contents.isLoading();
      this.info.canGoBack = contents.navigationHistory.canGoBack();
      this.info.canGoForward = contents.navigationHistory.canGoForward();
      this.restoreBounds();
      this.publish();
    };
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", update);
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", update);
    contents.on("page-title-updated", update);
    contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
      if (contents === this.view.webContents && mainFrame && code !== -3) {
        this.pageId = null;
        this.loadFailure = browserLoadError(code);
        this.info.error = this.loadFailure;
        update();
      }
    });
    contents.on("render-process-gone", () => {
      if (contents !== this.view.webContents) return;
      this.captureController?.abort();
      this.generation++;
      this.pageId = null;
      this.loadFailure =
        "O navegador encerrou. Pare o assistente e recarregue a página para continuar.";
      this.info.loading = false;
      this.info.error = this.loadFailure;
      this.publish();
    });
    this.restoreBounds();
    this.publish();
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.restoreBounds();
  }
  private cancelCapture = (): void => {
    this.captureController?.abort();
  };
  private restoreBounds = (): void => {
    if (this.disposed || this.window.isDestroyed() || this.view.webContents.isDestroyed()) return;
    const size = this.window.getContentSize();
    const [width, height] = size;
    // A native resize/minimize can precede renderer layout. Hide stale geometry,
    // but retain the last accepted bounds so restore/show can recover without a reload.
    const bounds = fitsWindow(this.bounds, size)
      ? this.bounds
      : { x: 0, y: 0, width: 0, height: 0 };
    // Keep a usable viewport for model operations while a compact window shows the conversation tab.
    this.view.setBounds(
      bounds.width && bounds.height
        ? bounds
        : { x: 0, y: 0, width: Math.min(640, width), height: Math.min(720, height) },
    );
    this.view.setVisible(this.visible && !!this.info.url && bounds.width > 0 && bounds.height > 0);
    if (!this.view.getVisible()) this.cancelCapture();
    if (this.view.getVisible()) this.view.webContents.invalidate();
  };
  setBounds(bounds: BrowserBounds): void {
    if (!fitsWindow(bounds, this.window.getContentSize()))
      throw new Error("Limites do navegador fora da janela.");
    this.bounds = bounds;
    this.restoreBounds();
  }
  cancel(): void {
    this.captureController?.abort();
    this.generation++;
    this.pageId = null;
    if (!this.view.webContents.isDestroyed()) this.view.webContents.stop();
  }
  private async document(request: Parameters<typeof browserDocument>[0]): Promise<unknown> {
    this.checkReadable();
    const result = (await this.bounded(
      this.view.webContents.executeJavaScriptInIsolatedWorld(1001, [
        {
          code: `(() => { try { return { ok: true, value: (${browserDocument.toString()})(${JSON.stringify(request)}) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Falha ao ler a página." }; } })()`,
        },
      ]),
    )) as { ok: boolean; value?: unknown; error?: string };
    this.checkReadable();
    if (!result.ok)
      throw new Error(
        result.error?.slice(0, 500) ||
          "Não foi possível ler a página. Recarregue e faça um novo snapshot.",
      );
    return result.value;
  }
  private checkReadable(): void {
    if (this.loadFailure) throw new Error(this.loadFailure);
    // loadURL resolves on did-finish-load; Chromium's loading flag can still be true then.
  }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    const contents = this.view.webContents;
    const generation = this.generation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            // stop() may reject loadURL synchronously; preserve the actual timeout diagnosis.
            reject(new BrowserTimeoutError(timeoutMessage));
            if (generation === this.generation && !contents.isDestroyed()) {
              this.cancel();
              this.timedOut = true;
              this.info.error = timeoutMessage;
              this.publish();
            }
          }, 30000);
        }),
      ]);
      if (generation === this.generation && contents === this.view.webContents && this.timedOut) {
        this.timedOut = false;
        if (this.info.error === timeoutMessage) this.info.error = null;
        this.publish();
      }
      return result;
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
        ...(input.action === "select"
          ? {
              operation: "select" as const,
              value: input.value,
              label: input.label,
              index: input.index,
            }
          : {}),
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
    const url = input.action === "navigate" ? browserUrl(input.url) : null;
    this.pageId = null;
    this.info.error = null;
    this.publish();
    const contents = this.view.webContents;
    if (input.action === "navigate") {
      const generation = this.generation;
      try {
        await this.bounded(contents.loadURL(url!));
      } catch (error) {
        if (error instanceof BrowserTimeoutError) throw error;
        if (contents !== this.view.webContents || generation !== this.generation)
          throw new Error("Operação do navegador cancelada.");
        const code = error && typeof error === "object" && "errno" in error ? error.errno : null;
        const message = this.loadFailure || browserLoadError(code);
        if (code !== -3) {
          this.loadFailure = message;
          this.info.error = message;
          this.publish();
        }
        throw new Error(message);
      }
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
      if (this.pdfUrl)
        result = { ...(result as object), documentType: "pdf", note: pdfSnapshotNote };
    } else if (input.action === "screenshot") {
      this.checkReadable();
      if (!this.view.getVisible() || !this.window.isVisible() || this.window.isMinimized()) {
        this.info.error = browserCaptureHidden;
        this.publish();
        throw new Error(browserCaptureHidden);
      }
      const controller = new AbortController();
      this.captureController?.abort();
      this.captureController = controller;
      let image: Electron.NativeImage;
      try {
        image = await this.bounded(
          captureBrowserPage(this.view.webContents, controller.signal, () => this.checkReadable()),
        );
        if (controller.signal.aborted) throw new Error("Captura cancelada.");
        if (this.info.error === browserCaptureError || this.info.error === browserCaptureHidden) {
          this.info.error = null;
          this.publish();
        }
      } catch (error) {
        if (
          !controller.signal.aborted &&
          generation === this.generation &&
          error instanceof Error &&
          error.message === browserCaptureError
        ) {
          this.info.error = browserCaptureError;
          this.publish();
        }
        throw error;
      } finally {
        controller.abort();
        if (this.captureController === controller) this.captureController = null;
      }
      if (generation !== this.generation) throw new Error("Captura cancelada.");
      this.checkReadable();
      const size = image.getSize();
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: `Navegador · ${browserTabLabels[this.tab]}: ${size.width}×${size.height} pixels. Interações usam refs do snapshot, não coordenadas do desktop.`,
          },
          { type: "inputImage", imageUrl: image.toDataURL() },
        ],
      };
    } else if (input.action === "scroll" && this.pdfUrl)
      throw new Error(
        "Role o PDF manualmente no painel integrado e solicite uma nova captura. O snapshot não extrai o texto do PDF.",
      );
    else if (input.action === "scroll")
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
        // Electron expects accelerator codes (Down), while the tool uses DOM keys (ArrowDown).
        const keyCode = input.key === "Control+A" ? "A" : input.key.replace(/^Arrow/, "");
        const modifiers: Electron.KeyboardInputEvent["modifiers"] =
          input.key === "Control+A" ? ["control"] : [];
        this.view.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        this.view.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }
    }
    if (generation !== this.generation) throw new Error("Operação do navegador cancelada.");
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({ ...(result as Record<string, unknown>), tab: this.tab }),
        },
      ],
    };
  }
  dispose(): void {
    this.captureController?.abort();
    this.disposed = true;
    this.window.removeListener("resize", this.restoreBounds);
    this.window.removeListener("restore", this.restoreBounds);
    this.window.removeListener("show", this.restoreBounds);
    this.window.removeListener("hide", this.cancelCapture);
    this.window.removeListener("minimize", this.cancelCapture);
    this.generation++;
    if (!this.view.webContents.isDestroyed()) {
      this.view.webContents.session.webRequest.onBeforeRequest((_details, callback) =>
        callback({ cancel: true }),
      );
      this.view.webContents.session.flushStorageData();
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
      this.view.webContents.close();
    }
  }
}

// Both pages reuse the production driver. The service owns the single shared action queue.
export class BrowserPanel extends EventEmitter {
  private pages: Record<BrowserTab, BrowserPage>;
  private activeTab: BrowserTab = "documentation";
  private visible = true;
  private profileId: string | null = null;
  private resetting = false;
  private disposed = false;
  constructor(window: BrowserWindow) {
    super();
    this.pages = {
      documentation: new BrowserPage(window, "documentation"),
      system: new BrowserPage(window, "system"),
    };
    for (const tab of browserTabs) this.pages[tab].on("state", () => this.publish());
    this.syncVisibility();
  }
  // The selected view is also used by the real Electron harness.
  get view(): WebContentsView {
    return this.pages[this.activeTab].view;
  }
  snapshot(): BrowserInfo {
    const tabs = {
      documentation: this.pages.documentation.snapshot(),
      system: this.pages.system.snapshot(),
    };
    return { ...tabs[this.activeTab], activeTab: this.activeTab, tabs };
  }
  private publish(): void {
    if (!this.resetting && !this.disposed) this.emit("state", this.snapshot());
  }
  selectTab(tab: BrowserTab): void {
    if (!browserTabs.includes(tab)) throw new Error("Aba do navegador inválida.");
    if (this.disposed) throw new Error("Navegador encerrado.");
    this.activeTab = tab;
    this.syncVisibility();
    this.publish();
  }
  private syncVisibility(): void {
    for (const tab of browserTabs)
      this.pages[tab].setVisible(this.visible && tab === this.activeTab);
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.syncVisibility();
  }
  setBounds(bounds: BrowserBounds): void {
    for (const tab of browserTabs) this.pages[tab].setBounds(bounds);
  }
  setProfile(id: string | null): void {
    if (id !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
      throw new Error("Perfil do navegador inválido.");
    if (id !== this.profileId) this.reset(id);
  }
  reset(profileId = this.profileId): void {
    this.resetting = true;
    try {
      this.activeTab = "documentation";
      this.profileId = profileId;
      // Hide both old views before replacing them.
      for (const tab of browserTabs) this.pages[tab].setVisible(false);
      for (const tab of browserTabs) this.pages[tab].reset(profileId);
      this.syncVisibility();
    } finally {
      this.resetting = false;
      this.publish();
    }
  }
  async clearProfile(): Promise<void> {
    const previous = browserTabs.map((tab) => this.pages[tab].view.webContents.session);
    const id = this.profileId;
    // Destroy both pages first; neither can recreate storage during cleanup.
    this.reset(null);
    const results = await Promise.allSettled(
      previous.map(async (browserSession) => {
        await browserSession.closeAllConnections();
        await browserSession.clearData();
        await browserSession.clearAuthCache();
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      this.reset(id);
      throw new Error(
        "Não foi possível apagar todos os dados do navegador. Tente Esquecer logins novamente.",
      );
    }
  }
  cancel(): void {
    for (const tab of browserTabs) this.pages[tab].cancel();
  }
  async control(input: BrowserControl): Promise<void> {
    this.selectTab(input.tab ?? this.activeTab);
    await this.pages[this.activeTab].control(input);
  }
  async confirmationReason(input: BrowserArguments): Promise<string | null> {
    this.selectTab(input.tab ?? this.activeTab);
    return this.pages[this.activeTab].confirmationReason(input);
  }
  async execute(raw: unknown): Promise<ToolResult> {
    const input = browserArguments.parse(raw);
    this.selectTab(input.tab ?? this.activeTab);
    return this.pages[this.activeTab].execute(input);
  }
  dispose(): void {
    this.disposed = true;
    for (const tab of browserTabs) this.pages[tab].dispose();
  }
}

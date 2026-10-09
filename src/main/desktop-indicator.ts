import { BrowserWindow, screen } from "electron";
import { desktopArguments, withoutAssistantWindow, type DesktopTools } from "./desktop-tools";

// Fixed local content. No target title, coordinates, tool arguments or project data enter this page.
const indicatorDocument = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>STAG Plus · controle Windows</title><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;pointer-events:none}
.border{position:fixed;inset:0;box-sizing:border-box;border:4px solid #3984ff;border-radius:12px;
box-shadow:inset 0 0 16px 3px #2979ff99,inset 0 0 42px #2979ff33;animation:glow 2s ease-in-out infinite alternate}
@keyframes glow{to{border-color:#70b1ff;box-shadow:inset 0 0 22px 4px #2979ffbb,inset 0 0 48px #2979ff44}}
@media(prefers-reduced-motion:reduce){.border{animation:none}}
</style></head><body><div class="border" role="status" aria-label="STAG Plus controlando o Windows"></div></body></html>`;

interface Operation {
  controller: AbortController;
  windows: BrowserWindow[];
  ended: boolean;
}

/** Visual feedback owned by main, only around an operation already admitted by the shared queue. */
export class DesktopControlIndicator {
  private active: Operation | null = null;
  private disposed = false;

  constructor(private platform = process.platform) {}

  cancel(): void {
    this.active?.controller.abort();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  async run<T>(execute: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.disposed) throw new Error("O controle do Windows foi encerrado.");
    if (this.active) throw new Error("Aguarde a ação anterior do Windows terminar.");
    const operation: Operation = { controller: new AbortController(), windows: [], ended: false };
    this.active = operation;
    const { controller, windows } = operation;
    const destroy = () => {
      for (const window of windows) if (!window.isDestroyed()) window.destroy();
    };
    const cancel = () => controller.abort();
    controller.signal.addEventListener("abort", destroy, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
    const displaysChanged = () => cancel();
    let executing = false;
    try {
      if (signal?.aborted) cancel();
      controller.signal.throwIfAborted();
      if (this.platform === "win32") {
        // A changed monitor/DPI invalidates the visual bounds and any pending coordinate action.
        screen.on("display-added", displaysChanged);
        screen.on("display-removed", displaysChanged);
        screen.on("display-metrics-changed", displaysChanged);
        const displays = screen.getAllDisplays();
        if (!displays.length) throw new Error("Não foi possível mostrar o indicador do Windows.");
        await Promise.all(
          displays.map(async ({ bounds }) => {
            const window = new BrowserWindow({
              ...bounds,
              title: "STAG Plus · controle Windows",
              show: false,
              frame: false,
              transparent: true,
              backgroundColor: "#00000000",
              focusable: false,
              skipTaskbar: true,
              resizable: false,
              movable: false,
              minimizable: false,
              maximizable: false,
              fullscreenable: false,
              hasShadow: false,
              roundedCorners: false,
              enableLargerThanScreen: true,
              webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true,
                javascript: false,
                devTools: false,
                partition: "stag-desktop-indicator",
              },
            });
            windows.push(window);
            // WindowFromPoint skips disabled windows; never make an exception in target validation.
            window.setEnabled(false);
            window.setIgnoreMouseEvents(true);
            window.setAlwaysOnTop(true, "screen-saver");
            window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
            window.webContents.on("will-navigate", (event) => event.preventDefault());
            window.webContents.on("render-process-gone", cancel);
            window.on("closed", () => {
              if (!operation.ended) cancel();
            });
            // Even the isolated session cannot make requests or obtain native permissions.
            const session = window.webContents.session;
            session.setPermissionRequestHandler((_contents, _permission, callback) =>
              callback(false),
            );
            session.setPermissionCheckHandler(() => false);
            session.webRequest.onBeforeRequest(
              { urls: ["http://*/*", "https://*/*"] },
              (_details, callback) => callback({ cancel: true }),
            );
            await window.loadURL(
              `data:text/html;charset=utf-8,${encodeURIComponent(indicatorDocument)}`,
            );
          }),
        );
        controller.signal.throwIfAborted();
        for (const [index, window] of windows.entries()) {
          window.showInactive();
          controller.signal.throwIfAborted();
          // Initial Chromium widget placement may clamp to workArea. Apply the whole monitor
          // after showing, so the bottom border reaches the desktop edge above the taskbar.
          window.setBounds(displays[index].bounds);
        }
      }
      controller.signal.throwIfAborted();
      executing = true;
      const result = await execute(controller.signal);
      controller.signal.throwIfAborted();
      return result;
    } catch (error) {
      if (controller.signal.aborted)
        throw new Error(
          "A ação do Windows foi interrompida. Confira o alvo antes de tentar novamente.",
        );
      if (!executing)
        throw new Error(
          "Não foi possível mostrar o indicador do Windows. A ação não foi executada.",
          { cause: error },
        );
      throw error;
    } finally {
      operation.ended = true;
      if (this.platform === "win32") {
        screen.removeListener("display-added", displaysChanged);
        screen.removeListener("display-removed", displaysChanged);
        screen.removeListener("display-metrics-changed", displaysChanged);
      }
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", destroy);
      destroy();
      if (this.active === operation) this.active = null;
    }
  }
}

/** The same production wiring is used by main and the Electron harness. Inspection never shows a border. */
export function createDesktopControl(
  window: Parameters<typeof withoutAssistantWindow>[0],
  desktop: Pick<DesktopTools, "execute" | "confirmationReason" | "cancel" | "pulseCursor">,
  indicator = new DesktopControlIndicator(),
) {
  return {
    confirmationReason: (raw: unknown) => desktop.confirmationReason(raw),
    execute: (raw: unknown, approved?: boolean) => {
      const input = desktopArguments.parse(raw);
      return indicator.run((signal) => {
        const execute = () => {
          signal.throwIfAborted();
          return desktop.execute(input, approved, signal);
        };
        return ["screenshot", "click", "scroll"].includes(input.action)
          ? withoutAssistantWindow(window, execute)
          : execute();
      });
    },
    pulseCursor: (signal: AbortSignal) =>
      indicator.run((operation) => desktop.pulseCursor(operation), signal),
    cancel: () => {
      indicator.cancel();
      desktop.cancel();
    },
    dispose: () => {
      indicator.dispose();
      desktop.cancel();
    },
  };
}

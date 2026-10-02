import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  shell,
} from "electron";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "./rpc";
import { AssistantService } from "./service";
import { SettingsStore } from "./settings";
import { desktopArguments, DesktopTools, withoutAssistantWindow } from "./desktop-tools";
import { codexEnvironment } from "./policy";
import { actionSchema } from "../shared/validation";
import type { Action } from "../shared/types";

protocol.registerSchemesAsPrivileged([
  { scheme: "stag", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName("STAG");
let window: BrowserWindow | null = null;
let service: AssistantService | null = null;
const devUrl = !app.isPackaged ? process.env.STAG_DEV_URL : undefined;
if (devUrl && devUrl !== "http://127.0.0.1:5173")
  throw new Error("Origem de desenvolvimento inválida.");

async function start(): Promise<void> {
  const rendererRoot = join(app.getAppPath(), "dist/renderer");
  protocol.handle("stag", (request) => {
    const url = new URL(request.url);
    if (url.host !== "app" || request.method !== "GET") return new Response(null, { status: 403 });
    const path = resolve(
      rendererRoot,
      `.${decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)}`,
    );
    if (!path.startsWith(rendererRoot + sep)) return new Response(null, { status: 403 });
    return net.fetch(pathToFileURL(path).href);
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.on("will-download", (event) => event.preventDefault());
  window = new BrowserWindow({
    width: 640,
    height: 900,
    minWidth: 360,
    minHeight: 600,
    title: "STAG",
    backgroundColor: "#faf9f6",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), "dist/main/preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.on("ready-to-show", () => window?.show());
  const dataRoot = app.getPath("userData");
  const codexHome = join(dataRoot, "codex");
  await mkdir(codexHome, { recursive: true });
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const codexRoot = app.isPackaged
    ? join(resourceRoot, "codex")
    : join(resourceRoot, ".local/codex");
  const codexBinary = join(codexRoot, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const desktop = new DesktopTools(join(resourceRoot, "native/windows-control.ps1"), async () => {
    const primary = screen.getPrimaryDisplay();
    const width = Math.round(primary.size.width * primary.scaleFactor);
    const height = Math.round(primary.size.height * primary.scaleFactor);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    const source = sources.find((s) => s.display_id === String(primary.id));
    if (!source || source.thumbnail.isEmpty())
      throw new Error("Não foi possível capturar a tela principal.");
    const size = source.thumbnail.getSize();
    const origin = screen.dipToScreenPoint({ x: primary.bounds.x, y: primary.bounds.y });
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: `Tela principal: ${size.width}×${size.height} pixels. Origem física: x=${origin.x}, y=${origin.y}. Para clicar, some a origem às coordenadas na imagem.`,
        },
        { type: "inputImage", imageUrl: source.thumbnail.toDataURL() },
      ],
    };
  });
  service = new AssistantService({
    createRpc: () =>
      new RpcClient({
        command: codexBinary,
        args: [
          "app-server",
          "--listen",
          "stdio://",
          "-c",
          "shell_environment_policy.ignore_default_excludes=false",
          ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
        ],
        env: {
          ...codexEnvironment(codexHome),
          PATH: `${join(codexRoot, "codex-path")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
        },
      }),
    store: new SettingsStore(join(dataRoot, "settings.json")),
    selectProject: async () => {
      const result = await dialog.showOpenDialog(window!, {
        title: "Selecionar projeto",
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0] || null;
    },
    openExternal: async (url) => {
      await shell.openExternal(url);
    },
    desktop: {
      execute: (raw) => {
        const input = desktopArguments.parse(raw);
        return ["screenshot", "click", "scroll"].includes(input.action)
          ? withoutAssistantWindow(window, () => desktop.execute(input))
          : desktop.execute(input);
      },
    },
  });
  service.on("snapshot", (snapshot) => {
    if (window && !window.isDestroyed()) window.webContents.send("stag:snapshot", snapshot);
  });
  function trusted(event: Electron.IpcMainInvokeEvent): void {
    const frame = event.senderFrame;
    const mainFrame = window?.webContents.mainFrame;
    if (
      !window ||
      event.sender !== window.webContents ||
      !frame ||
      !mainFrame ||
      frame.routingId !== mainFrame.routingId ||
      frame.processId !== mainFrame.processId ||
      !frame.url.startsWith(devUrl ? `${devUrl}/` : "stag://app/")
    )
      throw new Error("Origem IPC não autorizada.");
  }
  ipcMain.handle("stag:getSnapshot", (event) => {
    trusted(event);
    return service!.snapshot();
  });
  ipcMain.handle("stag:action", async (event, raw: unknown) => {
    trusted(event);
    const action = actionSchema.parse(raw) as Action;
    if (
      process.platform === "win32" &&
      action.type === "preferences" &&
      action.mode === "windows" &&
      action.windowsConsent
    ) {
      const result = await dialog.showMessageBox(window!, {
        type: "warning",
        title: "Acesso ao Windows",
        message: "Permitir que o assistente controle este computador nesta conversa?",
        detail:
          "O agente poderá controlar mouse e teclado e executar comandos com acesso amplo. Cada operação de desktop terá aprovação própria. Capturas e títulos de janelas aprovados serão enviados ao ChatGPT para a tarefa. Autorizar inicia uma nova conversa; revogar ou abrir outra conversa encerra o acesso.",
        buttons: ["Cancelar", "Permitir acesso"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return service!.snapshot();
    }
    return service!.request(action);
  });
  await service.init();
  await window.loadURL(devUrl || "stag://app/index.html");
  void service.request({ type: "connect" }).catch(() => {});
}
app
  .whenReady()
  .then(start)
  .catch((error: Error) => {
    dialog.showErrorBox("Não foi possível iniciar o STAG", error.message);
    app.quit();
  });
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => service?.dispose());

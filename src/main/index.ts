import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from "electron";
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
import { BrowserPanel } from "./browser-panel";

protocol.registerSchemesAsPrivileged([
  { scheme: "stag", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName("STAG");
let window: BrowserWindow | null = null;
let service: AssistantService | null = null;
let browser: BrowserPanel | null = null;
let authorizationRevision = 0;
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
    width: 1280,
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
  browser = new BrowserPanel(window);
  const dataRoot = app.getPath("userData");
  const codexHome = join(dataRoot, "codex");
  await mkdir(codexHome, { recursive: true });
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
  const codexRoot = app.isPackaged
    ? join(resourceRoot, "codex")
    : join(resourceRoot, ".local/codex");
  const codexBinary = join(codexRoot, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const desktop = new DesktopTools(join(resourceRoot, "native/windows-control.ps1"));
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
    browser,
  });
  browser.on("state", (info) => service?.updateBrowser(info));
  service.updateBrowser(browser.snapshot());
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
    if (action.type === "browserBounds") {
      browser!.setBounds(action.bounds);
      return service!.snapshot();
    }
    if (
      [
        "connect",
        "logout",
        "selectProject",
        "preferences",
        "newChat",
        "resume",
        "browserConsent",
        "browserVisibility",
      ].includes(action.type)
    )
      authorizationRevision++;
    if (action.type === "browserConsent" && action.allow) {
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Controle do navegador",
        message: "Permitir que o modelo controle o navegador nesta conversa?",
        detail:
          "O modelo poderá navegar, ler páginas, clicar e preencher campos no navegador ao lado. Texto e capturas das páginas serão enviados ao ChatGPT. Ações rotineiras não pedirão confirmação; envio de dados, exclusão, publicação, pagamentos, credenciais e ações incertas terão confirmação específica. Revogar acesso, fechar o navegador ou abrir outra conversa encerra a autorização e descarta a sessão. O navegador usa uma sessão separada dos seus outros navegadores.",
        buttons: ["Cancelar", "Autorizar navegador"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return service!.snapshot();
      if (owner !== authorizationRevision)
        throw new Error(
          "A conversa mudou durante a autorização. Autorize o navegador na conversa atual.",
        );
    }
    if (
      process.platform === "win32" &&
      action.type === "preferences" &&
      action.mode === "windows" &&
      action.windowsConsent
    ) {
      const result = await dialog.showMessageBox(window!, {
        type: "warning",
        title: "Acesso ao Windows",
        message: "Permitir controle de Postman, IntelliJ IDEA e Visual Studio Code nesta conversa?",
        detail:
          "O desktop ficará limitado a esses três aplicativos: capturas somente da janela escolhida, foco, mouse e teclado. Outros programas e atalhos globais ficam bloqueados, mesmo com aprovação. Navegação web usa o navegador integrado, com autorização própria. A rotina não pede nova aprovação; exclusão, envio externo, publicação, pagamentos, credenciais, mudanças no sistema e interações incertas exigem confirmação específica. Capturas e títulos dessas janelas são enviados ao ChatGPT. Autorizar inicia nova conversa; revogar ou abrir outra encerra o acesso.",
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
app.on("before-quit", () => {
  service?.dispose();
  browser?.dispose();
});

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  safeStorage,
  session,
  shell,
} from "electron";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { RpcClient } from "./rpc";
import { AssistantService } from "./service";
import { SettingsStore } from "./settings";
import { DatabaseConnections } from "./database-connections";
import { testSqlServer } from "./sqlserver";
import { ApiConnections } from "./api-connections";
import { HttpTools } from "./http-tools";
import { DesktopTools } from "./desktop-tools";
import { createDesktopControl } from "./desktop-indicator";
import { TaskbarAttention } from "./taskbar-attention";
import { WaitingSound } from "./waiting-sound";
import { codexEnvironment } from "./policy";
import { modelTrafficArguments } from "./model-traffic";
import { optimizeModelImage } from "./model-images";
import { actionSchema } from "../shared/validation";
import type { Action } from "../shared/types";
import { BrowserPanel } from "./browser-panel";
import {
  inspectVideo,
  prepareVideo,
  prepareVideoSegment,
  validateVideoSource,
} from "./request-video";
import { VideoAnalysisStore } from "./video-analysis";
import { videoExtensions } from "../shared/request-video";
import { build as packageBuild } from "../../package.json";

protocol.registerSchemesAsPrivileged([
  { scheme: "stag", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
app.setName("STAG");
if (process.platform === "win32") app.setAppUserModelId(packageBuild.appId);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
let window: BrowserWindow | null = null;
let service: AssistantService | null = null;
let browser: BrowserPanel | null = null;
let desktopControl: ReturnType<typeof createDesktopControl> | null = null;
let taskbarAttention: TaskbarAttention | null = null;
let authorizationRevision = 0;
const devUrl = !app.isPackaged ? process.env.STAG_DEV_URL : undefined;
if (devUrl && devUrl !== "http://127.0.0.1:5173")
  throw new Error("Origem de desenvolvimento inválida.");

async function start(): Promise<void> {
  const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
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
  // Indicator windows must not keep the application alive after the conversation window closes.
  window.on("closed", () => app.quit());
  window.on("ready-to-show", () => window?.show());
  taskbarAttention = new TaskbarAttention(
    window,
    process.platform,
    new WaitingSound(join(resourceRoot, "native/waiting-sound.ps1")),
  );
  browser = new BrowserPanel(window);
  const dataRoot = app.getPath("userData");
  const codexHome = join(dataRoot, "codex");
  await mkdir(codexHome, { recursive: true });
  const codexRoot = app.isPackaged
    ? join(resourceRoot, "codex")
    : join(resourceRoot, ".local/codex");
  const codexBinary = join(codexRoot, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  const desktop = createDesktopControl(
    window,
    new DesktopTools(join(resourceRoot, "native/windows-control.ps1"), process.platform, () =>
      window && !window.isDestroyed() ? window.getNativeWindowHandle() : null,
    ),
  );
  desktopControl = desktop;
  const secretStorage = {
    available: () =>
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: (value: string) => safeStorage.encryptString(value),
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
  service = new AssistantService({
    optimizeImage: optimizeModelImage,
    createRpc: () =>
      new RpcClient({
        command: codexBinary,
        args: [
          "app-server",
          "--listen",
          "stdio://",
          "-c",
          "shell_environment_policy.ignore_default_excludes=false",
          ...modelTrafficArguments,
          ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
        ],
        env: {
          ...codexEnvironment(codexHome),
          PATH: `${join(codexRoot, "codex-path")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}`,
        },
      }),
    store: new SettingsStore(join(dataRoot, "settings.json")),
    apis: new HttpTools(
      new ApiConnections(join(dataRoot, "api-connections.json"), secretStorage),
      async (url) => {
        await shell.openExternal(url);
      },
    ),
    databases: {
      connections: new DatabaseConnections(
        join(dataRoot, "database-connections.json"),
        secretStorage,
      ),
      test: testSqlServer,
    },
    confirmBranchDeletion: async (project, branch) => {
      const result = await dialog.showMessageBox(window!, {
        type: "warning",
        title: "Excluir branch local",
        message: `Excluir a branch ${branch}?`,
        detail: `Projeto: ${project}\nA referência local será removida. Somente branches com commits integrados na branch atual podem ser excluídas aqui. O remoto não será alterado.`,
        buttons: ["Cancelar", "Excluir branch"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return result.response === 1;
    },
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
    desktop,
    pulseCursor: (signal) => desktop.pulseCursor(signal),
    browser,
    video: {
      select: async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: "Anexar vídeo do projeto",
          properties: ["openFile"],
          filters: [{ name: "Vídeos MP4, MOV, MKV e WebM", extensions: videoExtensions }],
        });
        return result.canceled ? null : result.filePaths[0] || null;
      },
      prepare: async (path, signal, progress) => {
        const prepared = await prepareVideo(
          path,
          join(resourceRoot, app.isPackaged ? "media" : ".local/media"),
          join(app.getPath("temp"), "stag-media"),
          signal,
          progress,
        );
        for (const frame of prepared.frames)
          if (nativeImage.createFromDataURL(frame.image.dataUrl).isEmpty())
            throw new Error("Não foi possível decodificar as imagens do vídeo.");
        return prepared;
      },
    },
    videoAnalysis: {
      store: new VideoAnalysisStore(join(dataRoot, "video-analysis.json")),
      processor: {
        inspect: (path, signal) =>
          inspectVideo(path, join(resourceRoot, app.isPackaged ? "media" : ".local/media"), signal),
        validate: validateVideoSource,
        prepare: async (source, index, id, signal, progress) => {
          const prepared = await prepareVideoSegment(
            source,
            index,
            id,
            join(resourceRoot, app.isPackaged ? "media" : ".local/media"),
            join(app.getPath("temp"), "stag-media"),
            signal,
            progress,
          );
          for (const frame of prepared.frames)
            if (nativeImage.createFromDataURL(frame.image.dataUrl).isEmpty())
              throw new Error("Não foi possível decodificar as imagens do vídeo.");
          return prepared;
        },
      },
    },
  });
  browser.on("state", (info) => service?.updateBrowser(info));
  service.updateBrowser(browser.snapshot());
  service.on("snapshot", (snapshot) => {
    taskbarAttention?.update(snapshot);
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
    if (action.type === "send") {
      for (const image of action.images || []) {
        const decoded = nativeImage.createFromDataURL(image.dataUrl);
        if (decoded.isEmpty()) throw new Error("Imagem inválida ou incompleta. Cole outra imagem.");
      }
    }
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
        "browserSession",
        "apiConsent",
        "saveApi",
        "deleteApi",
        "analyzeVideo",
        "videoAnalysis",
        "mouseMovement",
      ].includes(action.type)
    )
      authorizationRevision++;
    if (
      action.type === "mouseMovement" &&
      action.enabled &&
      !service!.snapshot().mouseMovement.enabled
    ) {
      const snapshot = service!.snapshot();
      if (
        process.platform !== "win32" ||
        snapshot.mode !== "windows" ||
        snapshot.connection !== "ready" ||
        !snapshot.account ||
        snapshot.threadId !== action.threadId
      )
        throw new Error(
          "Autorize o desktop e inicie uma conversa Windows antes de ativar o movimento do mouse.",
        );
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Movimento periódico do mouse",
        message: "Mover o mouse a cada cinco minutos nesta conversa?",
        detail:
          "O cursor se desloca até 2 pixels e retorna quando o alvo continua válido, sem cliques, teclas ou troca de foco. Funciona sobre a janela principal do STAG, inclusive o navegador integrado, ou Postman, IntelliJ IDEA, Visual Studio Code ou DBeaver em primeiro plano, sem botões do mouse pressionados. O cursor precisa estar sobre essa janela. FortiClient e outros aplicativos são omitidos; o painel informa o motivo. Continua com o STAG minimizado; desligar, parar, desconectar, trocar de conversa ou fechar encerra os movimentos. Não garante impedir suspensão, bloqueio ou expiração de sessões e não altera políticas do Windows.",
        buttons: ["Cancelar", "Ativar movimento"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return service!.snapshot();
      if (owner !== authorizationRevision)
        throw new Error(
          "A conversa ou autorização mudou durante a confirmação. Ative novamente na conversa atual.",
        );
    }
    if (action.type === "apiConsent" && action.allow) {
      const snapshot = service!.snapshot();
      if (
        snapshot.project?.path !== action.projectPath ||
        snapshot.projectApis?.revision !== action.revision ||
        snapshot.busy
      )
        throw new Error("Confira o projeto e pare a execução antes de autorizar APIs.");
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Autorizar APIs",
        message: "Permitir consultas autenticadas a estas APIs nesta conversa?",
        detail: `${snapshot.projectApis.connections.map((entry) => `${entry.config.name}: ${entry.config.baseUrl}`).join("\n")}\n\nO STAG usará as credenciais cadastradas, sem entregá-las ao assistente. As respostas das APIs serão enviadas ao ChatGPT. Requisições com efeitos exigem confirmação específica. Leitura permite somente consultas rotineiras. Trocar de conversa, desconectar, alterar o cadastro ou revogar encerra esta autorização.`,
        buttons: ["Cancelar", "Autorizar APIs"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (result.response !== 1) return service!.snapshot();
      if (owner !== authorizationRevision)
        throw new Error("O contexto mudou durante a confirmação. Confira e autorize novamente.");
    }
    if (action.type === "videoAnalysis" && action.control === "retry") {
      const summary = service!.snapshot().videoAnalysis;
      if (!summary || summary.id !== action.id || summary.status !== "uncertain")
        throw new Error("Confira a análise salva antes de reprocessar.");
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "warning",
        title: "Reprocessar trecho de vídeo",
        message: "Você conferiu o histórico e quer reprocessar o trecho sem envio confirmado?",
        detail:
          "O trecho pode já ter chegado ao assistente e produzido anotações. O STAG verificará o histórico novamente e só reenviará se não encontrar uma análise concluída ou em andamento. As notas existentes devem ser preservadas e conferidas para evitar duplicação.",
        buttons: ["Cancelar", "Reprocessar trecho"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return service!.snapshot();
      if (owner !== authorizationRevision)
        throw new Error("A conversa mudou durante a confirmação. Confira a análise novamente.");
    }
    if (action.type === "browserSession") {
      const state = service!.snapshot();
      if (!state.project || state.project.path !== action.projectPath)
        throw new Error("O projeto mudou. Abra o navegador no projeto desejado.");
      if (state.busy) throw new Error("Pare a execução antes de alterar a sessão do navegador.");
      if (state.browser.remember === action.remember) return state;
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Sessões do navegador",
        message: action.remember
          ? "Lembrar sessões de sites neste projeto?"
          : "Esquecer os logins deste projeto?",
        detail: action.remember
          ? "Cookies e dados dos sites ficarão neste computador, no perfil do STAG deste projeto, inclusive ao fechar o aplicativo ou abrir outra conversa. Ative antes de fazer login: a página atual será fechada e será preciso entrar novamente. Não há importação de senhas ou de outros navegadores. O modelo continua precisando de autorização por conversa. O site pode expirar o login ou exigir MFA."
          : "Os cookies e dados locais dos sites deste projeto serão apagados e a opção de lembrar será desativada. A página será fechada, o acesso do modelo será revogado e os próximos logins serão temporários. Isso não encerra sessões em outros computadores nem altera outros projetos.",
        buttons: ["Cancelar", action.remember ? "Lembrar sessões" : "Esquecer logins"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return service!.snapshot();
      if (owner !== authorizationRevision)
        throw new Error(
          "A conversa mudou durante a confirmação. Confira o projeto e tente novamente.",
        );
    }
    if (action.type === "browserConsent" && action.allow) {
      const owner = authorizationRevision;
      const result = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Controle do navegador",
        message: "Permitir que o modelo controle o navegador nesta conversa?",
        detail:
          "O modelo poderá navegar, ler páginas, clicar e preencher campos no navegador ao lado, inclusive sites já conectados. Texto e capturas das páginas serão enviados ao ChatGPT. Ações rotineiras não pedirão confirmação; envio de dados, exclusão, publicação, pagamentos, credenciais e ações incertas terão confirmação específica. Revogar acesso, fechar o navegador ou abrir outra conversa sempre encerra a autorização. Dados de sites só são mantidos se Lembrar sessões neste projeto estiver ativado; use Esquecer logins para apagá-los. O navegador usa uma sessão separada dos seus outros navegadores.",
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
        message:
          "Permitir controle de Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient nesta conversa?",
        detail:
          "O desktop ficará limitado a esses cinco aplicativos: capturas somente da janela escolhida, foco, mouse e teclado. Outros programas e atalhos globais ficam bloqueados, mesmo com aprovação. No FortiClient, consulta visual usa este consentimento; cliques, digitação e atalhos sempre pedem confirmação, incluindo reconectar a VPN. O acompanhamento ocorre durante a tarefa. Navegação web usa o navegador integrado, com autorização própria. A rotina não pede nova aprovação; exclusão, envio externo, publicação, pagamentos, credenciais, mudanças no sistema e interações incertas exigem confirmação específica. Capturas e títulos dessas janelas são enviados ao ChatGPT. Autorizar inicia nova conversa; revogar ou abrir outra encerra o acesso.",
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
  .then(() => (singleInstance ? start() : undefined))
  .catch((error: Error) => {
    dialog.showErrorBox("Não foi possível iniciar o STAG", error.message);
    app.quit();
  });
app.on("second-instance", () => {
  if (window?.isMinimized()) window.restore();
  window?.focus();
});
app.on("window-all-closed", () => app.quit());
let quitting = false;
app.on("before-quit", (event) => {
  taskbarAttention?.dispose();
  if (quitting) return;
  event.preventDefault();
  service?.dispose();
  desktopControl?.dispose();
  browser?.dispose();
  void Promise.all([service?.mediaSettled(), taskbarAttention?.settled()]).finally(() => {
    quitting = true;
    app.quit();
  });
});

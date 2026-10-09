import type { Page } from "@playwright/test";
import { emptySnapshot, type Action, type Model, type Snapshot } from "../../src/shared/types";
import { desktopApproval } from "../../src/main/desktop-tools";

export async function installBridge(page: Page, overrides: Partial<Snapshot> = {}) {
  await page.addInitScript(
    ({ initial, fortiOpening, fortiReconnect }) => {
      let state = initial;
      let count = 0;
      let fortiStage: "opening" | "connect" | null = null;
      const listeners = new Set<(snapshot: Snapshot) => void>();
      const conversations = new Map<string, Snapshot["items"]>();
      const models: Model[] = [
        {
          id: "fixture-model",
          model: "fixture-model",
          displayName: "Modelo de teste",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Médio" },
            { reasoningEffort: "high", description: "Alto" },
          ],
        },
      ];
      const publish = () => listeners.forEach((fn) => fn(structuredClone(state)));
      const resetBrowser = () => {
        state.browser.authorized = false;
        state.browser.activeTab = "documentation";
        for (const tab of ["documentation", "system"] as const)
          state.browser.tabs[tab] = {
            url: "",
            title: "",
            loading: false,
            canGoBack: false,
            canGoForward: false,
            error: null,
          };
        Object.assign(state.browser, state.browser.tabs.documentation);
      };
      const selectBrowserTab = (tab: "documentation" | "system") => {
        state.browser.activeTab = tab;
        Object.assign(state.browser, state.browser.tabs[tab]);
      };
      // Test-only delivery of main snapshots for states that require native/server activity.
      window.addEventListener("stag-fixture-snapshot", (event) => {
        Object.assign(state, (event as CustomEvent<Partial<Snapshot>>).detail);
        publish();
      });
      const queueIds = new Set<string>();
      const clearQueue = () => {
        fortiStage = null;
        state.mouseMovement = {
          enabled: false,
          moves: 0,
          skipped: 0,
          status: "Desligado",
          nextAttemptAt: null,
        };
        state.pendingVideo = null;
        state.queuedMessages = [];
        state.queuePaused = false;
        queueIds.clear();
      };
      const drainQueue = () => {
        if (state.busy || state.queuePaused || state.connection !== "ready") return;
        const next = state.queuedMessages.shift();
        if (next) void window.stag!.request({ type: "send", text: next.text });
      };
      const done = () => {
        state.busy = false;
        state.metrics.totalTokens = 1234;
        state.metrics.elapsedMs = 1200;
        if (state.threadId) conversations.set(state.threadId, structuredClone(state.items));
        publish();
        drainQueue();
      };
      window.stag = {
        getSnapshot: async () => structuredClone(state),
        onSnapshot: (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        request: async (action: Action) => {
          state.error = null;
          switch (action.type) {
            case "listApis":
              state.projectApis ||= {
                revision: crypto.randomUUID(),
                connections: [],
                canRemember: true,
                authorized: false,
                operation: null,
                metrics: { requests: 0, failures: 0, elapsedMs: 0, lastStatus: null },
              };
              break;
            case "saveApi": {
              const apis = state.projectApis!;
              const entry = {
                id: action.connectionId || crypto.randomUUID(),
                config: action.config,
                remember: action.remember,
                credentialAvailable:
                  !!action.secret ||
                  !!apis.connections.find((entry) => entry.id === action.connectionId)
                    ?.credentialAvailable,
                authenticated: action.config.auth.type !== "oauth2",
              };
              apis.connections = action.connectionId
                ? apis.connections.map((old) => (old.id === action.connectionId ? entry : old))
                : [...apis.connections, entry];
              apis.revision = crypto.randomUUID();
              apis.authorized = false;
              apis.operation = null;
              break;
            }
            case "deleteApi":
              state.projectApis!.connections = state.projectApis!.connections.filter(
                (entry) => entry.id !== action.connectionId,
              );
              state.projectApis!.revision = crypto.randomUUID();
              state.projectApis!.authorized = false;
              break;
            case "apiConsent":
              state.projectApis!.authorized = action.allow;
              break;
            case "authenticateApi":
              state.projectApis!.operation = {
                id: crypto.randomUUID(),
                connectionId: action.connectionId,
                status: "success",
                message: "API autenticada. As credenciais permanecem no STAG Plus.",
              };
              state.projectApis!.connections.find(
                (entry) => entry.id === action.connectionId,
              )!.authenticated = true;
              break;
            case "cancelApiLogin":
              state.projectApis!.operation = {
                id: action.operationId,
                connectionId: state.projectApis!.operation!.connectionId,
                status: "canceled",
                message: "Login da API cancelado.",
              };
              break;
            case "listDatabases":
              state.projectDatabases ||= {
                revision: crypto.randomUUID(),
                connections: [],
                canRememberPassword: true,
                authorized: false,
                metrics: { requests: 0, failures: 0, elapsedMs: 0, lastRows: null },
                test: null,
              };
              break;
            case "saveDatabase": {
              const databases = state.projectDatabases!;
              const entry = {
                id: action.connectionId || crypto.randomUUID(),
                config: action.config,
                passwordSaved: action.rememberPassword,
                passwordAvailable:
                  !!action.password ||
                  !!databases.connections.find((entry) => entry.id === action.connectionId)
                    ?.passwordAvailable,
              };
              databases.connections = action.connectionId
                ? databases.connections.map((previous) =>
                    previous.id === entry.id ? entry : previous,
                  )
                : [...databases.connections, entry];
              databases.revision = crypto.randomUUID();
              databases.test = null;
              databases.authorized = false;
              break;
            }
            case "deleteDatabase":
              state.projectDatabases!.connections = state.projectDatabases!.connections.filter(
                (entry) => entry.id !== action.connectionId,
              );
              state.projectDatabases!.revision = crypto.randomUUID();
              state.projectDatabases!.authorized = false;
              break;
            case "databaseConsent":
              state.projectDatabases!.authorized = action.allow;
              if (!action.allow) {
                state.busy = false;
                state.approvals = [];
                state.queuePaused = true;
              }
              break;
            case "testDatabase":
              state.projectDatabases!.test = {
                id: action.testId,
                status: "success",
                message: "Conexão validada. O teste não altera dados e a sessão foi fechada.",
                elapsedMs: 80,
              };
              break;
            case "cancelDatabaseTest":
              if (state.projectDatabases?.test) state.projectDatabases.test.status = "canceled";
              break;
            case "listBranches":
              state.projectBranches ||= {
                projectPath: action.projectPath,
                revision: crypto.randomUUID(),
                observedAt: new Date().toISOString(),
                incomplete: false,
                issues: [],
                message: null,
                repositories: ["frontend", "servicos/api"].map((path) => ({
                  id: crypto.randomUUID(),
                  path,
                  name: path,
                  current: "main",
                  detached: false,
                  unborn: false,
                  dirty: false,
                  error: null,
                  branches: ["main", "feature/cadastro", "origin/desenvolvimento"].map((name) => ({
                    name,
                    ref: name.startsWith("origin/") ? `refs/remotes/${name}` : `refs/heads/${name}`,
                    kind: name.startsWith("origin/") ? "remote" : "local",
                    current: name === "main",
                    occupied: false,
                  })),
                })),
              };
              state.projectBranches.revision = crypto.randomUUID();
              break;
            case "changeBranch": {
              if (state.mode === "read") throw new Error("Modo Leitura");
              const repo = state.projectBranches!.repositories.find(
                (repo) => repo.id === action.repositoryId,
              )!;
              const operation = action.operation;
              if (operation.kind === "create")
                repo.branches.push({
                  name: operation.name,
                  ref: `refs/heads/${operation.name}`,
                  kind: "local",
                  current: false,
                  occupied: false,
                });
              if (operation.kind === "switch") {
                repo.current = operation.branch;
                for (const branch of repo.branches)
                  branch.current = branch.name === operation.branch;
              }
              if (operation.kind === "rename") {
                const branch = repo.branches.find((branch) => branch.name === operation.branch)!;
                branch.name = operation.name;
                branch.ref = `refs/heads/${operation.name}`;
                if (branch.current) repo.current = operation.name;
              }
              if (operation.kind === "delete")
                repo.branches = repo.branches.filter((branch) => branch.name !== operation.branch);
              state.projectBranches!.revision = crypto.randomUUID();
              state.projectBranches!.message = "Operação local concluída.";
              break;
            }
            case "mouseMovement":
              if (state.mode !== "windows" || !state.threadId || state.threadId !== action.threadId)
                throw new Error("Autorize o desktop na conversa atual.");
              state.mouseMovement = {
                enabled: action.enabled,
                moves: 0,
                skipped: 0,
                status: action.enabled ? "Ativo · a cada 5 min" : "Desligado",
                nextAttemptAt: action.enabled ? Date.now() + 300000 : null,
              };
              break;
            case "analyzeVideo":
              state.threadId ||= `thread-${++count}`;
              state.videoAnalysis = {
                id: crypto.randomUUID(),
                name: "reuniao-sintetica-longa.mp4",
                threadId: state.threadId,
                mode: state.mode,
                seconds: 5473,
                completed: 0,
                total: 19,
                status: "running",
                working: true,
                phase: "Extraindo imagens do primeiro trecho…",
                stage: "preparing",
                phaseStartedAt: Date.now(),
                error: null,
              };
              break;
            case "videoAnalysis":
              if (!state.videoAnalysis || state.videoAnalysis.id !== action.id)
                throw new Error("Análise indisponível");
              if (action.control === "pause") {
                state.mouseMovement = {
                  enabled: false,
                  moves: 0,
                  skipped: 0,
                  status: "Desligado",
                  nextAttemptAt: null,
                };
                state.videoAnalysis.status = "paused";
                state.videoAnalysis.working = false;
                state.videoAnalysis.stage = "idle";
                state.videoAnalysis.phaseStartedAt = null;
                state.videoAnalysis.completed = 1;
                state.videoAnalysis.phase =
                  "Progresso salvo. Retome com o arquivo original disponível.";
              } else if (action.control === "cancel") {
                state.mouseMovement = {
                  enabled: false,
                  moves: 0,
                  skipped: 0,
                  status: "Desligado",
                  nextAttemptAt: null,
                };
                state.videoAnalysis.status = "cancelled";
                state.videoAnalysis.working = false;
                state.videoAnalysis.stage = "idle";
                state.videoAnalysis.phaseStartedAt = null;
                state.videoAnalysis.phase =
                  "Análise cancelada. As anotações já verificadas são preservadas.";
              } else {
                state.videoAnalysis.status = "running";
                state.videoAnalysis.working = true;
                state.videoAnalysis.stage = "preparing";
                state.videoAnalysis.phaseStartedAt = Date.now();
                state.videoAnalysis.phase = "Extraindo imagens do próximo trecho…";
                state.threadId = state.videoAnalysis.threadId;
                state.mode = state.videoAnalysis.mode;
              }
              break;
            case "selectVideo":
              state.pendingVideo = {
                status: "ready",
                summary: {
                  id: crypto.randomUUID(),
                  name: "projeto-sintetico.mp4",
                  seconds: 42,
                  frames: 3,
                  audio: "transcribed",
                },
              };
              break;
            case "removeVideo":
              state.pendingVideo = null;
              break;
            case "connect":
              state.mouseMovement = {
                enabled: false,
                moves: 0,
                skipped: 0,
                status: "Desligado",
                nextAttemptAt: null,
              };
              state.connection = "ready";
              break;
            case "login":
              state.account = { email: "fixture@example.invalid", plan: "teste" };
              state.models = models;
              state.model = models[0].model;
              state.effort = "medium";
              break;
            case "logout":
              clearQueue();
              state.account = null;
              state.models = [];
              state.items = [];
              break;
            case "selectProject":
              clearQueue();
              state.projectBranches = null;
              state.project = {
                path: "C:\\Projetos\\exemplo",
                name: "exemplo",
                git: {
                  phase: "complete",
                  scanned: 4,
                  found: 2,
                  added: 2,
                  verified: 2,
                  skipped: 0,
                  failures: 0,
                  incomplete: false,
                  issues: [],
                },
              };
              state.mode = "project";
              state.threadId = null;
              state.items = [];
              state.plan = [];
              state.diff = "";
              resetBrowser();
              break;
            case "projectSources":
              if (state.busy || action.projectPath !== state.project?.path)
                throw new Error("O projeto mudou ou está em execução.");
              state.projectSources = action.sources;
              break;
            case "preferences":
              if (action.mode) {
                clearQueue();
                state.mode = action.mode;
                state.items = [];
                state.threadId = null;
              }
              if (action.model) state.model = action.model;
              if (action.effort) state.effort = action.effort;
              break;
            case "newChat":
              clearQueue();
              state.items = [];
              state.threadId = null;
              state.plan = [];
              state.diff = "";
              state.mode = "project";
              state.metrics.totalTokens = 0;
              resetBrowser();
              break;
            case "browserVisibility":
              state.browser.visible = action.visible;
              if (!action.visible) {
                resetBrowser();
              }
              break;
            case "browserConsent":
              state.browser.authorized = action.allow;
              if (!action.allow) {
                resetBrowser();
                state.busy = false;
                state.approvals = [];
              }
              break;
            case "browserSession":
              if (state.busy || action.projectPath !== state.project?.path)
                throw new Error("O projeto mudou ou está em execução.");
              state.browser.remember = action.remember;
              resetBrowser();
              state.queuePaused = true;
              break;
            case "browserTab":
              if (state.busy || state.approvals.length)
                throw new Error("Pare o modelo antes de navegar manualmente.");
              selectBrowserTab(action.tab);
              break;
            case "browserControl":
              if (state.busy || state.approvals.length)
                throw new Error("Pare o modelo antes de navegar manualmente.");
              selectBrowserTab(action.control.tab ?? state.browser.activeTab);
              if (action.control.action === "navigate") {
                state.browser.url = action.control.url;
                state.browser.title = "Documentação sintética";
                state.browser.canGoBack = true;
                state.browser.tabs[state.browser.activeTab] = {
                  url: state.browser.url,
                  title:
                    state.browser.activeTab === "documentation"
                      ? "Documentação sintética"
                      : "Sistema sintético",
                  loading: false,
                  canGoBack: true,
                  canGoForward: false,
                  error: null,
                };
                selectBrowserTab(state.browser.activeTab);
              }
              break;
            case "browserBounds":
              break;
            case "resume":
              if (state.threadId !== action.threadId) clearQueue();
              state.threadId = action.threadId;
              state.items = conversations.get(action.threadId) || [];
              break;
            case "send": {
              if (action.videoId) {
                action.text += `${action.text ? "\n\n" : ""}Vídeo do projeto: projeto-sintetico.mp4`;
                state.pendingVideo = null;
              }
              state.busy = true;
              if (!state.threadId) {
                state.threadId = `thread-${++count}`;
                state.threads.unshift({
                  id: state.threadId,
                  title: action.text || "Solicitação com imagens",
                  updatedAt: Date.now(),
                });
              }
              state.items.push({
                id: `user-${++count}`,
                kind: "user",
                text: action.text,
                ...(action.images?.length ? { images: action.images } : {}),
              });
              if (action.text.includes("navegador") && state.browser.authorized) {
                if (action.text.includes("crítico"))
                  state.approvals = [
                    {
                      id: "browser-approval",
                      kind: "browser",
                      title: "Confirmar ação no navegador?",
                      detail: "Intenção: Enviar dados ao serviço externo\nElemento: e2",
                    },
                  ];
                else {
                  selectBrowserTab("documentation");
                  state.browser.url = "https://fixture.invalid/docs";
                  state.browser.title = "Documentação sintética";
                  state.browser.tabs.documentation = {
                    url: state.browser.url,
                    title: state.browser.title,
                    loading: false,
                    canGoBack: true,
                    canGoForward: false,
                    error: null,
                  };
                  state.items.push({
                    id: `browser-${++count}`,
                    kind: "assistant",
                    text: "Navegador: documentação consultada.",
                  });
                  done();
                }
              } else if (action.text.includes("desktop") && state.mode === "windows") {
                if (action.text.startsWith("desktop forticlient abrir")) {
                  fortiStage = "opening";
                  state.approvals = [{ id: "forti-opening", kind: "desktop", ...fortiOpening }];
                } else if (action.text.includes("crítico"))
                  state.approvals = [
                    {
                      id: "desktop-approval",
                      kind: "desktop",
                      title: "Confirmar ação no desktop?",
                      detail:
                        "Intenção: Enviar requisição ao serviço externo\nPosição física: x=120, y=180",
                    },
                  ];
                else {
                  state.items.push({
                    id: `desktop-${++count}`,
                    kind: "status",
                    text: "windows_desktop",
                    status: "completed",
                  });
                  state.items.push({
                    id: `assistant-${++count}`,
                    kind: "assistant",
                    text: "Desktop: captura e navegação sintéticas concluídas.",
                  });
                  done();
                }
              } else if (/aprovar|recusar/.test(action.text)) {
                state.approvals = [
                  {
                    id: "approval",
                    kind: "command",
                    title: "Permitir este comando?",
                    detail: "npm test\nC:\\Projetos\\exemplo",
                  },
                ];
              } else if (action.text.includes("perguntar")) {
                state.approvals = [
                  {
                    id: "question",
                    kind: "questions",
                    title: "O assistente precisa de uma resposta",
                    detail: "",
                    questions: [
                      {
                        id: "stack",
                        question: "Qual stack deseja?",
                        options: [{ label: "TypeScript", description: "Tipos" }],
                      },
                    ],
                  },
                ];
              } else if (action.text.includes("erro")) {
                state.queuePaused = true;
                state.error = "Codex encerrou. Reconecte para continuar.";
                state.connection = "error";
                state.busy = false;
              } else if (!action.text.includes("lento")) {
                setTimeout(() => {
                  state.items.push({
                    id: `assistant-${++count}`,
                    kind: "assistant",
                    phase: "final_answer",
                    text: action.text.includes("html")
                      ? "Texto seguro. <script>window.hacked=true</script>\n\n![rastreador](https://example.invalid/tracker.png)\n\n[Documentação](https://learn.chatgpt.com/docs/app-server)"
                      : "Li o projeto e validei o fluxo.\n\n**Pronto para o próximo passo.**\n\n```typescript\nconst ready = true;\n```\n\n| Etapa | Resultado |\n| --- | --- |\n| Testes | OK |",
                  });
                  done();
                }, 25);
              }
              break;
            }
            case "answer": {
              if (fortiStage === "opening" && action.accept) {
                state.items.push({
                  id: `assistant-${++count}`,
                  kind: "assistant",
                  text: "Console sintético aberto; isso não comprova conexão da VPN.",
                });
                fortiStage = "connect";
                state.approvals = [{ id: "forti-connect", kind: "desktop", ...fortiReconnect }];
                break;
              }
              if (fortiStage) {
                state.items.push({
                  id: `assistant-${++count}`,
                  kind: "assistant",
                  text: action.accept
                    ? "VPN sintética: estado visível conferido após reconexão."
                    : "Desktop: ação recusada.",
                });
                fortiStage = null;
                state.approvals = [];
                done();
                break;
              }
              const desktop = state.approvals[0]?.kind === "desktop";
              const browser = state.approvals[0]?.kind === "browser";
              state.approvals = [];
              state.items.push({
                id: `assistant-${++count}`,
                kind: "assistant",
                text: browser
                  ? action.accept
                    ? "Navegador: ação crítica concluída."
                    : "Navegador: ação recusada."
                  : desktop
                    ? action.accept
                      ? "Desktop: ação crítica sintética concluída."
                      : "Desktop: ação recusada."
                    : action.accept === false
                      ? "Ação recusada. Nenhum comando executado."
                      : "Resposta recebida. Fluxo concluído.",
              });
              done();
              break;
            }
            case "stop":
              fortiStage = null;
              state.mouseMovement = {
                enabled: false,
                moves: 0,
                skipped: 0,
                status: "Desligado",
                nextAttemptAt: null,
              };
              state.queuePaused = true;
              state.approvals = [];
              state.items.push({
                id: `status-${++count}`,
                kind: "status",
                text: "Execução interrompida.",
              });
              done();
              break;
            case "enqueue":
              if (action.threadId !== state.threadId) throw new Error("A conversa mudou.");
              if (!queueIds.has(action.id)) {
                state.queuedMessages.push({ id: action.id, text: action.text, status: "pending" });
                queueIds.add(action.id);
              }
              drainQueue();
              break;
            case "removeQueued":
              state.queuedMessages = state.queuedMessages.filter((item) => item.id !== action.id);
              break;
            case "pauseQueue":
              state.queuePaused = action.paused;
              drainQueue();
              break;
            case "cancelLogin":
              state.loginPending = false;
              break;
            case "openLink":
              break;
          }
          publish();
          return structuredClone(state);
        },
      };
    },
    {
      initial: {
        ...structuredClone(emptySnapshot),
        connection: "ready",
        platform: "win32",
        browser: { ...emptySnapshot.browser, available: true },
        ...overrides,
      } satisfies Snapshot,
      fortiOpening: desktopApproval({
        action: "open_forticlient",
        risk: "critical",
        intent: "Abrir console oficial para conferir o perfil VPN sintético",
      }),
      fortiReconnect: desktopApproval({
        action: "click",
        processId: 8383,
        x: 120,
        y: 180,
        risk: "critical",
        intent: "Reconectar o perfil VPN sintético no FortiClient",
      }),
    },
  );
}

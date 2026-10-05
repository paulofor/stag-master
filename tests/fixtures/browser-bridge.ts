import type { Page } from "@playwright/test";
import { emptySnapshot, type Action, type Model, type Snapshot } from "../../src/shared/types";

export async function installBridge(page: Page, overrides: Partial<Snapshot> = {}) {
  await page.addInitScript(
    (initial: Snapshot) => {
      let state = initial;
      let count = 0;
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
      const done = () => {
        state.busy = false;
        state.metrics.totalTokens = 1234;
        state.metrics.elapsedMs = 1200;
        if (state.threadId) conversations.set(state.threadId, structuredClone(state.items));
        publish();
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
            case "connect":
              state.connection = "ready";
              break;
            case "login":
              state.account = { email: "fixture@example.invalid", plan: "teste" };
              state.models = models;
              state.model = models[0].model;
              state.effort = "medium";
              break;
            case "logout":
              state.account = null;
              state.models = [];
              state.items = [];
              break;
            case "selectProject":
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
              state.browser.authorized = false;
              state.browser.url = "";
              break;
            case "preferences":
              if (action.mode) {
                state.mode = action.mode;
                state.items = [];
                state.threadId = null;
              }
              if (action.model) state.model = action.model;
              if (action.effort) state.effort = action.effort;
              break;
            case "newChat":
              state.items = [];
              state.threadId = null;
              state.plan = [];
              state.diff = "";
              state.mode = "project";
              state.metrics.totalTokens = 0;
              state.browser.authorized = false;
              state.browser.url = "";
              break;
            case "browserVisibility":
              state.browser.visible = action.visible;
              if (!action.visible) {
                state.browser.authorized = false;
                state.browser.url = "";
              }
              break;
            case "browserConsent":
              state.browser.authorized = action.allow;
              if (!action.allow) {
                state.browser.url = "";
                state.busy = false;
                state.approvals = [];
              }
              break;
            case "browserControl":
              if (action.control.action === "navigate") {
                state.browser.url = action.control.url;
                state.browser.title = "Documentação sintética";
                state.browser.canGoBack = true;
              }
              break;
            case "browserBounds":
              break;
            case "resume":
              state.threadId = action.threadId;
              state.items = conversations.get(action.threadId) || [];
              break;
            case "send": {
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
                  state.browser.url = "https://fixture.invalid/docs";
                  state.browser.title = "Documentação sintética";
                  state.items.push({
                    id: `browser-${++count}`,
                    kind: "assistant",
                    text: "Navegador: documentação consultada.",
                  });
                  done();
                }
              } else if (action.text.includes("desktop") && state.mode === "windows") {
                if (action.text.includes("crítico"))
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
              state.approvals = [];
              state.items.push({
                id: `status-${++count}`,
                kind: "status",
                text: "Execução interrompida.",
              });
              done();
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
      ...structuredClone(emptySnapshot),
      connection: "ready",
      platform: "win32",
      browser: { ...emptySnapshot.browser, available: true },
      ...overrides,
    } satisfies Snapshot,
  );
}

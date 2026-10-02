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
              state.project = { path: "C:\\Projetos\\exemplo", name: "exemplo" };
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
                  title: action.text,
                  updatedAt: Date.now(),
                });
              }
              state.items.push({ id: `user-${++count}`, kind: "user", text: action.text });
              if (action.text.includes("desktop") && state.mode === "windows") {
                state.approvals = [
                  {
                    id: "desktop-approval",
                    kind: "desktop",
                    title: "Permitir captura de tela?",
                    detail:
                      "A imagem da tela principal será enviada ao ChatGPT para executar esta tarefa.",
                  },
                ];
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
              state.approvals = [];
              state.items.push({
                id: `assistant-${++count}`,
                kind: "assistant",
                text: desktop
                  ? action.accept
                    ? "Desktop: captura sintética concluída."
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
      ...overrides,
    } satisfies Snapshot,
  );
}

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";

// Strict bidirectional fake, no account/LLM/network/desktop dependencies.
let initialized = false;
let loggedIn = false;
let count = 0;
let serverId = 500;
const calls = [];
const threads = new Map();
// Recovery tests opt into a file in their temporary directory; never use the user's Codex home.
const stateFile = process.env.STAG_FIXTURE_STATE;
if (stateFile) {
  try {
    const stored = JSON.parse(readFileSync(stateFile, "utf8"));
    loggedIn = stored.loggedIn;
    count = stored.count;
    for (const thread of stored.threads) threads.set(thread.id, thread);
  } catch {}
}
const persist = () => {
  if (stateFile)
    writeFileSync(stateFile, JSON.stringify({ loggedIn, count, threads: [...threads.values()] }));
};
const waiting = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const failure = (id, message) => send({ id, error: { code: -32601, message } });

function finish(thread, turn, status = "completed", error) {
  turn.status = status;
  turn.error = error || null;
  persist();
  notify("thread/tokenUsage/updated", {
    threadId: thread.id,
    turnId: turn.id,
    tokenUsage: {
      total: { totalTokens: 1234 },
      last: { totalTokens: 1234 },
      modelContextWindow: 200000,
    },
  });
  notify("turn/completed", { threadId: thread.id, turn });
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: turn.id,
    itemId: `assistant-${turn.id}`,
    delta: "STALE_COMPLETED_TURN",
  });
}

function desktopCall(
  thread,
  turn,
  args,
  next,
  overrides = {},
  duplicate = false,
  tool = "windows_desktop",
) {
  const requestId = ++serverId;
  const item = {
    id: `desktop-${requestId}`,
    type: "dynamicToolCall",
    tool,
    arguments: args,
    status: "inProgress",
  };
  turn.items.push(item);
  notify("item/started", { threadId: thread.id, turnId: turn.id, item });
  waiting.set(requestId, (answer) => {
    const success = answer.result?.success === true;
    item.status = success ? "completed" : "failed";
    item.success = success;
    item.contentItems = answer.result?.contentItems || [];
    notify("serverRequest/resolved", { threadId: thread.id, turnId: turn.id, requestId });
    notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
    if (success && next) next(answer);
    else
      response(
        thread,
        turn,
        `${tool === "stag_browser" ? "Navegador" : "Desktop"}: ${success ? "executado" : "recusado"}.`,
      );
  });
  const request = {
    id: requestId,
    method: "item/tool/call",
    params: {
      threadId: thread.id,
      turnId: turn.id,
      callId: item.id,
      namespace: null,
      tool,
      arguments: args,
      ...overrides,
    },
  };
  send(request);
  if (duplicate) send(request);
}
function response(
  thread,
  turn,
  message = "Li o projeto e validei o fluxo.\n\n**Pronto para o próximo passo.**\n\n```typescript\nconst ready = true;\n```\n\n| Etapa | Resultado |\n| --- | --- |\n| Testes | OK |",
) {
  const item = {
    id: `assistant-${turn.id}`,
    type: "agentMessage",
    text: "",
    phase: "final_answer",
  };
  turn.items.push(item);
  notify("item/started", { threadId: thread.id, turnId: turn.id, item: { ...item } });
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: turn.id,
    itemId: item.id,
    delta: message.slice(0, 15),
  });
  notify("item/agentMessage/delta", {
    threadId: thread.id,
    turnId: turn.id,
    itemId: item.id,
    delta: message.slice(15),
  });
  item.text = message;
  notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
  finish(thread, turn);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const { id, method, params: p = {} } = message;
  if (!method) {
    calls.push({ responseId: id, result: message.result, error: message.error });
    const callback = waiting.get(id);
    waiting.delete(id);
    callback?.(message);
    return;
  }
  calls.push({ method, params: p });
  if (method === "initialize") {
    reply(id, { userAgent: "fixture", platformFamily: "unix", platformOs: "linux" });
    return;
  }
  if (method === "initialized") {
    initialized = true;
    return;
  }
  if (!initialized) {
    failure(id, "Not initialized");
    return;
  }
  switch (method) {
    case "windowsSandbox/setupStart":
      reply(id, { started: true });
      notify("windowsSandbox/setupCompleted", { mode: "unelevated", success: true, error: null });
      break;
    case "account/read":
      reply(id, {
        account: loggedIn
          ? {
              type: "chatgpt",
              email: "fixture@example.invalid",
              planType: "test",
              accessToken: "MUST_NOT_REACH_RENDERER",
            }
          : null,
        requiresOpenaiAuth: true,
      });
      break;
    case "account/login/start":
      if (p.type !== "chatgpt") {
        failure(id, "ChatGPT only");
        break;
      }
      reply(id, {
        type: "chatgpt",
        loginId: "fixture-login",
        authUrl: "https://auth.openai.com/fixture-login",
      });
      setTimeout(() => {
        loggedIn = true;
        persist();
        notify("account/login/completed", { loginId: "fixture-login", success: true, error: null });
        notify("account/updated", { authMode: "chatgpt", planType: "test" });
      }, 20);
      break;
    case "account/login/cancel":
      reply(id, {});
      break;
    case "account/logout":
      loggedIn = false;
      persist();
      reply(id, {});
      notify("account/updated", { authMode: null, planType: null });
      break;
    case "model/list":
      reply(id, {
        data: [
          {
            id: "fixture-model",
            model: "fixture-model",
            displayName: "Modelo de teste",
            defaultReasoningEffort: "medium",
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "medium", description: "Padrão de teste" },
              { reasoningEffort: "high", description: "Mais esforço" },
            ],
          },
        ],
        nextCursor: null,
      });
      break;
    case "thread/start": {
      if (
        !p.cwd ||
        p.approvalPolicy !== "on-request" ||
        !["read-only", "workspace-write", "danger-full-access"].includes(p.sandbox)
      ) {
        failure(id, "Invalid thread policy");
        break;
      }
      const thread = {
        id: `fixture-thread-${++count}`,
        cwd: p.cwd,
        turns: [],
        updatedAt: 100,
        preview: "",
        dynamicTools: p.dynamicTools || [],
        developerInstructions: p.developerInstructions || "",
      };
      threads.set(thread.id, thread);
      persist();
      reply(id, { thread });
      notify("thread/started", { thread });
      break;
    }
    case "thread/resume": {
      const thread = threads.get(p.threadId);
      if (!thread) failure(id, "Missing thread");
      else {
        if (p.developerInstructions !== undefined)
          thread.developerInstructions = p.developerInstructions;
        persist();
        reply(id, { thread });
      }
      break;
    }
    case "thread/list":
      reply(id, { data: [...threads.values()].filter((t) => t.cwd === p.cwd), nextCursor: null });
      break;
    case "turn/start": {
      const thread = threads.get(p.threadId);
      if (!thread) {
        failure(id, "Missing thread");
        break;
      }
      const input = p.input[0].text;
      const turn = {
        id: `fixture-turn-${++count}`,
        status: "inProgress",
        items: [{ id: `user-${count}`, type: "userMessage", content: p.input }],
      };
      thread.turns.push(turn);
      thread.preview = input;
      if (!input.includes("desktop sem início"))
        notify("turn/started", { threadId: thread.id, turn });
      notify("item/started", { threadId: thread.id, turnId: turn.id, item: turn.items[0] });
      notify("turn/plan/updated", {
        threadId: thread.id,
        turnId: turn.id,
        plan: [
          { step: "Ler o projeto", status: "completed" },
          { step: "Validar o fluxo", status: "inProgress" },
        ],
      });
      // Event isolation and raw-reasoning regression probes.
      notify("item/agentMessage/delta", {
        threadId: "other-thread",
        turnId: "other-turn",
        itemId: "leaked",
        delta: "WRONG_THREAD",
      });
      notify("item/started", {
        threadId: thread.id,
        turnId: turn.id,
        item: { id: "reasoning", type: "reasoning", content: ["PRIVATE_REASONING"] },
      });
      if (!input.includes("rápido") && !input.includes("desktop sem início"))
        reply(id, { turn: { ...turn, items: [] } });
      if (input.includes("sair")) {
        setTimeout(() => process.exit(7), 20);
        break;
      }
      if (input.includes("lento")) break;
      if (input.includes("erro")) {
        finish(thread, turn, "failed", { message: "Falha de teste recuperável." });
        break;
      }
      // Deterministic routing contract probe, not a simulation of model reasoning.
      if (input.startsWith("abrir aplicação local ")) {
        if (!thread.developerInstructions.includes("use exclusivamente stag_browser")) {
          response(thread, turn, "Fixture: contrato de navegação integrado ausente.");
          break;
        }
        if (thread.developerInstructions.includes("stag_browser não está registrado")) {
          response(thread, turn, "Abra uma nova conversa e clique em Autorizar navegador.");
          break;
        }
        if (!thread.developerInstructions.includes("O cliente autorizou stag_browser")) {
          response(thread, turn, "Clique em Autorizar navegador no painel do STAG.");
          break;
        }
        desktopCall(
          thread,
          turn,
          {
            action: "navigate",
            url: input.slice("abrir aplicação local ".length),
            risk: "routine",
            intent: "Conferir aplicação local no navegador do STAG",
          },
          () =>
            desktopCall(
              thread,
              turn,
              { action: "snapshot" },
              () => response(thread, turn, "Navegador: aplicação local conferida no STAG."),
              {},
              false,
              "stag_browser",
            ),
          {},
          false,
          "stag_browser",
        );
        break;
      }
      if (/aprovar|recusar/.test(input)) {
        const item = {
          id: `command-${count}`,
          type: "commandExecution",
          command: "npm test",
          cwd: p.cwd,
          status: "inProgress",
        };
        turn.items.push(item);
        notify("item/started", { threadId: thread.id, turnId: turn.id, item });
        const requestId = ++serverId;
        waiting.set(requestId, (answer) => {
          item.status = answer.result?.decision === "accept" ? "completed" : "declined";
          item.aggregatedOutput =
            item.status === "completed" ? "Todos os testes passaram." : "Comando recusado.";
          notify("serverRequest/resolved", { threadId: thread.id, requestId });
          notify("item/completed", { threadId: thread.id, turnId: turn.id, item });
          response(thread, turn);
        });
        send({
          id: requestId,
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: item.id,
            command: item.command,
            cwd: p.cwd,
            availableDecisions: ["accept", "decline"],
            reason: "Executar a validação local.",
          },
        });
        break;
      }
      if (input.includes("perguntar")) {
        const requestId = ++serverId;
        waiting.set(requestId, () => {
          notify("serverRequest/resolved", { threadId: thread.id, requestId });
          response(thread, turn);
        });
        send({
          id: requestId,
          method: "item/tool/requestUserInput",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: "question",
            questions: [
              {
                id: "stack",
                question: "Qual stack deseja?",
                isSecret: false,
                options: [
                  { label: "TypeScript", description: "Tipagem estática" },
                  { label: "JavaScript", description: "Sem tipagem" },
                ],
              },
            ],
            isBlocking: true,
            autoResolutionMs: null,
          },
        });
        break;
      }
      if (input.includes("desktop")) {
        if (
          !thread.dynamicTools.some((tool) => tool.name === "windows_desktop") &&
          !input.includes("forçar")
        ) {
          response(
            thread,
            turn,
            "Clique em Autorizar desktop e confirme o acesso para controlar o Windows em uma nova conversa.",
          );
          break;
        }
        if (input.includes("desktop sem início")) {
          // Hold both start signals until the reverse request is answered, without a short timeout.
          desktopCall(thread, turn, { action: "list_windows" }, () => {
            notify("turn/started", { threadId: thread.id, turn });
            response(thread, turn, "Desktop: executado antes da resposta de início.");
            reply(id, { turn: { id: turn.id, status: "inProgress", items: [] } });
          });
        } else if (input.includes("sequência")) {
          const operations = [
            { action: "list_windows" },
            { action: "screenshot" },
            { action: "focus_window", processId: 4242 },
            {
              action: "click",
              x: 120,
              y: 180,
              button: "left",
              clicks: 2,
              risk: "routine",
              intent: "Abrir editor local",
            },
            {
              action: "type_text",
              processId: 4242,
              text: "Teste + ^ % {texto}",
              risk: "routine",
              intent: "Editar texto local",
            },
            {
              action: "send_keys",
              processId: 4242,
              keys: "^s",
              risk: "routine",
              intent: "Salvar arquivo local",
            },
            { action: "scroll", x: 120, y: 180, delta: -240 },
            { action: "screenshot" },
          ];
          const next = () => {
            const args = operations.shift();
            if (args) desktopCall(thread, turn, args, next);
            else response(thread, turn, "Desktop: sequência concluída e resultado conferido.");
          };
          next();
        } else if (input.includes("paralelo")) {
          let remaining = 2;
          const next = () => {
            if (--remaining === 0) response(thread, turn, "Desktop: duas operações concluídas.");
          };
          desktopCall(thread, turn, { action: "screenshot" }, next);
          desktopCall(thread, turn, { action: "scroll", x: 120, y: 180, delta: -120 }, next);
        } else {
          desktopCall(
            thread,
            turn,
            input.includes("desktop inválido")
              ? { action: "click", x: "invalid", y: 0 }
              : input.includes("crítico")
                ? {
                    action: "click",
                    x: 120,
                    y: 180,
                    risk: "critical",
                    intent:
                      input.split("crítico")[1].trim() || "Enviar requisição ao serviço externo",
                  }
                : input.includes("legado")
                  ? { action: "click", x: 120, y: 180 }
                  : input.includes("enter")
                    ? {
                        action: "send_keys",
                        processId: 4242,
                        keys: "{ENTER}",
                        risk: "routine",
                        intent: "Confirmar entrada",
                      }
                    : input.includes("quebra")
                      ? {
                          action: "type_text",
                          processId: 4242,
                          text: "comando\n",
                          risk: "routine",
                          intent: "Digitar comando",
                        }
                      : input.includes("risco inválido")
                        ? {
                            action: "click",
                            x: 120,
                            y: 180,
                            risk: "unknown",
                            intent: "Abrir editor",
                          }
                        : { action: "list_windows" },
            null,
            input.includes("namespace")
              ? { namespace: "unknown" }
              : input.includes("outro turno")
                ? { turnId: "wrong-turn" }
                : input.includes("outro thread")
                  ? { threadId: "wrong-thread" }
                  : input.includes("sem turno")
                    ? { turnId: null }
                    : {},
            input.includes("duplicado"),
          );
        }
        break;
      }
      if (input.includes("navegador")) {
        if (
          !thread.dynamicTools.some((tool) => tool.name === "stag_browser") &&
          !input.includes("forçar")
        ) {
          response(thread, turn, "Abra uma nova conversa e clique em Autorizar navegador.");
          break;
        }
        const call = (args, next = null, duplicate = false) =>
          desktopCall(
            thread,
            turn,
            args,
            next,
            input.includes("outro thread")
              ? { threadId: "other-thread" }
              : input.includes("outro turno")
                ? { turnId: "other-turn" }
                : input.includes("namespace")
                  ? { namespace: "unknown" }
                  : {},
            duplicate,
            "stag_browser",
          );
        if (input.includes("sequência")) {
          const operations = [
            {
              action: "navigate",
              url: "https://fixture.invalid/",
              risk: "routine",
              intent: "Ler documentação sintética",
            },
            { action: "snapshot" },
            {
              action: "fill",
              pageId: "fixture-page",
              ref: "e1",
              text: "teste local",
              risk: "routine",
              intent: "Editar campo local de teste",
            },
            {
              action: "click",
              pageId: "fixture-page",
              ref: "e2",
              risk: "routine",
              intent: "Expandir documentação",
            },
            { action: "scroll", delta: 300 },
            { action: "screenshot" },
          ];
          const next = () => {
            const args = operations.shift();
            if (args) call(args, next);
            else response(thread, turn, "Navegador: sequência concluída.");
          };
          next();
        } else if (input.includes("paralelo") || input.includes("misto")) {
          let remaining = 2;
          const next = () => {
            if (--remaining === 0) response(thread, turn, "Navegador: operações concluídas.");
          };
          if (input.includes("misto")) desktopCall(thread, turn, { action: "list_windows" }, next);
          else call({ action: "snapshot" }, next);
          call({ action: "scroll", delta: 200 }, next);
        } else if (/fluxo real|envio real|senha real/.test(input)) {
          const url = input.split(/fluxo real|envio real|senha real/)[1].trim();
          call({ action: "navigate", url, risk: "routine", intent: "Ler site sintético" }, () => {
            call({ action: "snapshot" }, (answer) => {
              const doc = JSON.parse(answer.result?.contentItems?.[0]?.text || "{}");
              const label = input.includes("envio real")
                ? "Enviar sintético"
                : input.includes("senha real")
                  ? "Senha sintética"
                  : "Texto local";
              const ref = doc.elements?.find((el) => el.label === label)?.ref;
              if (!ref) {
                response(thread, turn, "Navegador: campo não encontrado.");
                return;
              }
              call(
                {
                  action: input.includes("envio real") ? "click" : "fill",
                  pageId: doc.pageId,
                  ref,
                  ...(!input.includes("envio real") ? { text: "feito pelo modelo" } : {}),
                  risk: "routine",
                  intent: `Interagir com ${label} no site sintético`,
                },
                () => response(thread, turn, "Navegador: campo preenchido pelo modelo."),
              );
            });
          });
        } else {
          call(
            input.includes("inválido")
              ? { action: "evaluate", script: "unsafe" }
              : input.includes("crítico")
                ? {
                    action: "click",
                    pageId: "fixture-page",
                    ref: "e2",
                    risk: "critical",
                    intent: "Enviar dados ao serviço externo",
                  }
                : { action: "snapshot" },
            null,
            input.includes("duplicado"),
          );
        }
        break;
      }
      if (input.includes("desconhecido")) {
        const requestId = ++serverId;
        waiting.set(requestId, () => response(thread, turn));
        send({
          id: requestId,
          method: "future/request",
          params: { threadId: thread.id, turnId: turn.id },
        });
        break;
      }
      if (input.includes("permissao")) {
        const requestId = ++serverId;
        waiting.set(requestId, () => response(thread, turn));
        send({
          id: requestId,
          method: "item/permissions/requestApproval",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            permissions: { network: { enabled: true } },
          },
        });
        break;
      }
      const finalText = input.includes("html")
        ? "Teste seguro. <script>window.hacked=true</script>\n\n![rastreador](https://example.invalid/tracker.png)\n\n[documentação](https://learn.chatgpt.com/docs/app-server)"
        : undefined;
      response(thread, turn, finalText);
      if (input.includes("rápido"))
        reply(id, { turn: { id: turn.id, status: "inProgress", items: [] } });
      break;
    }
    case "turn/interrupt": {
      const thread = threads.get(p.threadId);
      const turn = thread?.turns.find((t) => t.id === p.turnId);
      if (!turn) failure(id, "Missing turn");
      else {
        reply(id, {});
        finish(thread, turn, "interrupted");
      }
      break;
    }
    case "_fixture/readCalls":
      reply(id, calls);
      break;
    case "_fixture/timeout":
      break;
    case "_fixture/malformed":
      process.stdout.write("not-json\n");
      break;
    case "_fixture/exit":
      process.exit(2);
      break;
    default:
      failure(id, `Unsupported method ${method}`);
  }
});

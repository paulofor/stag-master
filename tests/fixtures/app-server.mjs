import { createInterface } from "node:readline";

// Strict bidirectional fake, no account/LLM/network/desktop dependencies.
let initialized = false;
let loggedIn = false;
let count = 0;
let serverId = 500;
const calls = [];
const threads = new Map();
const waiting = new Map();
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (id, result) => send({ id, result });
const failure = (id, message) => send({ id, error: { code: -32601, message } });

function finish(thread, turn, status = "completed", error) {
  turn.status = status;
  turn.error = error || null;
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
        notify("account/login/completed", { loginId: "fixture-login", success: true, error: null });
        notify("account/updated", { authMode: "chatgpt", planType: "test" });
      }, 20);
      break;
    case "account/login/cancel":
      reply(id, {});
      break;
    case "account/logout":
      loggedIn = false;
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
      };
      threads.set(thread.id, thread);
      reply(id, { thread });
      notify("thread/started", { thread });
      break;
    }
    case "thread/resume": {
      const thread = threads.get(p.threadId);
      if (!thread) failure(id, "Missing thread");
      else reply(id, { thread });
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
      if (!input.includes("rápido")) reply(id, { turn: { ...turn, items: [] } });
      if (input.includes("sair")) {
        setTimeout(() => process.exit(7), 20);
        break;
      }
      if (input.includes("lento")) break;
      if (input.includes("erro")) {
        finish(thread, turn, "failed", { message: "Falha de teste recuperável." });
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
        const requestId = ++serverId;
        waiting.set(requestId, (answer) =>
          response(thread, turn, `Desktop: ${answer.result?.success ? "executado" : "recusado"}.`),
        );
        send({
          id: requestId,
          method: "item/tool/call",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            callId: "desktop-call",
            namespace: null,
            tool: "windows_desktop",
            arguments: { action: "list_windows" },
          },
        });
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

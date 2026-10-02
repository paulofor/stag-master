import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import {
  emptySnapshot,
  type AccessMode,
  type Action,
  type ChatItem,
  type Model,
  type Snapshot,
} from "../shared/types";
import { actionSchema, safeLink } from "../shared/validation";
import { RpcClient, type RpcMessage } from "./rpc";
import { SettingsStore, type Settings } from "./settings";
import { desktopArguments, desktopApproval, desktopTool, type ToolResult } from "./desktop-tools";
import { assistantInstructions, threadPolicy, turnPolicy } from "./policy";

interface WireItem {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  status?: string;
  content?: { type: string; text?: string }[];
  command?: string;
  aggregatedOutput?: string;
  changes?: { path: string; diff?: string }[];
  query?: string;
  tool?: string;
}
interface WireTurn {
  id: string;
  status: string;
  items?: WireItem[];
  error?: { message: string };
}
interface WireThread {
  id: string;
  name?: string;
  preview?: string;
  updatedAt?: number;
  cwd?: string;
  turns?: WireTurn[];
}
interface PendingApproval {
  message: RpcMessage;
  execute?: () => Promise<ToolResult>;
}
interface Options {
  createRpc: () => RpcClient;
  store: SettingsStore;
  selectProject: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  desktop: { execute: (args: unknown) => Promise<ToolResult> };
  platform?: string;
}
const modelSchema = z.object({
  id: z.string(),
  model: z.string(),
  displayName: z.string(),
  defaultReasoningEffort: z.string(),
  supportedReasoningEfforts: z.array(
    z.object({ reasoningEffort: z.string(), description: z.string() }),
  ),
  isDefault: z.boolean().default(false),
});
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "Não foi possível concluir a ação.").replace(
    /(?:sk-|ghp_)[\w-]+/g,
    "[credencial removida]",
  );
}

export class AssistantService extends EventEmitter {
  private state: Snapshot;
  private settings: Settings = { threads: {} };
  private rpc: RpcClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private turnId: string | null = null;
  private loginId: string | null = null;
  private startedAt = 0;
  private sending = false;
  private changing = false;
  private windowsConsent = false;
  private windowsConsentThread: string | null = null;
  private disposed = false;
  private sandboxReady = false;
  private completedTurns = new Set<string>();
  constructor(private options: Options) {
    super();
    this.state = structuredClone(emptySnapshot);
    this.state.platform = options.platform || process.platform;
  }
  snapshot(): Snapshot {
    return structuredClone(this.state);
  }
  private publish(): void {
    if (!this.disposed) this.emit("snapshot", this.snapshot());
  }
  async init(): Promise<void> {
    this.settings = await this.options.store.load();
    if (this.settings.project) {
      try {
        const path = await realpath(this.settings.project);
        if ((await stat(path)).isDirectory())
          this.state.project = { path, name: basename(path) || path };
      } catch {
        /* A moved project can be selected again. */
      }
    }
    this.publish();
  }
  async request(raw: Action): Promise<Snapshot> {
    const action = actionSchema.parse(raw) as Action;
    if (this.changing && !["stop", "answer"].includes(action.type))
      throw new Error("Aguarde a ação em andamento.");
    const changesContext = [
      "connect",
      "logout",
      "selectProject",
      "preferences",
      "newChat",
      "resume",
    ].includes(action.type);
    if (changesContext && (this.state.busy || this.sending) && action.type !== "connect")
      throw new Error("Pare a execução antes de mudar a conversa.");
    if (changesContext) this.changing = true;
    this.state.error = null;
    try {
      switch (action.type) {
        case "connect":
          await this.connect();
          break;
        case "login":
          await this.login();
          break;
        case "cancelLogin":
          await this.cancelLogin();
          break;
        case "logout":
          await this.cancelLogin();
          await this.call("account/logout");
          this.state.account = null;
          this.state.models = [];
          this.state.model = "";
          this.clearChat();
          break;
        case "selectProject": {
          const selected = await this.options.selectProject();
          if (selected) await this.setProject(selected);
          break;
        }
        case "preferences":
          await this.preferences(action);
          break;
        case "newChat":
          this.clearChat();
          break;
        case "resume":
          await this.resume(action.threadId);
          break;
        case "send":
          await this.send(action.text);
          break;
        case "stop":
          await this.stop();
          break;
        case "answer":
          await this.answer(action);
          break;
        case "openLink":
          await this.options.openExternal(safeLink(action.url));
          break;
      }
    } catch (error) {
      this.state.error = errorText(error);
      this.state.metrics.failures++;
      this.publish();
      throw new Error(this.state.error);
    } finally {
      if (changesContext) this.changing = false;
      this.publish();
    }
    return this.snapshot();
  }
  private async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.rpc) throw new Error("Conecte o Codex para continuar.");
    this.state.metrics.requests++;
    return this.rpc.call<T>(method, params);
  }
  private async connect(): Promise<void> {
    this.rpc?.removeAllListeners();
    await this.rpc?.shutdown();
    this.pending.clear();
    this.state.approvals = [];
    this.state.busy = false;
    this.turnId = null;
    this.loginId = null;
    this.state.loginPending = false;
    this.state.connection = "connecting";
    this.publish();
    const rpc = this.options.createRpc();
    this.rpc = rpc;
    rpc.on("notification", (message: RpcMessage) => this.notification(message));
    rpc.on("request", (message: RpcMessage) => {
      void this.serverRequest(message).catch((error) => {
        this.state.error = errorText(error);
        this.publish();
        if (message.id !== undefined) {
          try {
            rpc.rejectRequest(message.id, "Falha ao tratar pedido do cliente.");
          } catch {}
        }
      });
    });
    rpc.on("closed", (error: Error) => {
      if (this.disposed || this.rpc !== rpc) return;
      this.state.connection = "error";
      this.state.error = errorText(error);
      this.state.busy = false;
      this.turnId = null;
      this.pending.clear();
      this.state.approvals = [];
      this.state.loginPending = false;
      this.loginId = null;
      this.publish();
    });
    try {
      await rpc.start();
      this.state.connection = "ready";
      this.sandboxReady = this.state.platform !== "win32";
      if (!this.sandboxReady) await this.call("windowsSandbox/setupStart", { mode: "unelevated" });
      await this.refreshAccount();
      if (this.state.account) await this.refreshModels();
      await this.refreshHistory();
      // Rejoin persisted history after disconnect; never automatically replay user input.
      if (this.state.threadId) await this.resume(this.state.threadId);
    } catch (error) {
      this.state.connection = "error";
      rpc.close();
      throw error;
    }
  }
  private async refreshAccount(): Promise<void> {
    const result = await this.call<{
      account: { type: string; email?: string; planType?: string } | null;
    }>("account/read", { refreshToken: false });
    this.state.account =
      result.account?.type === "chatgpt"
        ? { email: result.account.email || null, plan: result.account.planType || null }
        : null;
    this.publish();
  }
  private async refreshModels(): Promise<void> {
    const models: Model[] = [];
    let cursor: string | null = null;
    do {
      const result: { data: unknown[]; nextCursor: string | null } = await this.call("model/list", {
        limit: 100,
        includeHidden: false,
        cursor,
      });
      models.push(...result.data.map((value) => modelSchema.parse(value)));
      cursor = result.nextCursor;
    } while (cursor && models.length < 1000);
    this.state.models = models;
    const selected =
      models.find((m) => m.model === this.state.model) ||
      models.find((m) => m.isDefault) ||
      models[0];
    this.state.model = selected?.model || "";
    this.state.effort = selected?.supportedReasoningEfforts.some(
      (e) => e.reasoningEffort === this.state.effort,
    )
      ? this.state.effort
      : selected?.defaultReasoningEffort || "";
    this.publish();
  }
  private async login(): Promise<void> {
    if (this.state.connection !== "ready") await this.connect();
    if (this.state.loginPending) throw new Error("O login já está aberto no navegador.");
    this.state.loginPending = true;
    this.publish();
    try {
      const result = await this.call<{ authUrl: string; loginId: string }>("account/login/start", {
        type: "chatgpt",
      });
      this.loginId = result.loginId;
      await this.options.openExternal(safeLink(result.authUrl, true));
    } catch (error) {
      await this.cancelLogin().catch(() => {});
      throw error;
    }
  }
  private async cancelLogin(): Promise<void> {
    const id = this.loginId;
    this.loginId = null;
    this.state.loginPending = false;
    if (id) await this.call("account/login/cancel", { loginId: id });
  }
  private async setProject(selected: string): Promise<void> {
    const path = await realpath(selected);
    if (!(await stat(path)).isDirectory()) throw new Error("Selecione uma pasta de projeto.");
    this.clearChat();
    this.state.project = { path, name: basename(path) || path };
    this.settings.project = path;
    await this.options.store.save(this.settings);
    if (this.state.connection === "ready") await this.refreshHistory();
  }
  private clearChat(): void {
    if (this.state.busy || this.sending)
      throw new Error("Pare a execução antes de abrir outra conversa.");
    this.state.threadId = null;
    this.completedTurns.clear();
    this.turnId = null;
    this.state.items = [];
    this.state.plan = [];
    this.state.diff = "";
    this.pending.clear();
    this.state.approvals = [];
    this.windowsConsent = false;
    this.windowsConsentThread = null;
    if (this.state.mode === "windows") this.state.mode = "project";
    this.state.metrics.totalTokens = 0;
    this.state.metrics.elapsedMs = 0;
  }
  private async preferences(action: Extract<Action, { type: "preferences" }>): Promise<void> {
    const model = this.state.models.find((m) => m.model === (action.model || this.state.model));
    if ((action.model || action.effort) && !model)
      throw new Error("Modelo indisponível nesta conta.");
    const effort =
      action.effort ||
      (action.model && action.model !== this.state.model
        ? model?.defaultReasoningEffort
        : this.state.effort);
    if (model && !model.supportedReasoningEfforts.some((e) => e.reasoningEffort === effort))
      throw new Error("Nível de esforço indisponível para o modelo.");
    if (action.mode === "windows") {
      if (this.state.platform !== "win32")
        throw new Error("Controle de desktop disponível somente no Windows.");
      if (!action.windowsConsent)
        throw new Error("Confirme o acesso ao Windows antes de habilitar o modo.");
    }
    if (action.mode && action.mode !== this.state.mode) {
      this.clearChat();
      this.state.mode = action.mode;
      this.windowsConsent = action.mode === "windows" && action.windowsConsent === true;
    }
    if (model) {
      this.state.model = model.model;
      this.state.effort = effort || model.defaultReasoningEffort;
    }
  }
  private async refreshHistory(): Promise<void> {
    if (!this.state.project) {
      this.state.threads = [];
      return;
    }
    const threads: WireThread[] = [];
    let cursor: string | null = null;
    do {
      const result: { data: WireThread[]; nextCursor: string | null } = await this.call(
        "thread/list",
        {
          cwd: this.state.project.path,
          sourceKinds: ["appServer"],
          sortKey: "updated_at",
          limit: 100,
          cursor,
        },
      );
      threads.push(...result.data);
      cursor = result.nextCursor;
    } while (cursor && threads.length < 1000);
    this.state.threads = threads
      .filter((t) => this.settings.threads[t.id]?.path === this.state.project?.path)
      .map((t) => ({
        id: t.id,
        title: t.name || t.preview || "Nova conversa",
        updatedAt: t.updatedAt || 0,
      }));
    this.publish();
  }
  private async resume(id: string): Promise<void> {
    const policy = this.settings.threads[id];
    if (!policy || policy.path !== this.state.project?.path)
      throw new Error("Conversa indisponível para este projeto.");
    if (
      policy.mode === "windows" &&
      (!this.windowsConsent ||
        (this.windowsConsentThread !== null && this.windowsConsentThread !== id))
    )
      throw new Error(
        "Selecione o modo Windows e confirme o acesso antes de retomar essa conversa.",
      );
    const result = await this.call<{ thread: WireThread }>("thread/resume", {
      threadId: id,
      cwd: policy.path,
      ...threadPolicy(policy.mode),
      developerInstructions: assistantInstructions(policy.mode, this.state.platform),
    });
    this.state.threadId = id;
    this.completedTurns = new Set(
      (result.thread.turns || []).filter((t) => t.status !== "inProgress").map((t) => t.id),
    );
    this.state.mode = policy.mode;
    this.windowsConsent = policy.mode === "windows";
    this.windowsConsentThread = this.windowsConsent ? id : null;
    this.state.items = [];
    this.state.plan = [];
    this.state.diff = "";
    this.turnId = null;
    for (const turn of result.thread.turns || [])
      for (const item of turn.items || []) this.upsert(item);
    const last = result.thread.turns?.at(-1);
    this.state.busy = last?.status === "inProgress";
    if (this.state.busy) this.turnId = last!.id;
  }
  private async send(input: string): Promise<void> {
    if (this.sending || this.state.busy) throw new Error("Aguarde ou pare a execução atual.");
    if (this.state.connection !== "ready" || !this.state.account)
      throw new Error("Entre com sua conta ChatGPT para continuar.");
    if (!this.state.project) throw new Error("Selecione uma pasta de projeto.");
    const selectedModel = this.state.models.find((m) => m.model === this.state.model);
    if (!selectedModel)
      throw new Error("Nenhum modelo disponível. Reconecte para atualizar a lista.");
    if (this.state.mode === "windows" && !this.windowsConsent)
      throw new Error("Confirme o acesso ao Windows.");
    if (this.state.platform === "win32" && this.state.mode !== "windows" && !this.sandboxReady)
      throw new Error(
        "O acesso ao projeto está sendo preparado. Aguarde alguns instantes e tente novamente.",
      );
    this.sending = true;
    this.state.busy = true;
    this.startedAt = Date.now();
    this.state.plan = [];
    this.state.diff = "";
    this.state.metrics.elapsedMs = 0;
    this.publish();
    const localId = `local-${Date.now()}`;
    try {
      if (!this.state.threadId) {
        const result = await this.call<{ thread: WireThread }>("thread/start", {
          cwd: this.state.project.path,
          model: this.state.model,
          ...threadPolicy(this.state.mode),
          developerInstructions: assistantInstructions(this.state.mode, this.state.platform),
          serviceName: "stag_desktop",
          ...(this.state.mode === "windows" ? { dynamicTools: [desktopTool] } : {}),
        });
        this.state.threadId = result.thread.id;
        if (this.state.mode === "windows") this.windowsConsentThread = result.thread.id;
        this.settings.threads[result.thread.id] = {
          path: this.state.project.path,
          mode: this.state.mode,
        };
        await this.options.store.save(this.settings);
      }
      this.state.items.push({ id: localId, kind: "user", text: input });
      this.publish();
      const result = await this.call<{ turn: WireTurn }>("turn/start", {
        threadId: this.state.threadId,
        cwd: this.state.project.path,
        input: [{ type: "text", text: input }],
        model: this.state.model,
        effort: this.state.effort,
        ...turnPolicy(this.state.mode, this.state.project.path),
      });
      // A small turn can finish before this response arrives. Do not resurrect it.
      if (this.state.busy) this.turnId = result.turn.id;
    } catch (error) {
      this.state.busy = false;
      this.turnId = null;
      // A timed-out request may have started upstream; reconnect instead of replaying.
      if (/demorou/.test(errorText(error))) this.rpc?.close();
      throw error;
    } finally {
      this.sending = false;
      this.publish();
    }
  }
  private async stop(): Promise<void> {
    if (!this.state.busy) return;
    if (!this.turnId || !this.state.threadId)
      throw new Error("A execução está iniciando. Tente parar em instantes.");
    await this.call("turn/interrupt", { threadId: this.state.threadId, turnId: this.turnId });
  }
  private upsert(item: WireItem): void {
    if (!item.id) return;
    let next: ChatItem | null = null;
    if (item.type === "agentMessage")
      next = { id: item.id, kind: "assistant", text: item.text || "", phase: item.phase };
    if (item.type === "userMessage") {
      const message = (item.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("\n");
      const local = this.state.items.findIndex(
        (i) => i.kind === "user" && i.id.startsWith("local-") && i.text === message,
      );
      if (local !== -1) this.state.items.splice(local, 1);
      next = { id: item.id, kind: "user", text: message };
    }
    if (item.type === "commandExecution")
      next = {
        id: item.id,
        kind: "command",
        text: item.command || "Comando",
        output: item.aggregatedOutput || "",
        status: item.status,
      };
    if (item.type === "fileChange")
      next = {
        id: item.id,
        kind: "file",
        text: (item.changes || []).map((c) => c.path).join("\n"),
        output: (item.changes || []).map((c) => c.diff || "").join("\n"),
        status: item.status,
      };
    if (item.type === "webSearch")
      next = { id: item.id, kind: "web", text: item.query || "Pesquisa na web" };
    if (item.type === "dynamicToolCall")
      next = {
        id: item.id,
        kind: "status",
        text: item.tool || "Ação no Windows",
        status: item.status,
      };
    if (!next) return; // Raw reasoning, auth, and unknown item content never reach the renderer.
    const index = this.state.items.findIndex((i) => i.id === next!.id);
    if (index === -1) this.state.items.push(next);
    else this.state.items[index] = next;
  }
  private notification(message: RpcMessage): void {
    const p = message.params || {};
    if (message.method === "windowsSandbox/setupCompleted") {
      this.sandboxReady = p.success === true;
      if (!this.sandboxReady)
        this.state.error =
          "Não foi possível preparar o acesso ao projeto: " +
          (text(p.error) || "reconecte o Codex.");
      this.publish();
      return;
    }
    if (message.method === "account/login/completed") {
      if (this.loginId && p.loginId !== this.loginId) return;
      this.state.loginPending = false;
      this.loginId = null;
      if (p.success === false) {
        this.state.error = text(p.error) || "Login não concluído.";
        this.publish();
      } else void this.updateAccount();
      return;
    }
    if (message.method === "account/updated") {
      void this.updateAccount();
      return;
    }
    if (p.threadId !== this.state.threadId || !this.state.threadId) return;
    const eventTurnId = text(p.turnId) || text(object(p.turn).id);
    if (eventTurnId && this.completedTurns.has(eventTurnId)) return;
    if (eventTurnId && this.turnId && eventTurnId !== this.turnId) return;
    switch (message.method) {
      case "turn/started":
        this.turnId = text(object(p.turn).id);
        this.state.busy = true;
        break;
      case "item/started":
      case "item/completed":
        this.upsert(object(p.item) as unknown as WireItem);
        break;
      case "item/agentMessage/delta": {
        const id = text(p.itemId);
        let item = this.state.items.find((i) => i.id === id);
        if (!item) {
          item = { id, kind: "assistant", text: "" };
          this.state.items.push(item);
        }
        item.text += text(p.delta);
        break;
      }
      case "item/commandExecution/outputDelta": {
        const item = this.state.items.find((i) => i.id === p.itemId);
        if (item) item.output = (item.output || "") + text(p.delta);
        break;
      }
      case "turn/plan/updated":
        this.state.plan = Array.isArray(p.plan) ? (p.plan as Snapshot["plan"]) : [];
        break;
      case "turn/diff/updated":
        this.state.diff = text(p.diff);
        break;
      case "thread/tokenUsage/updated": {
        this.state.metrics.totalTokens =
          Number(object(object(p.tokenUsage).total).totalTokens) || 0;
        break;
      }
      case "serverRequest/resolved":
        this.pending.delete(String(p.requestId));
        this.state.approvals = this.state.approvals.filter((a) => a.id !== String(p.requestId));
        break;
      case "error":
        this.state.error = text(object(p.error).message) || "Falha na execução.";
        break;
      case "turn/completed": {
        const turn = object(p.turn) as unknown as WireTurn;
        if (this.turnId && turn.id !== this.turnId) return;
        this.completedTurns.add(turn.id);
        for (const item of turn.items || []) this.upsert(item);
        this.state.busy = false;
        this.turnId = null;
        this.state.metrics.elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
        this.pending.clear();
        this.state.approvals = [];
        if (turn.status === "failed") {
          this.state.error = turn.error?.message || "Falha na execução.";
          this.state.metrics.failures++;
        }
        if (turn.status === "interrupted")
          this.state.items.push({
            id: `interrupted-${turn.id}`,
            kind: "status",
            text: "Execução interrompida.",
          });
        void this.refreshHistory().catch(() => {});
        break;
      }
    }
    this.publish();
  }
  private async updateAccount(): Promise<void> {
    try {
      await this.refreshAccount();
      if (this.state.account) await this.refreshModels();
    } catch (error) {
      this.state.error = errorText(error);
      this.publish();
    }
  }
  private async serverRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined || !this.rpc) return;
    const p = message.params || {};
    const id = String(message.id);
    if (
      !this.state.busy ||
      p.threadId !== this.state.threadId ||
      this.completedTurns.has(text(p.turnId)) ||
      (this.turnId && p.turnId && p.turnId !== this.turnId)
    ) {
      this.rpc.rejectRequest(message.id, "Pedido fora da conversa ativa.");
      return;
    }
    if (message.method === "item/tool/call") {
      if (
        p.tool !== "windows_desktop" ||
        (p.namespace !== undefined && p.namespace !== null) ||
        this.state.platform !== "win32" ||
        this.state.mode !== "windows" ||
        !this.windowsConsent ||
        this.windowsConsentThread !== this.state.threadId
      ) {
        this.rpc.respond(message.id, {
          success: false,
          contentItems: [{ type: "inputText", text: "Ferramenta não autorizada nesta conversa." }],
        });
        return;
      }
      const parsed = desktopArguments.safeParse(p.arguments);
      if (!parsed.success) {
        this.rpc.respond(message.id, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "Argumentos de desktop inválidos. Corrija a operação antes de solicitar aprovação.",
            },
          ],
        });
        return;
      }
      const args = parsed.data;
      this.pending.set(id, { message, execute: () => this.options.desktop.execute(args) });
      this.state.approvals.push({
        id,
        kind: "desktop",
        ...desktopApproval(args),
      });
    } else if (
      ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
        message.method || "",
      )
    ) {
      const isCommand = message.method === "item/commandExecution/requestApproval";
      const item = this.state.items.find((i) => i.id === p.itemId);
      this.pending.set(id, { message });
      this.state.approvals.push({
        id,
        kind: isCommand ? "command" : "file",
        title: isCommand ? "Permitir este comando?" : "Permitir alterações nos arquivos?",
        detail: [
          text(p.command) || item?.text,
          text(p.cwd) || text(p.grantRoot),
          text(p.reason),
          item?.output,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    } else if (message.method === "item/tool/requestUserInput") {
      const questions = z
        .array(
          z.object({
            id: z.string(),
            question: z.string(),
            isSecret: z.boolean().optional(),
            options: z
              .array(z.object({ label: z.string(), description: z.string() }))
              .nullable()
              .optional(),
          }),
        )
        .parse(p.questions);
      this.pending.set(id, { message });
      this.state.approvals.push({
        id,
        kind: "questions",
        title: "O assistente precisa de uma resposta",
        detail: "",
        questions: questions.map((q) => ({ ...q, options: q.options || [] })),
      });
    } else if (message.method === "item/permissions/requestApproval") {
      // Narrow default: advanced permission grants are not a UI capability in v0.1.
      this.rpc.respond(message.id, { permissions: {}, scope: "turn" });
      this.state.error =
        "Uma permissão adicional foi recusada. Escolha um modo de acesso adequado em uma nova conversa.";
    } else if (message.method === "mcpServer/elicitation/request") {
      this.rpc.respond(message.id, { action: "decline", content: null });
      this.state.error =
        "Solicitação de integração externa recusada: essa integração ainda não possui formulário no STAG.";
    } else {
      this.rpc.rejectRequest(message.id, "Pedido não suportado pelo STAG.");
    }
    this.publish();
  }
  private async answer(action: Extract<Action, { type: "answer" }>): Promise<void> {
    const waiting = this.pending.get(action.id);
    if (!waiting || waiting.message.id === undefined || !this.rpc)
      throw new Error("Esse pedido já foi resolvido.");
    const approval = this.state.approvals.find((a) => a.id === action.id);
    if (approval?.kind === "questions") {
      const answers: Record<string, { answers: string[] }> = {};
      for (const q of approval.questions || []) {
        const value = action.answers?.[q.id]?.trim();
        if (!value) throw new Error("Responda todas as perguntas antes de continuar.");
        answers[q.id] = { answers: [value] };
      }
      this.rpc.respond(waiting.message.id, { answers });
    } else if (waiting.execute) {
      const ownerRpc = this.rpc;
      const ownerThread = this.state.threadId;
      const ownerTurn = this.turnId;
      const ownsTurn = () =>
        !this.disposed &&
        this.state.busy &&
        this.rpc === ownerRpc &&
        this.state.threadId === ownerThread &&
        this.turnId === ownerTurn;
      // Remove first to prevent double-click executing a desktop action twice.
      this.pending.delete(action.id);
      this.state.approvals = this.state.approvals.filter((a) => a.id !== action.id);
      this.publish();
      let result: ToolResult = {
        success: false,
        contentItems: [{ type: "inputText", text: "Ação recusada pelo usuário." }],
      };
      if (action.accept === true) {
        try {
          result = await waiting.execute();
        } catch (error) {
          if (ownsTurn()) {
            this.state.error = errorText(error);
            this.state.metrics.failures++;
          }
          result = {
            success: false,
            contentItems: [{ type: "inputText", text: errorText(error) }],
          };
        }
      }
      if (ownsTurn()) ownerRpc.respond(waiting.message.id, result);
    } else {
      const available = waiting.message.params?.availableDecisions;
      const decision = action.accept === true ? "accept" : "decline";
      if (Array.isArray(available) && !available.includes(decision))
        throw new Error("Essa decisão não está disponível para o pedido.");
      this.rpc.respond(waiting.message.id, { decision });
    }
    this.pending.delete(action.id);
    this.state.approvals = this.state.approvals.filter((a) => a.id !== action.id);
  }
  dispose(): void {
    this.disposed = true;
    this.rpc?.removeAllListeners();
    this.rpc?.close();
    this.pending.clear();
  }
}

import { EventEmitter } from "node:events";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import {
  emptySnapshot,
  maxQueuedMessages,
  type AccessMode,
  type Action,
  type ChatItem,
  type Model,
  type Snapshot,
  type BrowserControl,
  type BrowserInfo,
  type RequestImage,
} from "../shared/types";
import { actionSchema, safeLink } from "../shared/validation";
import { requestImagesSchema } from "../shared/request-images";
import { RpcClient, type RpcMessage } from "./rpc";
import { SettingsStore, type Settings } from "./settings";
import {
  desktopArguments,
  desktopApproval,
  desktopConfirmationReason,
  desktopTool,
  type ToolResult,
} from "./desktop-tools";
import { assistantInstructions, threadPolicy, turnPolicy } from "./policy";
import { cyberSafetyReason, cyberSafetyRefusal } from "./cyber-safety";
import { prepareProjectGit, projectGitInstructions } from "./project-git";
import { projectSourcesContext } from "./project-sources";
import {
  browserArguments,
  browserApproval,
  browserTool,
  type BrowserArguments,
} from "./browser-tools";

interface WireItem {
  id: string;
  type: string;
  text?: string;
  phase?: string;
  status?: string;
  content?: { type: string; text?: string; url?: string }[];
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
  tool?: "desktop" | "browser";
  confirmation?: () => Promise<string | null>;
  approval?: (reason: string) => { title: string; detail: string };
  safety?: () => string | null;
}
interface Options {
  createRpc: () => RpcClient;
  store: SettingsStore;
  selectProject: () => Promise<string | null>;
  prepareProjectGit?: typeof prepareProjectGit;
  openExternal: (url: string) => Promise<void>;
  desktop: { execute: (args: unknown) => Promise<ToolResult> };
  browser?: {
    execute: (args: BrowserArguments) => Promise<ToolResult>;
    confirmationReason: (args: BrowserArguments) => Promise<string | null>;
    control: (args: BrowserControl) => Promise<void>;
    reset: () => void;
    cancel: () => void;
    setVisible: (visible: boolean) => void;
  };
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
  inputModalities: z.array(z.string()).optional(),
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
  return (error instanceof Error ? error.message : "Não foi possível concluir a ação.")
    .replace(/(?:sk-|ghp_)[\w-]+/g, "[credencial removida]")
    .replace(/data:image\/[^\s"'<>]+/gi, "[imagem removida]");
}

export class AssistantService extends EventEmitter {
  private state: Snapshot;
  private settings: Settings = { threads: {}, projectSources: {} };
  private rpc: RpcClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private toolRequests = new Set<string>();
  private toolQueue: Promise<void> = Promise.resolve();
  private toolEpoch = 0;
  private stopping = false;
  private turnId: string | null = null;
  private loginId: string | null = null;
  private startedAt = 0;
  private sending = false;
  private drainingMessages = false;
  private messageQueueEpoch = 0;
  private queuedIds = new Set<string>();
  private changing = false;
  private windowsConsent = false;
  private windowsConsentThread: string | null = null;
  private browserConsentThread: string | null = null;
  private contextInstructionsDirty = false;
  private disposed = false;
  private sandboxReady = false;
  private completedTurns = new Set<string>();
  private safetyBlockId = 0;
  private projectPreparation = new AbortController();
  constructor(private options: Options) {
    super();
    this.state = structuredClone(emptySnapshot);
    this.state.platform = options.platform || process.platform;
    this.state.browser.available = !!options.browser;
  }
  snapshot(): Snapshot {
    return structuredClone(this.state);
  }
  updateBrowser(info: BrowserInfo): void {
    Object.assign(this.state.browser, info);
    this.publish();
  }
  private publish(): void {
    if (!this.disposed) this.emit("snapshot", this.snapshot());
  }
  private recordSafetyBlock(kind: "assistant" | "status" = "status"): void {
    this.state.queuePaused = true;
    this.state.metrics.failures++;
    this.state.items.push({
      id: `safety-block-${++this.safetyBlockId}`,
      kind,
      text: cyberSafetyRefusal,
    });
    this.publish();
  }
  private approvalSafetyReason(message: RpcMessage): string | null {
    const p = message.params || {};
    const item = this.state.items.find((i) => i.id === p.itemId);
    // Intent and command are inspected independently; do not treat an entire patch or a
    // command's output as instructions (defensive tests/docs may quote hostile requests).
    return cyberSafetyReason([
      text(p.command),
      text(p.reason),
      message.method === "item/commandExecution/requestApproval" ? item?.text || "" : "",
    ]);
  }
  private declineUnsafeApproval(message: RpcMessage): void {
    this.recordSafetyBlock();
    const available = message.params?.availableDecisions;
    if (Array.isArray(available) && !available.includes("decline"))
      this.rpc!.rejectRequest(message.id!, cyberSafetyRefusal);
    else this.rpc!.respond(message.id!, { decision: "decline" });
  }
  async init(): Promise<void> {
    this.settings = await this.options.store.load();
    if (this.settings.project) {
      try {
        const path = await realpath(this.settings.project);
        if ((await stat(path)).isDirectory()) {
          this.state.project = { path, name: basename(path) || path };
          this.state.projectSources = this.settings.projectSources[path] || [];
        }
      } catch {
        /* A moved project can be selected again. */
      }
    }
    this.publish();
  }
  async request(raw: Action): Promise<Snapshot> {
    const action = actionSchema.parse(raw) as Action;
    const revokingBrowser =
      (action.type === "browserConsent" && !action.allow) ||
      (action.type === "browserVisibility" && !action.visible);
    if (this.changing && !["stop", "answer"].includes(action.type) && !revokingBrowser)
      throw new Error("Aguarde a ação em andamento.");
    const changesContext =
      [
        "connect",
        "logout",
        "selectProject",
        "projectSources",
        "preferences",
        "newChat",
        "resume",
      ].includes(action.type) ||
      (action.type === "browserConsent" && action.allow) ||
      action.type === "browserControl";
    if (
      changesContext &&
      (this.state.busy || this.sending || this.drainingMessages) &&
      action.type !== "connect"
    )
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
        case "projectSources": {
          const path = this.state.project?.path;
          if (!path || path !== action.projectPath)
            throw new Error("O projeto mudou. Reabra Fontes do projeto na pasta desejada.");
          const settings = {
            ...this.settings,
            projectSources: { ...this.settings.projectSources, [path]: action.sources },
          };
          // Publish only after durable storage succeeds; keep the prior list on failure.
          await this.options.store.save(settings);
          this.settings = settings;
          this.state.projectSources = action.sources;
          this.contextInstructionsDirty = true;
          break;
        }
        case "newChat":
          this.clearChat();
          break;
        case "resume":
          await this.resume(action.threadId);
          break;
        case "send":
          if (this.state.queuedMessages.length || this.drainingMessages)
            throw new Error("Continue ou esvazie a fila antes de enviar outra mensagem.");
          this.state.queuePaused = false;
          await this.send(action.text, action.images || []);
          break;
        case "enqueue":
          this.requireQueueThread(action.threadId);
          if (this.state.connection !== "ready" || !this.state.account)
            throw new Error("Reconecte sua conta antes de adicionar à fila.");
          if (this.queuedIds.has(action.id)) break;
          if (this.state.queuedMessages.length >= maxQueuedMessages)
            throw new Error("A fila aceita até 20 textos. Aguarde ou remova uma pendência.");
          if (cyberSafetyReason([action.text], "request")) throw new Error(cyberSafetyRefusal);
          this.queuedIds.add(action.id);
          this.state.queuedMessages.push({ id: action.id, text: action.text, status: "pending" });
          break;
        case "removeQueued":
          this.requireQueueThread(action.threadId);
          if (this.state.queuedMessages.find((item) => item.id === action.id)?.status === "sending")
            throw new Error("Este texto já está sendo enviado. Use Parar execução.");
          this.state.queuedMessages = this.state.queuedMessages.filter(
            (item) => item.id !== action.id,
          );
          break;
        case "pauseQueue":
          this.requireQueueThread(action.threadId);
          if (!action.paused) {
            if (this.state.connection !== "ready" || !this.state.account)
              throw new Error("Reconecte sua conta antes de continuar a fila.");
            if (this.state.queuedMessages.some((item) => item.status === "uncertain"))
              throw new Error(
                "Envio não confirmado. Confira o histórico e remova esse item antes de continuar a fila.",
              );
          }
          this.state.queuePaused = action.paused;
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
        case "browserConsent":
          await this.browserConsent(action.allow);
          break;
        case "browserVisibility":
          this.state.browser.visible = action.visible;
          this.options.browser?.setVisible(action.visible);
          if (!action.visible) await this.browserConsent(false);
          break;
        case "browserControl": {
          if (!this.options.browser)
            throw new Error("Navegador disponível somente no STAG desktop.");
          if (this.state.busy || this.sending)
            throw new Error("Pare o modelo antes de navegar manualmente.");
          const execution = this.toolQueue.then(() =>
            this.options.browser!.control(action.control),
          );
          this.toolQueue = execution.catch(() => {});
          await execution;
          break;
        }
        case "browserBounds":
          throw new Error("Limites do navegador são tratados pelo main.");
      }
    } catch (error) {
      this.state.error = errorText(error);
      this.state.metrics.failures++;
      this.publish();
      throw new Error(this.state.error);
    } finally {
      if (changesContext) this.changing = false;
      this.publish();
      void this.drainMessageQueue();
    }
    return this.snapshot();
  }
  private requireQueueThread(threadId: string): void {
    if (!this.state.project || !this.state.threadId || this.state.threadId !== threadId)
      throw new Error("A conversa mudou. Confira a conversa antes de alterar a fila.");
  }
  private clearMessageQueue(): void {
    this.messageQueueEpoch++;
    this.state.queuedMessages = [];
    this.state.queuePaused = false;
    this.queuedIds.clear();
  }
  private async drainMessageQueue(): Promise<void> {
    const canDrain = () =>
      !this.disposed &&
      !this.sending &&
      !this.changing &&
      !this.state.busy &&
      !this.state.queuePaused &&
      !this.state.approvals.length &&
      this.state.connection === "ready" &&
      !!this.state.account;
    const message = this.state.queuedMessages[0];
    if (this.drainingMessages || !message || message.status !== "pending" || !canDrain()) return;
    this.drainingMessages = true;
    const epoch = this.messageQueueEpoch;
    const rpc = this.rpc;
    try {
      // A completed turn can still have a desktop/browser operation finishing locally.
      await this.toolQueue;
      if (
        epoch !== this.messageQueueEpoch ||
        rpc !== this.rpc ||
        this.state.queuedMessages[0] !== message ||
        !canDrain()
      )
        return;
      message.status = "sending";
      await this.send(message.text, []);
      if (epoch === this.messageQueueEpoch)
        this.state.queuedMessages = this.state.queuedMessages.filter((item) => item !== message);
    } catch (error) {
      if (epoch === this.messageQueueEpoch && !this.disposed) {
        // A lost response does not prove that the server rejected the turn. Never replay it.
        message.status =
          this.state.connection !== "ready" || rpc !== this.rpc || /demorou/.test(errorText(error))
            ? "uncertain"
            : "pending";
        this.state.queuePaused = true;
        this.state.error =
          message.status === "uncertain"
            ? "Envio não confirmado. Confira o histórico e remova esse item antes de continuar a fila."
            : errorText(error);
        this.state.metrics.failures++;
      }
    } finally {
      this.drainingMessages = false;
      this.publish();
      // Includes turns completed before turn/start replied and removal while tools settled.
      void this.drainMessageQueue();
    }
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
    if (this.state.queuedMessages.length || this.state.busy || this.sending)
      this.state.queuePaused = true;
    this.toolEpoch++;
    this.options.browser?.cancel();
    this.stopping = false;
    this.toolRequests.clear();
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
      this.toolEpoch++;
      this.options.browser?.cancel();
      this.state.connection = "error";
      this.state.queuePaused = true;
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
    const previousAccount = this.state.account;
    this.state.account =
      result.account?.type === "chatgpt"
        ? { email: result.account.email || null, plan: result.account.planType || null }
        : null;
    if (previousAccount && previousAccount.email !== this.state.account?.email)
      this.clearMessageQueue();
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
    this.state.mode = "project";
    this.state.project = { path, name: basename(path) || path };
    this.state.projectSources = this.settings.projectSources[path] || [];
    this.settings.project = path;
    await this.options.store.save(this.settings);
    this.state.project.git = await (this.options.prepareProjectGit || prepareProjectGit)(path, {
      signal: this.projectPreparation.signal,
      onProgress: (git) => {
        if (!this.disposed && this.state.project?.path === path) {
          this.state.project.git = git;
          this.publish();
        }
      },
    });
    this.state.metrics.failures += this.state.project.git.failures;
    if (this.state.connection === "ready") await this.refreshHistory();
  }
  private clearChat(): void {
    if (this.state.busy || this.sending)
      throw new Error("Pare a execução antes de abrir outra conversa.");
    this.toolEpoch++;
    this.clearMessageQueue();
    this.toolRequests.clear();
    this.stopping = false;
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
    this.state.browser.authorized = false;
    this.browserConsentThread = null;
    this.contextInstructionsDirty = false;
    this.options.browser?.reset();
    if (this.state.mode === "windows") this.state.mode = "project";
    this.state.metrics.totalTokens = 0;
    this.state.metrics.elapsedMs = 0;
  }
  private async browserConsent(allow: boolean): Promise<void> {
    if (!this.options.browser) throw new Error("Navegador disponível somente no STAG desktop.");
    if (!allow) this.state.queuePaused = true;
    if (allow && (this.state.busy || this.sending))
      throw new Error("Pare a execução antes de autorizar o navegador.");
    if (allow && this.state.threadId && !this.settings.threads[this.state.threadId]?.browserTool)
      throw new Error(
        "Abra uma nova conversa para usar o navegador neste histórico anterior à versão 0.4.",
      );
    this.toolEpoch++;
    this.state.browser.authorized = allow;
    this.contextInstructionsDirty = true;
    this.browserConsentThread = allow ? this.state.threadId : null;
    if (!allow) this.options.browser.reset();
    if (!allow && this.state.busy) await this.stop();
    if (this.state.threadId && !this.state.busy) {
      try {
        await this.resume(this.state.threadId);
      } catch (error) {
        this.state.browser.authorized = false;
        this.browserConsentThread = null;
        throw error;
      }
    }
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
    if (this.state.threadId !== id) {
      this.toolEpoch++;
      this.toolRequests.clear();
      this.state.browser.authorized = false;
      this.browserConsentThread = null;
      this.options.browser?.reset();
    }
    const result = await this.call<{ thread: WireThread }>("thread/resume", {
      threadId: id,
      cwd: policy.path,
      ...threadPolicy(policy.mode, policy.path),
      developerInstructions:
        assistantInstructions(
          policy.mode,
          this.state.platform,
          this.state.browser.authorized,
          !!policy.browserTool,
          policy.path,
          this.state.projectSources,
        ) +
        "\n" +
        projectGitInstructions(this.state.project?.git),
    });
    if (this.state.threadId !== id) this.clearMessageQueue();
    this.state.threadId = id;
    this.contextInstructionsDirty = false;
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
  private async send(input: string, images: RequestImage[]): Promise<void> {
    if (this.sending || this.state.busy) throw new Error("Aguarde ou pare a execução atual.");
    if (this.state.connection !== "ready" || !this.state.account)
      throw new Error("Entre com sua conta ChatGPT para continuar.");
    if (!this.state.project) throw new Error("Selecione uma pasta de projeto.");
    const selectedModel = this.state.models.find((m) => m.model === this.state.model);
    if (!selectedModel)
      throw new Error("Nenhum modelo disponível. Reconecte para atualizar a lista.");
    if (
      images.length &&
      selectedModel.inputModalities &&
      !selectedModel.inputModalities.includes("image")
    )
      throw new Error("Este modelo não aceita imagens. Selecione outro modelo da sua conta.");
    if (this.state.mode === "windows" && !this.windowsConsent)
      throw new Error("Confirme o acesso ao Windows.");
    if (this.state.platform === "win32" && this.state.mode !== "windows" && !this.sandboxReady)
      throw new Error(
        "O acesso ao projeto está sendo preparado. Aguarde alguns instantes e tente novamente.",
      );
    if (cyberSafetyReason([input], "request")) {
      this.state.items.push({
        id: `blocked-user-${this.safetyBlockId + 1}`,
        kind: "user",
        text: input,
        ...(images.length ? { images } : {}),
      });
      this.recordSafetyBlock("assistant");
      return;
    }
    const localId = `local-${Date.now()}`;
    this.sending = true;
    try {
      if (this.state.threadId && this.contextInstructionsDirty)
        await this.resume(this.state.threadId);
      this.toolRequests.clear();
      this.stopping = false;
      this.state.busy = true;
      this.startedAt = Date.now();
      this.state.plan = [];
      this.state.diff = "";
      this.state.metrics.elapsedMs = 0;
      this.publish();
      if (!this.state.threadId) {
        const result = await this.call<{ thread: WireThread }>("thread/start", {
          cwd: this.state.project.path,
          model: this.state.model,
          ...threadPolicy(this.state.mode, this.state.project.path),
          developerInstructions:
            assistantInstructions(
              this.state.mode,
              this.state.platform,
              this.state.browser.authorized,
              !!this.options.browser,
              this.state.project.path,
              this.state.projectSources,
            ) +
            "\n" +
            projectGitInstructions(this.state.project.git),
          serviceName: "stag_desktop",
          dynamicTools: [
            ...(this.state.mode === "windows" ? [desktopTool] : []),
            ...(this.options.browser ? [browserTool] : []),
          ],
        });
        this.state.threadId = result.thread.id;
        this.contextInstructionsDirty = false;
        if (this.state.mode === "windows") this.windowsConsentThread = result.thread.id;
        if (this.state.browser.authorized) this.browserConsentThread = result.thread.id;
        this.settings.threads[result.thread.id] = {
          path: this.state.project.path,
          mode: this.state.mode,
          browserTool: !!this.options.browser,
        };
        await this.options.store.save(this.settings);
      }
      this.state.items.push({
        id: localId,
        kind: "user",
        text: input,
        ...(images.length ? { images } : {}),
      });
      this.publish();
      const result = await this.call<{ turn: WireTurn }>("turn/start", {
        threadId: this.state.threadId,
        cwd: this.state.project.path,
        input: [
          ...(input ? [{ type: "text", text: input }] : []),
          ...images.map((image) => ({ type: "image", url: image.dataUrl })),
        ],
        model: this.state.model,
        effort: this.state.effort,
        additionalContext: projectSourcesContext(
          this.state.project.path,
          this.state.projectSources,
          this.state.browser.authorized,
          !!this.settings.threads[this.state.threadId!]?.browserTool,
        ),
        ...turnPolicy(this.state.mode, this.state.project.path),
      });
      // A small turn can finish before this response arrives. Do not resurrect it.
      if (this.state.busy) this.turnId = result.turn.id;
    } catch (error) {
      this.state.busy = false;
      this.turnId = null;
      this.state.items = this.state.items.filter((item) => item.id !== localId);
      // A timed-out request may have started upstream; reconnect instead of replaying.
      if (/demorou/.test(errorText(error))) this.rpc?.close();
      throw error;
    } finally {
      this.sending = false;
      this.publish();
      void this.drainMessageQueue();
    }
  }
  private async stop(): Promise<void> {
    this.state.queuePaused = true;
    if (!this.state.busy) return;
    if (!this.turnId || !this.state.threadId)
      throw new Error("A execução está iniciando. Tente parar em instantes.");
    this.toolEpoch++;
    this.options.browser?.cancel();
    this.stopping = true;
    this.pending.clear();
    this.state.approvals = [];
    this.publish();
    try {
      await this.call("turn/interrupt", { threadId: this.state.threadId, turnId: this.turnId });
    } catch (error) {
      // An uncertain interrupt must not leave an agent waiting on discarded requests.
      this.rpc?.close();
      throw error;
    }
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
      const parsedImages = requestImagesSchema.safeParse(
        (item.content || [])
          .filter((content) => content.type === "image")
          .map((content) => ({ dataUrl: content.url })),
      );
      const images = parsedImages.success ? parsedImages.data : [];
      const local = this.state.items.findIndex(
        (i) =>
          i.kind === "user" &&
          i.id.startsWith("local-") &&
          i.text === message &&
          JSON.stringify(i.images || []) === JSON.stringify(images),
      );
      if (local !== -1) this.state.items.splice(local, 1);
      next = {
        id: item.id,
        kind: "user",
        text:
          message ||
          (!images.length && item.content?.some((content) => content.type === "image")
            ? "Imagem indisponível no histórico."
            : ""),
        ...(images.length ? { images } : {}),
      };
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
        this.state.queuePaused = true;
        break;
      case "turn/completed": {
        const turn = object(p.turn) as unknown as WireTurn;
        if (!this.state.busy || !turn.id) return;
        if (this.turnId && turn.id !== this.turnId) return;
        this.toolEpoch++;
        this.completedTurns.add(turn.id);
        for (const item of turn.items || []) this.upsert(item);
        this.state.busy = false;
        this.turnId = null;
        this.state.metrics.elapsedMs = this.startedAt ? Date.now() - this.startedAt : 0;
        this.pending.clear();
        this.state.approvals = [];
        if (turn.status !== "completed" || this.stopping) this.state.queuePaused = true;
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
    void this.drainMessageQueue();
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
      this.stopping ||
      p.threadId !== this.state.threadId ||
      this.completedTurns.has(text(p.turnId)) ||
      (this.turnId && p.turnId && p.turnId !== this.turnId)
    ) {
      this.rpc.rejectRequest(message.id, "Pedido fora da conversa ativa.");
      return;
    }
    if (message.method === "item/tool/call") {
      const isBrowser = p.tool === "stag_browser";
      const browserAccessDenied =
        !this.options.browser ||
        !this.state.browser.authorized ||
        this.browserConsentThread !== this.state.threadId;
      if (
        (!isBrowser && p.tool !== "windows_desktop") ||
        (p.namespace !== undefined && p.namespace !== null) ||
        (isBrowser
          ? browserAccessDenied
          : this.state.platform !== "win32" ||
            this.state.mode !== "windows" ||
            !this.windowsConsent ||
            this.windowsConsentThread !== this.state.threadId) ||
        !text(p.turnId)
      ) {
        this.rpc.respond(message.id, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text:
                isBrowser && browserAccessDenied
                  ? "stag_browser não autorizado nesta conversa. Peça ao cliente para clicar em Autorizar navegador no painel do STAG e aguarde. Se o painel estiver fechado, indique Mostrar navegador (ícone de globo); históricos sem stag_browser precisam de uma nova conversa. Não abra nem controle Chrome/Edge ou outro navegador por windows_desktop, shell ou automação externa como alternativa."
                  : "Ferramenta não autorizada nesta conversa. O desktop requer Autorizar desktop e permite somente Postman, IntelliJ IDEA, Visual Studio Code e DBeaver; não contorne o bloqueio por comandos ou outra automação.",
            },
          ],
        });
        return;
      }
      const parsed = isBrowser
        ? browserArguments.safeParse(p.arguments)
        : desktopArguments.safeParse(p.arguments);
      if (!parsed.success) {
        this.rpc.respond(message.id, {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: isBrowser
                ? "Argumentos de navegador inválidos. Corrija a operação e seu contexto."
                : "Argumentos de desktop inválidos. Liste as janelas e informe processId em toda outra ação, inclusive screenshot, click e scroll. Somente Postman, IntelliJ IDEA, Visual Studio Code e DBeaver são permitidos; não há captura da tela inteira.",
            },
          ],
        });
        return;
      }
      if (this.toolRequests.has(id)) return;
      this.toolRequests.add(id);
      // A reverse request can precede turn/started or the turn/start response.
      // Its validated thread/turn establishes ownership just like turn/started.
      if (!this.turnId) this.turnId = text(p.turnId);
      const args = parsed.data;
      const safety = () =>
        cyberSafetyReason(Object.values(args).filter((value) => typeof value === "string"));
      const waiting: PendingApproval = isBrowser
        ? {
            message,
            safety,
            tool: "browser",
            execute: () => this.options.browser!.execute(args as BrowserArguments),
            confirmation: () => this.options.browser!.confirmationReason(args as BrowserArguments),
            approval: (reason) => browserApproval(args as BrowserArguments, reason),
          }
        : {
            message,
            safety,
            tool: "desktop",
            execute: () => this.options.desktop.execute(args),
            confirmation: async () =>
              desktopConfirmationReason(args as Parameters<typeof desktopConfirmationReason>[0]),
            approval: () => desktopApproval(args as Parameters<typeof desktopApproval>[0]),
          };
      await this.executeTool(waiting, null);
    } else if (
      ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(
        message.method || "",
      )
    ) {
      if (this.approvalSafetyReason(message)) {
        this.declineUnsafeApproval(message);
        return;
      }
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
  private async executeTool(waiting: PendingApproval, accept: boolean | null): Promise<void> {
    const ownerRpc = this.rpc!;
    const ownerThread = this.state.threadId;
    const ownerTurn = text(waiting.message.params?.turnId);
    const epoch = this.toolEpoch;
    const ownsTurn = () =>
      !this.disposed &&
      !this.stopping &&
      this.state.busy &&
      this.rpc === ownerRpc &&
      this.state.threadId === ownerThread &&
      this.turnId === ownerTurn &&
      this.toolEpoch === epoch &&
      (waiting.tool === "browser"
        ? this.state.browser.authorized && this.browserConsentThread === ownerThread
        : this.state.mode === "windows" &&
          this.windowsConsent &&
          this.windowsConsentThread === ownerThread);
    const execution = this.toolQueue.then(async () => {
      if (!ownsTurn()) return;
      let result: ToolResult = {
        success: false,
        contentItems: [{ type: "inputText", text: "Ação recusada pelo usuário." }],
      };
      const blockUnsafe = () => {
        if (!waiting.safety?.()) return false;
        this.recordSafetyBlock();
        result = {
          success: false,
          contentItems: [{ type: "inputText", text: cyberSafetyRefusal }],
        };
        return true;
      };
      if (accept !== false) {
        try {
          if (!blockUnsafe()) {
            const reason = accept === null ? await waiting.confirmation!() : null;
            if (!ownsTurn()) return;
            // Recheck after DOM/confirmation inspection and again on the approved path.
            if (!blockUnsafe()) {
              if (reason) {
                const id = String(waiting.message.id);
                this.pending.set(id, waiting);
                this.state.approvals.push({
                  id,
                  kind: waiting.tool!,
                  ...waiting.approval!(reason),
                });
                this.publish();
                return;
              }
              result = await waiting.execute!();
            }
          }
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
      if (ownsTurn()) ownerRpc.respond(waiting.message.id!, result);
      this.publish();
    });
    // Desktop and browser actions share one queue, including approved operations.
    this.toolQueue = execution.catch(() => {});
    await execution;
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
      if (
        cyberSafetyReason(
          Object.values(answers).flatMap((value) => value.answers),
          "request",
        )
      ) {
        this.recordSafetyBlock();
        // Resolve the reverse request with the refusal, never forward the hostile answer.
        for (const q of approval.questions || []) answers[q.id] = { answers: [cyberSafetyRefusal] };
      }
      this.rpc.respond(waiting.message.id, { answers });
    } else if (waiting.execute) {
      // Remove first to prevent double-click executing a desktop action twice.
      this.pending.delete(action.id);
      this.state.approvals = this.state.approvals.filter((a) => a.id !== action.id);
      this.publish();
      await this.executeTool(waiting, action.accept === true);
    } else {
      if (action.accept === true && this.approvalSafetyReason(waiting.message)) {
        this.declineUnsafeApproval(waiting.message);
        this.pending.delete(action.id);
        this.state.approvals = this.state.approvals.filter((a) => a.id !== action.id);
        return;
      }
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
    this.clearMessageQueue();
    this.projectPreparation.abort();
    this.toolEpoch++;
    this.options.browser?.cancel();
    this.rpc?.removeAllListeners();
    this.rpc?.close();
    this.pending.clear();
  }
}

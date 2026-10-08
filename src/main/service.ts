import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
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
  desktopTool,
  cursorPulseStatus,
  type DesktopTools,
  type ToolResult,
  type CursorPulseResult,
} from "./desktop-tools";
import { assistantInstructions, threadPolicy, turnPolicy } from "./policy";
import { cyberSafetyReason, cyberSafetyRefusal } from "./cyber-safety";
import { prepareProjectGit, projectGitInstructions, GitFailure } from "./project-git";
import { projectSourcesContext } from "./project-sources";
import type { DatabaseConnections } from "./database-connections";
import { databaseTestError } from "./database-errors";
import type { SqlServerTester } from "./sqlserver";
import { ApiFailure, apiError } from "./api-connections";
import { apiContext, httpArguments, httpTool, type HttpTools } from "./http-tools";
import { databaseContext, sqlArguments, sqlTool, type SqlTools } from "./sql-tools";
import {
  ProjectBranchManager,
  projectBranchesContext,
  projectBranchesInstructions,
} from "./project-branches";
import {
  videoContext,
  videoMessage,
  videoImages,
  type PreparedVideo,
  type VideoProcessor,
  type BackgroundVideoProcessor,
} from "./request-video";
import {
  VideoAnalysisManager,
  VideoAnalysisStore,
  type VideoAnalysisJob,
  type AnalysisTurn,
} from "./video-analysis";
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
  execute?: (approved?: boolean) => Promise<ToolResult>;
  tool?: "desktop" | "browser" | "http" | "sql";
  confirmation?: () => Promise<string | null>;
  approval?: (reason: string) => { title: string; detail: string };
  safety?: () => string | null;
}
interface Options {
  optimizeImage?: (dataUrl: string) => string;
  createRpc: () => RpcClient;
  store: SettingsStore;
  selectProject: () => Promise<string | null>;
  prepareProjectGit?: typeof prepareProjectGit;
  branches?: ProjectBranchManager;
  confirmBranchDeletion?: (project: string, branch: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
  desktop: Pick<DesktopTools, "execute" | "confirmationReason"> &
    Partial<Pick<DesktopTools, "cancel">>;
  pulseCursor?: (signal: AbortSignal) => Promise<CursorPulseResult>;
  browser?: {
    execute: (args: BrowserArguments) => Promise<ToolResult>;
    confirmationReason: (args: BrowserArguments) => Promise<string | null>;
    control: (args: BrowserControl) => Promise<void>;
    reset: () => void;
    setProfile: (id: string | null) => void;
    clearProfile: () => Promise<void>;
    cancel: () => void;
    setVisible: (visible: boolean) => void;
  };
  platform?: string;
  databases?: { connections: DatabaseConnections; test: SqlServerTester; tools?: SqlTools };
  apis?: HttpTools;
  video?: VideoProcessor;
  videoAnalysis?: { store: VideoAnalysisStore; processor: BackgroundVideoProcessor };
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
  private settings: Settings = { threads: {}, projectSources: {}, browserProfiles: {} };
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
  private contextWork: Promise<void> = Promise.resolve();
  private finishContext: (() => void) | null = null;
  private windowsConsent = false;
  private windowsConsentThread: string | null = null;
  private mouseTimer: NodeJS.Timeout | null = null;
  private mouseEpoch = 0;
  private mouseAbort: AbortController | null = null;
  private browserConsentThread: string | null = null;
  private contextInstructionsDirty = false;
  private disposed = false;
  private sandboxReady = false;
  private completedTurns = new Set<string>();
  private safetyBlockId = 0;
  private projectPreparation = new AbortController();
  private branches: ProjectBranchManager;
  private branchController: AbortController | null = null;
  private databasesReady = false;
  private apisReady = false;
  private apiConsentThread: string | null = null;
  private databaseConsentThread: string | null = null;
  private apiLoginGeneration = 0;
  private apiLoginWork: Promise<void> = Promise.resolve();
  private httpWork: Promise<void> = Promise.resolve();
  private sqlWork: Promise<void> = Promise.resolve();
  private databaseAbort: AbortController | null = null;
  private databaseWork: Promise<void> = Promise.resolve();
  private databaseTestIds = new Set<string>();
  private videoPreparation: AbortController | null = null;
  private videoWork: Promise<void> = Promise.resolve();
  private preparedVideo: PreparedVideo | null = null;
  private analysis: VideoAnalysisManager | null = null;
  private analysisWaiter: {
    threadId: string;
    turnId: string | null;
    resolve: (turn: AnalysisTurn) => void;
    reject: (error: Error) => void;
  } | null = null;
  private analysisInterruptRequested = false;
  constructor(private options: Options) {
    super();
    this.branches = options.branches || new ProjectBranchManager();
    this.state = structuredClone(emptySnapshot);
    this.state.platform = options.platform || process.platform;
    this.state.browser.available = !!options.browser;
    if (options.videoAnalysis)
      this.analysis = new VideoAnalysisManager(
        options.videoAnalysis.store,
        options.videoAnalysis.processor,
        {
          context: () => ({
            projectPath: this.state.project?.path || null,
            threadId: this.state.threadId,
            mode: this.state.mode,
            accountKey: this.analysisAccountKey(),
          }),
          changed: () => {
            this.publish();
            void this.drainMessageQueue();
          },
          ready: async () => {
            await this.contextWork;
            await this.toolQueue;
            if (
              this.state.busy ||
              this.sending ||
              this.state.approvals.length ||
              this.state.connection !== "ready" ||
              !this.state.account
            )
              throw new Error("A conversa não está pronta para o próximo trecho.");
          },
          submit: (job, video) => this.waitAnalysisTurn(job, null, video),
          waitTurn: (job, turn) => this.waitAnalysisTurn(job, turn),
          recover: (job) => this.recoverAnalysisTurn(job),
          interrupt: async (job) => {
            if (this.state.threadId !== job.threadId) return;
            if (this.analysisWaiter) {
              this.analysisInterruptRequested = true;
              if (this.turnId && this.state.busy) await this.stop();
            } else if (job.pending && this.turnId && this.state.busy) {
              const previous = await this.recoverAnalysisTurn(job);
              if (previous?.status === "inProgress" && previous.id === this.turnId)
                await this.stop();
            }
          },
          failure: (message) => {
            this.state.error = message;
            this.state.queuePaused = true;
            this.state.metrics.failures++;
            this.publish();
          },
        },
      );
  }
  snapshot(): Snapshot {
    return structuredClone({ ...this.state, videoAnalysis: this.analysis?.summary() || null });
  }
  updateBrowser(info: BrowserInfo): void {
    Object.assign(this.state.browser, info);
    this.publish();
  }
  private publish(): void {
    if (!this.disposed) this.emit("snapshot", this.snapshot());
  }
  private disableMouseMovement(status = "Desligado"): void {
    this.mouseEpoch++;
    this.mouseAbort?.abort();
    this.mouseAbort = null;
    if (this.mouseTimer) clearTimeout(this.mouseTimer);
    this.mouseTimer = null;
    this.state.mouseMovement = { enabled: false, moves: 0, skipped: 0, status };
  }
  private ownsMouseMovement(threadId: string, epoch: number): boolean {
    return (
      !this.disposed &&
      this.mouseEpoch === epoch &&
      this.state.mouseMovement.enabled &&
      this.state.platform === "win32" &&
      this.state.mode === "windows" &&
      this.windowsConsent &&
      this.windowsConsentThread === threadId &&
      this.state.threadId === threadId &&
      this.state.connection === "ready" &&
      !!this.state.account
    );
  }
  private setMouseMovement(action: Extract<Action, { type: "mouseMovement" }>): void {
    if (action.threadId !== this.state.threadId)
      throw new Error("A conversa mudou. Confira o desktop na conversa atual.");
    if (!action.enabled) {
      this.disableMouseMovement();
      return;
    }
    if (
      !this.options.pulseCursor ||
      this.state.platform !== "win32" ||
      this.state.mode !== "windows" ||
      !this.windowsConsent ||
      this.windowsConsentThread !== action.threadId ||
      this.state.connection !== "ready" ||
      !this.state.account ||
      this.disposed
    )
      throw new Error(
        "Autorize o desktop e inicie uma conversa Windows antes de ativar o movimento do mouse.",
      );
    if (this.state.mouseMovement.enabled) return;
    this.state.mouseMovement = {
      enabled: true,
      moves: 0,
      skipped: 0,
      status: "Ativo · a cada 5 min",
    };
    this.scheduleMouseMovement(action.threadId, ++this.mouseEpoch);
  }
  private scheduleMouseMovement(threadId: string, epoch: number): void {
    this.mouseTimer = setTimeout(
      () => {
        this.mouseTimer = null;
        void this.moveMouse(threadId, epoch);
      },
      5 * 60 * 1000,
    );
    this.mouseTimer.unref();
  }
  private async moveMouse(threadId: string, epoch: number): Promise<void> {
    const toolEpoch = this.toolEpoch;
    const execution = this.toolQueue.then(async () => {
      if (!this.ownsMouseMovement(threadId, epoch)) return;
      const blocked =
        this.changing ||
        this.stopping ||
        this.state.approvals.length > 0 ||
        this.toolEpoch !== toolEpoch;
      let result: CursorPulseResult = { moved: false };
      if (!blocked) {
        const controller = new AbortController();
        this.mouseAbort = controller;
        try {
          result = await this.options.pulseCursor!(controller.signal);
        } finally {
          if (this.mouseAbort === controller) this.mouseAbort = null;
        }
      }
      if (!this.ownsMouseMovement(threadId, epoch)) return;
      const summary = this.state.mouseMovement;
      if (result.moved) summary.moves++;
      else summary.skipped++;
      summary.status = blocked
        ? "Intervalo omitido · aguardando aprovação ou mudança de contexto"
        : cursorPulseStatus(result);
      this.publish();
    });
    // One outstanding interval at most; all native/browser actions use the same queue.
    this.toolQueue = execution.catch(() => {});
    try {
      await execution;
    } catch {
      if (this.ownsMouseMovement(threadId, epoch)) {
        this.disableMouseMovement("Falha no movimento · ative novamente para tentar");
        this.state.metrics.failures++;
        this.publish();
      }
    } finally {
      if (this.ownsMouseMovement(threadId, epoch)) this.scheduleMouseMovement(threadId, epoch);
    }
  }
  private recordSafetyBlock(kind: "assistant" | "status" = "status"): void {
    this.disableMouseMovement();
    this.analysis?.detach();
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
    this.restoreBrowserProfile();
    try {
      await this.options.apis?.connections.init();
      this.apisReady = !!this.options.apis;
      this.refreshApis();
    } catch {
      this.state.error =
        "Não foi possível carregar as APIs salvas. Os demais recursos continuam disponíveis.";
      this.state.metrics.failures++;
    }
    this.databasesReady = false;
    this.revokeDatabases();
    try {
      await this.options.databases?.connections.init();
      this.databasesReady = !!this.options.databases;
      this.refreshDatabases();
    } catch {
      this.state.projectDatabases = null;
      this.state.error =
        "Não foi possível carregar as conexões salvas. Os demais recursos continuam disponíveis.";
      this.state.metrics.failures++;
    }
    try {
      await this.analysis?.init();
    } catch (error) {
      this.state.error = errorText(error);
      this.state.metrics.failures++;
    }
    this.publish();
  }
  private restoreBrowserProfile(): void {
    const path = this.state.project?.path;
    const id = path ? this.settings.browserProfiles[path] || null : null;
    this.options.browser?.setProfile(id);
    this.state.browser.remember = !!id;
  }
  async request(raw: Action): Promise<Snapshot> {
    const action = actionSchema.parse(raw) as Action;
    const revokingBrowser =
      (action.type === "browserConsent" && !action.allow) ||
      (action.type === "browserVisibility" && !action.visible);
    const disablingMouse = action.type === "mouseMovement" && !action.enabled;
    const revokingApis = action.type === "apiConsent" && !action.allow;
    const revokingDatabases = action.type === "databaseConsent" && !action.allow;
    if (
      this.changing &&
      !["stop", "answer", "removeVideo", "cancelDatabaseTest", "cancelApiLogin"].includes(
        action.type,
      ) &&
      !revokingBrowser &&
      !revokingApis &&
      !revokingDatabases &&
      !disablingMouse
    )
      throw new Error("Aguarde a ação em andamento.");
    const changesContext =
      [
        "connect",
        "logout",
        "selectProject",
        "projectSources",
        "listDatabases",
        "saveDatabase",
        "deleteDatabase",
        "testDatabase",
        "saveApi",
        "deleteApi",
        "authenticateApi",
        "listBranches",
        "changeBranch",
        "browserSession",
        "preferences",
        "newChat",
        "resume",
        "analyzeVideo",
      ].includes(action.type) ||
      (action.type === "browserConsent" && action.allow) ||
      (action.type === "apiConsent" && action.allow) ||
      (action.type === "databaseConsent" && action.allow) ||
      action.type === "browserControl" ||
      (action.type === "videoAnalysis" &&
        ["resume", "retry"].includes(action.control) &&
        this.analysis?.summary()?.threadId !== this.state.threadId);
    if (
      changesContext &&
      (this.state.busy || this.sending || this.drainingMessages) &&
      action.type !== "connect"
    )
      throw new Error("Pare a execução antes de mudar a conversa.");
    if (changesContext) {
      this.changing = true;
      this.contextWork = new Promise((resolve) => {
        this.finishContext = resolve;
      });
    }
    this.state.error = null;
    try {
      switch (action.type) {
        case "listApis":
          this.apiProject(action.projectPath);
          this.refreshApis();
          break;
        case "saveApi":
        case "deleteApi": {
          const api = this.apiProject(action.projectPath);
          if (action.type === "saveApi")
            await api.connections.save(
              action.projectPath,
              action.revision,
              action.connectionId,
              action.config,
              action.secret,
              action.remember,
            );
          else
            await api.connections.remove(action.projectPath, action.revision, action.connectionId);
          this.revokeApis();
          this.refreshApis();
          if (this.state.projectApis) this.state.projectApis.operation = null;
          break;
        }
        case "authenticateApi":
          await this.authenticateApi(action);
          break;
        case "cancelApiLogin":
          this.apiProject(action.projectPath);
          if (
            this.state.projectApis?.operation?.id !== action.operationId ||
            this.state.projectApis.operation.status !== "working"
          )
            throw new ApiFailure("Esse login já terminou ou pertence a outra solicitação.");
          this.apiLoginGeneration++;
          this.options.apis!.cancel();
          await this.apiLoginWork;
          break;
        case "apiConsent": {
          const api = this.apiProject(action.projectPath);
          api.connections.check(action.projectPath, action.revision);
          if (action.allow) {
            if (this.state.threadId && !this.settings.threads[this.state.threadId]?.httpTool)
              throw new ApiFailure(
                "Este histórico não possui stag_http. Abra uma nova conversa para autorizar APIs, preservando o modo desejado.",
              );
            if (!this.state.projectApis?.connections.length)
              throw new ApiFailure("Cadastre uma API antes de autorizar.");
            this.state.projectApis!.authorized = true;
            this.apiConsentThread = this.state.threadId;
          } else {
            this.revokeApis();
            this.state.queuePaused = true;
            this.analysis?.detach();
            if (this.state.busy) await this.stop();
          }
          break;
        }
        case "listDatabases":
          this.databaseProject(action.projectPath);
          this.refreshDatabases();
          break;
        case "databaseConsent": {
          const database = this.databaseProject(action.projectPath);
          database.connections.check(action.projectPath, action.revision);
          if (action.allow) {
            if (
              !database.tools ||
              (this.state.threadId && !this.settings.threads[this.state.threadId]?.sqlTool)
            )
              throw new Error(
                "Este histórico não possui stag_sql. Abra uma nova conversa preservando o modo desejado.",
              );
            if (!this.state.projectDatabases?.connections.length)
              throw new Error("Cadastre uma conexão antes de autorizar bancos.");
            this.state.projectDatabases.authorized = true;
            this.databaseConsentThread = this.state.threadId;
          } else {
            this.revokeDatabases();
            this.state.queuePaused = true;
            this.analysis?.detach();
            if (this.state.busy) await this.stop();
            else await this.toolQueue;
          }
          break;
        }
        case "saveDatabase": {
          const database = this.databaseProject(action.projectPath);
          await database.connections.save(
            action.projectPath,
            action.revision,
            action.connectionId,
            action.config,
            action.password,
            action.rememberPassword,
          );
          this.revokeDatabases();
          this.refreshDatabases();
          break;
        }
        case "deleteDatabase": {
          const database = this.databaseProject(action.projectPath);
          await database.connections.remove(
            action.projectPath,
            action.revision,
            action.connectionId,
          );
          this.revokeDatabases();
          this.refreshDatabases();
          break;
        }
        case "testDatabase":
          await this.testDatabase(action);
          break;
        case "cancelDatabaseTest":
          this.databaseProject(action.projectPath);
          if (this.state.projectDatabases?.test?.id !== action.testId)
            throw new Error("Esse teste já terminou ou pertence a outra solicitação.");
          this.databaseAbort?.abort();
          await this.databaseWork;
          break;
        case "listBranches":
        case "changeBranch": {
          const path = this.state.project?.path;
          if (!path || path !== action.projectPath)
            throw new Error("O projeto mudou. Reabra Branches na pasta desejada.");
          if (this.analysis?.working || this.videoPreparation || this.state.approvals.length)
            throw new Error(
              "Pause a análise e conclua as ações pendentes antes de gerenciar branches.",
            );
          if (action.type === "changeBranch" && this.state.mode === "read")
            throw new Error(
              "O modo Leitura permite apenas consultar branches. Selecione Projeto para alterá-las.",
            );
          const controller = new AbortController();
          this.branchController = controller;
          const epoch = this.toolEpoch;
          if (action.type === "changeBranch") this.state.queuePaused = true;
          const execution = this.toolQueue.then(async () => {
            if (this.disposed || controller.signal.aborted || epoch !== this.toolEpoch)
              throw new Error("Operação de branches cancelada. Atualize a lista.");
            if (action.type === "listBranches") {
              this.state.projectBranches = await this.branches.list(path, controller.signal);
            } else {
              let result;
              try {
                result = await this.branches.change(
                  path,
                  action.revision,
                  action.repositoryId,
                  action.operation,
                  this.options.confirmBranchDeletion || (async () => false),
                  controller.signal,
                );
              } finally {
                // Even a failed command can have partial effects. Refresh evidence, never replay it.
                this.state.projectBranches = null;
                if (!controller.signal.aborted && !this.disposed)
                  this.state.projectBranches = await this.branches.list(path, controller.signal);
              }
              if (this.state.projectBranches) this.state.projectBranches.message = result.message;
              if (result.changed) {
                this.contextInstructionsDirty = true;
                const repo = this.state.projectBranches?.repositories.find(
                  (repo) => repo.id === action.repositoryId,
                );
                const operation = action.operation;
                const confirmed =
                  repo &&
                  !repo.error &&
                  (operation.kind === "switch"
                    ? repo.current === operation.branch
                    : operation.kind === "delete"
                      ? !repo.branches.some(
                          (branch) => branch.kind === "local" && branch.name === operation.branch,
                        )
                      : repo.branches.some(
                          (branch) => branch.kind === "local" && branch.name === operation.name,
                        ));
                if (!confirmed) {
                  if (this.state.projectBranches) this.state.projectBranches.message = null;
                  throw new GitFailure(
                    "O comando Git terminou, mas não foi possível confirmar o estado resultante. Atualize a lista e confira o projeto antes de tentar novamente.",
                  );
                }
                if (this.state.threadId)
                  this.state.items.push({
                    id: `branches-${randomUUID()}`,
                    kind: "status",
                    text: result.message,
                  });
              }
            }
            this.state.metrics.failures +=
              (this.state.projectBranches?.repositories.filter((repo) => repo.error).length || 0) +
              (this.state.projectBranches?.issues.length || 0);
          });
          this.toolQueue = execution.catch(() => {});
          try {
            await execution;
          } catch (error) {
            if (error instanceof GitFailure) throw error;
            throw new Error(
              "Não foi possível concluir a operação de branches. Atualize a lista e confira o estado antes de tentar novamente.",
            );
          } finally {
            if (this.branchController === controller) this.branchController = null;
          }
          break;
        }
        case "mouseMovement":
          this.setMouseMovement(action);
          break;
        case "analyzeVideo":
          await this.startVideoAnalysis();
          break;
        case "videoAnalysis": {
          if (!this.analysis)
            throw new Error("Análise em segundo plano disponível somente no STAG desktop.");
          const summary = this.analysis.summary();
          if (!summary || summary.id !== action.id)
            throw new Error("Análise indisponível neste projeto, conversa ou conta.");
          if (summary.threadId !== this.state.threadId) {
            if (this.state.busy || this.sending)
              throw new Error("Pare a execução antes de retomar a análise salva.");
            await this.resume(summary.threadId);
          }
          if (action.control === "pause" || action.control === "cancel") {
            this.state.queuePaused = true;
            this.disableMouseMovement();
          }
          await this.analysis.control(action.id, action.control);
          break;
        }
        case "selectVideo":
          await this.selectVideo();
          break;
        case "removeVideo":
          this.clearVideo();
          break;
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
          if (this.analysis?.working)
            throw new Error(
              "Pause ou conclua a análise de vídeo antes de enviar outra mensagem. Você pode adicionar textos à fila.",
            );
          if (this.state.queuedMessages.length || this.drainingMessages)
            throw new Error("Continue ou esvazie a fila antes de enviar outra mensagem.");
          this.state.queuePaused = false;
          await this.send(action.text, action.images || [], action.videoId);
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
        case "browserSession": {
          const path = this.state.project?.path;
          const browser = this.options.browser;
          if (!browser || !path || path !== action.projectPath)
            throw new Error("O projeto mudou. Abra o navegador no projeto desejado.");
          if (action.remember === this.state.browser.remember) break;
          // End authority immediately, then wait for the shared queue before replacing storage.
          this.toolEpoch++;
          this.options.desktop.cancel?.();
          this.options.apis?.cancel();
          this.options.databases?.tools?.cancel();
          this.state.browser.authorized = false;
          this.browserConsentThread = null;
          this.contextInstructionsDirty = true;
          this.state.queuePaused = true;
          browser.cancel();
          this.publish();
          await this.toolQueue;
          const profiles = { ...this.settings.browserProfiles };
          if (action.remember) profiles[path] = randomUUID();
          else {
            await browser.clearProfile();
            delete profiles[path];
          }
          const settings = { ...this.settings, browserProfiles: profiles };
          try {
            await this.options.store.save(settings);
          } catch (error) {
            this.restoreBrowserProfile();
            throw error;
          }
          this.settings = settings;
          this.restoreBrowserProfile();
          break;
        }
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
          const ownerThread = this.state.threadId;
          const epoch = this.toolEpoch;
          const execution = this.toolQueue.then(() => {
            if (this.disposed || this.toolEpoch !== epoch || this.state.threadId !== ownerThread)
              throw new Error("Navegação pendente cancelada: a conversa ou autorização mudou.");
            return this.options.browser!.control(action.control);
          });
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
      if (changesContext) {
        this.changing = false;
        this.finishContext?.();
        this.finishContext = null;
      }
      this.publish();
      void this.drainMessageQueue();
    }
    return this.snapshot();
  }
  private requireQueueThread(threadId: string): void {
    if (!this.state.project || !this.state.threadId || this.state.threadId !== threadId)
      throw new Error("A conversa mudou. Confira a conversa antes de alterar a fila.");
  }
  private clearVideo(): void {
    this.videoPreparation?.abort();
    this.videoPreparation = null;
    this.preparedVideo = null;
    this.state.pendingVideo = null;
  }
  private refreshDatabases(): void {
    const previous = this.state.projectDatabases;
    const next =
      this.state.project && this.databasesReady
        ? this.options.databases!.connections.snapshot(this.state.project.path)
        : null;
    if (next && previous) {
      next.authorized = previous.authorized && previous.revision === next.revision;
      if (!next.authorized) this.databaseConsentThread = null;
      next.test = previous.test;
      next.metrics = previous.metrics;
    }
    this.state.projectDatabases = next;
  }
  private revokeDatabases(): void {
    this.options.databases?.tools?.cancel();
    this.databaseConsentThread = null;
    if (this.state.projectDatabases) this.state.projectDatabases.authorized = false;
  }
  private refreshApis(): void {
    const previous = this.state.projectApis;
    const next =
      this.state.project && this.apisReady
        ? this.options.apis!.connections.snapshot(this.state.project.path)
        : null;
    if (next && previous) {
      next.authorized = previous.authorized && previous.revision === next.revision;
      if (!next.authorized) this.apiConsentThread = null;
      next.operation = previous.operation;
      next.metrics = previous.metrics;
    }
    this.state.projectApis = next;
  }
  private revokeApis(): void {
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
    this.apiLoginGeneration++;
    this.apiConsentThread = null;
    if (this.state.projectApis) this.state.projectApis.authorized = false;
  }
  private apiProject(path: string): HttpTools {
    if (this.state.project?.path !== path)
      throw new ApiFailure("O projeto mudou. Reabra APIs na pasta desejada.");
    if (!this.options.apis || !this.apisReady)
      throw new ApiFailure("APIs indisponíveis. Reinicie o STAG para carregar a configuração.");
    return this.options.apis;
  }
  private async authenticateApi(
    action: Extract<Action, { type: "authenticateApi" | "deleteApi" }>,
  ): Promise<void> {
    const api = this.apiProject(action.projectPath);
    api.connections.get(action.projectPath, action.revision, action.connectionId);
    if (this.analysis?.working || this.videoPreparation || this.state.approvals.length)
      throw new ApiFailure("Pause a análise e conclua as ações pendentes antes de entrar na API.");
    const epoch = this.toolEpoch;
    const generation = ++this.apiLoginGeneration;
    const id = randomUUID();
    this.state.projectApis!.operation = {
      id,
      connectionId: action.connectionId,
      status: "working",
      message: "Autenticando na API…",
    };
    this.publish();
    const work = this.toolQueue.then(async () => {
      try {
        if (epoch !== this.toolEpoch || this.disposed || generation !== this.apiLoginGeneration)
          throw new ApiFailure("Login da API cancelado.");
        await api.authenticate(action.projectPath, action.revision, action.connectionId);
        if (epoch !== this.toolEpoch || this.disposed || generation !== this.apiLoginGeneration)
          throw new ApiFailure("Login da API cancelado.");
        this.refreshApis();
        this.state.projectApis!.operation = {
          id,
          connectionId: action.connectionId,
          status: "success",
          message: "API autenticada. As credenciais permanecem no STAG.",
        };
      } catch (error) {
        if (
          this.state.project?.path === action.projectPath &&
          this.state.projectApis?.operation?.id === id
        ) {
          const canceled = epoch !== this.toolEpoch || /cancelad/.test(apiError(error));
          this.state.projectApis.operation = {
            id,
            connectionId: action.connectionId,
            status: canceled ? "canceled" : "error",
            message: apiError(error),
          };
          if (!canceled) this.state.metrics.failures++;
        }
      } finally {
        this.publish();
      }
    });
    this.apiLoginWork = work;
    this.toolQueue = work.catch(() => {});
    await work;
  }
  private databaseProject(path: string) {
    if (!this.state.project || this.state.project.path !== path)
      throw new Error("O projeto mudou. Reabra Conexões na pasta desejada.");
    if (!this.options.databases || !this.databasesReady)
      throw new Error(
        "Conexões indisponíveis. Reinicie o STAG para tentar carregar a configuração.",
      );
    return this.options.databases;
  }
  private async testDatabase(action: Extract<Action, { type: "testDatabase" }>): Promise<void> {
    const database = this.databaseProject(action.projectPath);
    if (this.databaseTestIds.has(action.testId)) return;
    if (this.analysis?.working || this.videoPreparation || this.state.approvals.length)
      throw new Error("Pause a análise e conclua as ações pendentes antes de testar a conexão.");
    const password = database.connections.password(
      action.projectPath,
      action.revision,
      action.connectionId,
      action.config,
      action.password,
    );
    this.databaseTestIds.add(action.testId);
    if (this.databaseTestIds.size > 100)
      this.databaseTestIds.delete(this.databaseTestIds.values().next().value!);
    const controller = new AbortController();
    this.databaseAbort = controller;
    const epoch = this.toolEpoch;
    this.state.projectDatabases!.test = {
      id: action.testId,
      status: "testing",
      message: "Testando conexão…",
    };
    this.publish();
    const execution = this.toolQueue.then(async () => {
      const started = Date.now();
      try {
        if (controller.signal.aborted || this.disposed || epoch !== this.toolEpoch)
          throw new Error();
        await database.test(action.config, password, controller.signal);
        if (controller.signal.aborted || epoch !== this.toolEpoch) throw new Error();
        if (!controller.signal.aborted && !this.disposed && epoch === this.toolEpoch)
          this.state.projectDatabases!.test = {
            id: action.testId,
            status: "success",
            message: "Conexão validada. O teste não altera dados e a sessão foi fechada.",
            elapsedMs: Date.now() - started,
          };
      } catch (error) {
        if (
          !this.disposed &&
          this.state.project?.path === action.projectPath &&
          this.state.projectDatabases?.test?.id === action.testId
        ) {
          const canceled = controller.signal.aborted || epoch !== this.toolEpoch;
          this.state.projectDatabases!.test = {
            id: action.testId,
            status: canceled ? "canceled" : "error",
            message: canceled ? "Teste de conexão cancelado." : databaseTestError(error),
            elapsedMs: Date.now() - started,
          };
          if (!canceled) this.state.metrics.failures++;
        }
      } finally {
        if (this.databaseAbort === controller) this.databaseAbort = null;
        this.publish();
      }
    });
    this.databaseWork = execution;
    this.toolQueue = execution.catch(() => {});
    await execution;
  }
  private async selectVideo(): Promise<void> {
    if (!this.options.video || !this.state.project)
      throw new Error("Selecione uma pasta de projeto para anexar um vídeo.");
    if (this.videoPreparation || this.sending || this.state.busy || this.analysis?.working)
      throw new Error("Aguarde ou cancele a preparação/execução atual.");
    const previous = this.preparedVideo;
    const controller = new AbortController();
    this.videoPreparation = controller;
    this.state.pendingVideo = { status: "preparing", phase: "Selecionando vídeo…" };
    this.publish();
    const work = this.videoWork.then(async () => {
      if (controller.signal.aborted) return;
      const path = await this.options.video!.select();
      if (controller.signal.aborted) return;
      if (!path) {
        this.state.pendingVideo = previous ? { status: "ready", summary: previous.summary } : null;
        return;
      }
      const prepared = await this.options.video!.prepare(path, controller.signal, (phase) => {
        if (!controller.signal.aborted) {
          this.state.pendingVideo = { status: "preparing", phase };
          this.publish();
        }
      });
      if (controller.signal.aborted) return;
      this.preparedVideo = prepared;
      this.state.pendingVideo = { status: "ready", summary: prepared.summary };
    });
    this.videoWork = work.catch(() => {});
    try {
      await work;
    } catch (error) {
      if (!controller.signal.aborted) {
        this.state.pendingVideo = previous ? { status: "ready", summary: previous.summary } : null;
        throw error;
      }
    } finally {
      if (this.videoPreparation === controller) this.videoPreparation = null;
    }
  }
  private analysisAccountKey(): string | null {
    return this.state.account?.email
      ? createHash("sha256").update(this.state.account.email.trim().toLowerCase()).digest("hex")
      : null;
  }
  private rejectAnalysisTurn(): void {
    this.analysisWaiter?.reject(
      new Error("A conexão foi encerrada. Confira o histórico antes de retomar."),
    );
    this.analysisWaiter = null;
  }
  private async startVideoAnalysis(): Promise<void> {
    if (!this.analysis || !this.options.videoAnalysis || !this.options.video || !this.state.project)
      throw new Error("Selecione uma pasta no STAG desktop para analisar o vídeo.");
    if (
      this.analysis.working ||
      this.videoPreparation ||
      this.state.pendingVideo ||
      this.sending ||
      this.state.busy ||
      this.state.queuedMessages.length
    )
      throw new Error(
        "Conclua ou pause a execução e remova o anexo atual antes de iniciar outro vídeo.",
      );
    const existing = this.analysis.summary();
    if (existing && !["completed", "cancelled"].includes(existing.status))
      throw new Error("Retome ou cancele a análise salva antes de selecionar outro vídeo.");
    const accountKey = this.analysisAccountKey();
    if (!accountKey || this.state.connection !== "ready")
      throw new Error("Entre com sua conta ChatGPT antes de analisar o vídeo.");
    const model = this.state.models.find((entry) => entry.model === this.state.model);
    if (!model || (model.inputModalities && !model.inputModalities.includes("image")))
      throw new Error("Selecione um modelo da sua conta que aceite imagens.");
    const project = this.state.project.path;
    const mode = this.state.mode;
    const controller = new AbortController();
    this.videoPreparation = controller;
    this.state.pendingVideo = {
      status: "preparing",
      phase: "Selecionando vídeo para análise em segundo plano…",
    };
    this.publish();
    const work = this.videoWork.then(async () => {
      const path = await this.options.video!.select();
      if (!path || controller.signal.aborted) return;
      const source = await this.options.videoAnalysis!.processor.inspect(path, controller.signal);
      if (
        controller.signal.aborted ||
        this.state.project?.path !== project ||
        this.state.mode !== mode ||
        this.analysisAccountKey() !== accountKey
      )
        return;
      await this.ensureThread();
      this.settings.threads[this.state.threadId!].backgroundVideo = true;
      await this.options.store.save(this.settings).catch(() => {
        throw new Error(
          "Não foi possível salvar o progresso do vídeo. Confira o armazenamento do STAG.",
        );
      });
      if (controller.signal.aborted) return;
      await this.analysis!.start({
        id: randomUUID(),
        projectPath: project,
        threadId: this.state.threadId!,
        mode,
        accountKey,
        source,
        next: 0,
        status: "running",
        pending: null,
      });
    });
    this.videoWork = work.catch(() => {});
    try {
      await work;
    } catch (error) {
      if (!controller.signal.aborted) {
        if (
          error instanceof Error &&
          /^(Selecione|O arquivo|Vídeo inválido|Não foi possível (preparar|salvar|ler))/.test(
            error.message,
          )
        )
          throw error;
        throw new Error(
          "Não foi possível iniciar a análise do vídeo. Confira a conexão e o armazenamento do STAG.",
        );
      }
    } finally {
      if (this.videoPreparation === controller) {
        this.videoPreparation = null;
        this.state.pendingVideo = null;
      }
    }
  }
  private async recoverAnalysisTurn(job: VideoAnalysisJob): Promise<AnalysisTurn | null> {
    const policy = this.settings.threads[job.threadId];
    if (
      policy?.path !== job.projectPath ||
      policy.mode !== job.mode ||
      this.state.threadId !== job.threadId
    )
      throw new Error("A política original da conversa não está disponível.");
    const marker = `Análise STAG ${job.id} · trecho ${job.pending!.index + 1}/`;
    for await (const turn of this.analysisHistory(job.threadId)) {
      const matches = job.pending?.turnId
        ? turn.id === job.pending.turnId
        : turn.items?.some(
            (item) =>
              item.type === "userMessage" &&
              item.content?.some(
                (content) => content.type === "text" && content.text?.includes(marker),
              ),
          );
      if (matches) return { id: turn.id, status: turn.status };
    }
    return null;
  }
  private async *analysisHistory(threadId: string): AsyncGenerator<WireTurn> {
    let cursor: string | null = null;
    const cursors = new Set<string>();
    // One bounded turn per RPC frame; a 12-hour video must not hydrate all images at once.
    for (let count = 0; count < 1000; count++) {
      const page: { data: WireTurn[]; nextCursor: string | null } = await this.call<{
        data: WireTurn[];
        nextCursor: string | null;
      }>("thread/turns/list", {
        threadId,
        cursor,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      });
      if (
        !Array.isArray(page.data) ||
        page.data.length > 1 ||
        page.data.some((turn) => !turn.id || typeof turn.status !== "string")
      )
        throw new Error("Não foi possível recuperar o histórico paginado do vídeo.");
      for (const turn of page.data) {
        const videoTurn = turn.items?.some(
          (item) =>
            item.type === "userMessage" &&
            item.content?.some(
              (content) => content.type === "text" && content.text?.startsWith("Análise STAG "),
            ),
        );
        yield {
          ...turn,
          items: turn.items?.map((item) =>
            videoTurn && item.type === "userMessage"
              ? {
                  ...item,
                  content: item.content?.map((content) =>
                    content.type === "image" ? { type: "image" } : content,
                  ),
                }
              : item,
          ),
        };
      }
      cursor = page.nextCursor;
      if (!cursor) return;
      if (cursors.has(cursor))
        throw new Error("Não foi possível recuperar o histórico paginado do vídeo.");
      cursors.add(cursor);
    }
  }
  private async waitAnalysisTurn(
    job: VideoAnalysisJob,
    previous: AnalysisTurn | null,
    video?: PreparedVideo,
  ): Promise<AnalysisTurn> {
    let resolve!: (turn: AnalysisTurn) => void;
    let reject!: (error: Error) => void;
    const completed = new Promise<AnalysisTurn>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void completed.catch(() => {});
    const waiter = { threadId: job.threadId, turnId: previous?.id || null, resolve, reject };
    if (this.analysisWaiter) throw new Error("Já existe um trecho aguardando a conversa.");
    this.analysisWaiter = waiter;
    this.analysisInterruptRequested = false;
    try {
      if (video) await this.send("", [], undefined, video);
      else {
        // Refresh the surviving turn after attaching the waiter; a completion during recovery is authoritative.
        const turn = await this.recoverAnalysisTurn(job);
        if (turn?.status !== "inProgress") {
          if (!turn) throw new Error("Envio não confirmado. Confira o histórico.");
          waiter.resolve(turn);
        } else {
          this.turnId = turn.id;
          this.state.busy = true;
        }
      }
      const turn = await completed;
      await this.toolQueue;
      return turn;
    } finally {
      if (this.analysisWaiter === waiter) this.analysisWaiter = null;
    }
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
      !this.analysis?.working &&
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
    this.revokeApis();
    this.revokeDatabases();
    this.databaseAbort?.abort();
    this.disableMouseMovement();
    this.analysis?.detach();
    this.rejectAnalysisTurn();
    if (this.state.queuedMessages.length || this.state.busy || this.sending)
      this.state.queuePaused = true;
    this.toolEpoch++;
    this.options.desktop.cancel?.();
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
    this.options.browser?.cancel();
    this.stopping = false;
    this.toolRequests.clear();
    this.rpc?.removeAllListeners();
    await this.rpc?.shutdown();
    await this.sqlWork;
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
      this.revokeApis();
      this.revokeDatabases();
      this.databaseAbort?.abort();
      this.branchController?.abort();
      this.disableMouseMovement();
      this.toolEpoch++;
      this.options.desktop.cancel?.();
      this.options.apis?.cancel();
      this.options.databases?.tools?.cancel();
      this.options.browser?.cancel();
      this.analysis?.detach();
      this.rejectAnalysisTurn();
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
    if (previousAccount && previousAccount.email !== this.state.account?.email) {
      this.revokeApis();
      this.revokeDatabases();
      this.disableMouseMovement();
      this.analysis?.detach();
      this.rejectAnalysisTurn();
      this.clearMessageQueue();
      this.clearVideo();
    }
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
    this.state.projectApis = null;
    this.refreshApis();
    this.branches.clear();
    this.state.projectBranches = null;
    this.state.projectSources = this.settings.projectSources[path] || [];
    this.state.projectDatabases = null;
    this.refreshDatabases();
    this.restoreBrowserProfile();
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
    this.disableMouseMovement();
    this.analysis?.detach();
    this.toolEpoch++;
    this.options.desktop.cancel?.();
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
    this.clearVideo();
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
    this.revokeApis();
    this.revokeDatabases();
    this.state.browser.authorized = false;
    this.browserConsentThread = null;
    this.contextInstructionsDirty = false;
    this.options.browser?.reset();
    if (this.state.mode === "windows") this.state.mode = "project";
    this.state.metrics.totalTokens = 0;
    this.state.metrics.elapsedMs = 0;
  }
  private async browserConsent(allow: boolean): Promise<void> {
    if (!allow) this.databaseAbort?.abort();
    if (!this.options.browser) throw new Error("Navegador disponível somente no STAG desktop.");
    if (!allow) {
      this.state.queuePaused = true;
      this.analysis?.detach();
    }
    if (allow && (this.state.busy || this.sending))
      throw new Error("Pare a execução antes de autorizar o navegador.");
    if (allow && this.state.threadId && !this.settings.threads[this.state.threadId]?.browserTool)
      throw new Error(
        "Abra uma nova conversa para usar o navegador neste histórico anterior à versão 0.4.",
      );
    this.toolEpoch++;
    this.options.desktop.cancel?.();
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
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
      this.revokeApis();
      this.revokeDatabases();
      this.disableMouseMovement();
      this.toolEpoch++;
      this.options.desktop.cancel?.();
      this.options.apis?.cancel();
      this.options.databases?.tools?.cancel();
      this.toolRequests.clear();
      this.state.browser.authorized = false;
      this.browserConsentThread = null;
      this.options.browser?.reset();
    }
    const result = await this.call<{ thread: WireThread }>("thread/resume", {
      threadId: id,
      ...(policy.backgroundVideo ? { excludeTurns: true } : {}),
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
        projectGitInstructions(this.state.project?.git) +
        "\n" +
        projectBranchesInstructions,
    });
    if (policy.backgroundVideo) {
      const turns: WireTurn[] = [];
      for await (const turn of this.analysisHistory(id)) turns.push(turn);
      result.thread.turns = turns.reverse();
    }
    if (this.state.threadId !== id) {
      this.analysis?.detach();
      this.clearMessageQueue();
      this.clearVideo();
    }
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
  private async ensureThread(): Promise<void> {
    const project = this.state.project;
    if (!project) throw new Error("Selecione uma pasta de projeto.");
    if (!this.state.threadId) {
      const result = await this.call<{ thread: WireThread }>("thread/start", {
        cwd: project.path,
        model: this.state.model,
        ...threadPolicy(this.state.mode, project.path),
        developerInstructions:
          assistantInstructions(
            this.state.mode,
            this.state.platform,
            this.state.browser.authorized,
            !!this.options.browser,
            project.path,
            this.state.projectSources,
          ) +
          "\n" +
          projectGitInstructions(project.git) +
          "\n" +
          projectBranchesInstructions,
        serviceName: "stag_desktop",
        dynamicTools: [
          ...(this.state.mode === "windows" ? [desktopTool] : []),
          ...(this.options.browser ? [browserTool] : []),
          ...(this.apisReady ? [httpTool] : []),
          ...(this.databasesReady && this.options.databases?.tools ? [sqlTool] : []),
        ],
      });
      this.state.threadId = result.thread.id;
      this.contextInstructionsDirty = false;
      if (this.state.mode === "windows") this.windowsConsentThread = result.thread.id;
      if (this.state.browser.authorized) this.browserConsentThread = result.thread.id;
      if (this.state.projectApis?.authorized) this.apiConsentThread = result.thread.id;
      if (this.state.projectDatabases?.authorized) this.databaseConsentThread = result.thread.id;
      this.settings.threads[result.thread.id] = {
        path: project.path,
        mode: this.state.mode,
        browserTool: !!this.options.browser,
        httpTool: this.apisReady,
        sqlTool: this.databasesReady && !!this.options.databases?.tools,
      };
      await this.options.store.save(this.settings);
    }
  }
  private async send(
    input: string,
    images: RequestImage[],
    videoId?: string,
    analysisVideo?: PreparedVideo,
  ): Promise<void> {
    const video = analysisVideo || (videoId ? this.preparedVideo : null);
    if (
      videoId &&
      (!video || video.summary.id !== videoId || this.state.pendingVideo?.status !== "ready")
    )
      throw new Error("Vídeo indisponível nesta conversa. Selecione o arquivo novamente.");
    if (video && images.length) throw new Error("Envie o vídeo separadamente das imagens coladas.");
    if (this.sending || this.state.busy) throw new Error("Aguarde ou pare a execução atual.");
    if (this.state.connection !== "ready" || !this.state.account)
      throw new Error("Entre com sua conta ChatGPT para continuar.");
    if (!this.state.project) throw new Error("Selecione uma pasta de projeto.");
    const selectedModel = this.state.models.find((m) => m.model === this.state.model);
    if (!selectedModel)
      throw new Error("Nenhum modelo disponível. Reconecte para atualizar a lista.");
    if (
      (images.length || video) &&
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
    if (video) input = `${input}${input ? "\n\n" : ""}${videoMessage(video)}`;
    const suppliedImages = video ? videoImages(video).images : images;
    this.sending = true;
    try {
      // Preview and authoritative item must refer to the same encoded image; otherwise
      // userMessage reconciliation would retain both original and compressed messages.
      const sentImages = suppliedImages.map((image) => ({
        dataUrl: this.options.optimizeImage?.(image.dataUrl) ?? image.dataUrl,
      }));
      const displayImages = requestImagesSchema.safeParse(analysisVideo ? [] : sentImages);
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
      await this.ensureThread();
      this.state.items.push({
        id: localId,
        kind: "user",
        text: input,
        ...(displayImages.success && displayImages.data.length
          ? { images: displayImages.data }
          : {}),
      });
      this.publish();
      this.refreshDatabases();
      const result = await this.call<{ turn: WireTurn }>("turn/start", {
        threadId: this.state.threadId,
        cwd: this.state.project.path,
        input: [
          ...(input ? [{ type: "text", text: input }] : []),
          ...sentImages.map((image) => ({ type: "image", url: image.dataUrl })),
        ],
        model: this.state.model,
        effort: this.state.effort,
        additionalContext: {
          ...databaseContext(
            this.state.projectDatabases,
            !!this.settings.threads[this.state.threadId!]?.sqlTool,
          ),
          ...apiContext(
            this.state.projectApis,
            !!this.settings.threads[this.state.threadId!]?.httpTool,
          ),
          ...projectBranchesContext(this.state.projectBranches),
          ...projectSourcesContext(
            this.state.project.path,
            this.state.projectSources,
            this.state.browser.authorized,
            !!this.settings.threads[this.state.threadId!]?.browserTool,
          ),
          stag_video: video
            ? videoContext(video)
            : { kind: "untrusted", value: JSON.stringify({ attached: false }) },
        },
        ...turnPolicy(this.state.mode, this.state.project.path),
      });
      // A small turn can finish before this response arrives. Do not resurrect it.
      if (this.state.busy) this.turnId = result.turn.id;
      if (analysisVideo && this.analysisWaiter) this.analysisWaiter.turnId = result.turn.id;
      if (analysisVideo && this.analysisInterruptRequested && this.state.busy) await this.stop();
      if (video && this.preparedVideo === video) this.clearVideo();
    } catch (error) {
      this.state.busy = false;
      this.turnId = null;
      this.state.items = this.state.items.filter((item) => item.id !== localId);
      // A timed-out request may have started upstream; reconnect instead of replaying.
      if (/demorou/.test(errorText(error))) this.rpc?.close();
      if (video)
        throw new Error(
          "Não foi possível confirmar o envio do vídeo. O anexo foi preservado; confira o histórico antes de tentar novamente.",
        );
      throw error;
    } finally {
      this.sending = false;
      this.publish();
      void this.drainMessageQueue();
    }
  }
  private async stop(): Promise<void> {
    const sqlWork = this.sqlWork;
    const apiWork = Promise.all([this.apiLoginWork, this.httpWork]);
    const databaseWork = this.databaseAbort ? this.databaseWork : null;
    this.databaseAbort?.abort();
    this.branchController?.abort();
    this.disableMouseMovement();
    this.analysis?.detach();
    this.state.queuePaused = true;
    this.toolEpoch++;
    this.options.desktop.cancel?.();
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
    this.options.browser?.cancel();
    if (!this.state.busy) {
      if (databaseWork) await databaseWork;
      await apiWork;
      await sqlWork;
      return;
    }
    if (!this.turnId || !this.state.threadId)
      throw new Error("A execução está iniciando. Tente parar em instantes.");
    this.stopping = true;
    this.pending.clear();
    this.state.approvals = [];
    this.publish();
    try {
      await this.call("turn/interrupt", { threadId: this.state.threadId, turnId: this.turnId });
      if (databaseWork) await databaseWork;
      await apiWork;
    } catch (error) {
      // An uncertain interrupt must not leave an agent waiting on discarded requests.
      this.rpc?.close();
      throw error;
    } finally {
      await sqlWork;
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
      const analysisMessage =
        this.settings.threads[this.state.threadId || ""]?.backgroundVideo &&
        message.startsWith("Análise STAG ");
      const parsedImages = requestImagesSchema.safeParse(
        analysisMessage
          ? []
          : (item.content || [])
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
        if (this.analysisWaiter && this.analysisWaiter.threadId === p.threadId)
          this.analysisWaiter.turnId = this.turnId;
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
        this.analysis?.detach();
        this.state.error = text(object(p.error).message) || "Falha na execução.";
        this.state.queuePaused = true;
        break;
      case "turn/completed": {
        const turn = object(p.turn) as unknown as WireTurn;
        if (!this.state.busy || !turn.id) return;
        if (this.turnId && turn.id !== this.turnId) return;
        this.toolEpoch++;
        this.options.desktop.cancel?.();
        this.options.apis?.cancel();
        this.options.databases?.tools?.cancel();
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
        if (
          this.analysisWaiter &&
          this.analysisWaiter.threadId === p.threadId &&
          (!this.analysisWaiter.turnId || this.analysisWaiter.turnId === turn.id)
        )
          this.analysisWaiter.resolve({ id: turn.id, status: turn.status });
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
      if (p.tool === "stag_sql") {
        await this.sqlRequest(message);
        return;
      }
      if (p.tool === "stag_http") {
        await this.httpRequest(message);
        return;
      }
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
                  : "Ferramenta não autorizada nesta conversa. O desktop requer Autorizar desktop e permite somente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient; não contorne o bloqueio por comandos ou outra automação.",
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
                : "Argumentos de desktop inválidos. Liste as janelas e informe processId em toda outra ação, inclusive screenshot, click e scroll. Somente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient são permitidos; não há captura da tela inteira.",
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
            execute: (approved) =>
              approved
                ? this.options.desktop.execute(args, true)
                : this.options.desktop.execute(args),
            confirmation: () => this.options.desktop.confirmationReason(args),
            approval: (reason) =>
              desktopApproval(args as Parameters<typeof desktopApproval>[0], reason),
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
    const ownsRequest = () =>
      !this.disposed &&
      !this.stopping &&
      this.state.busy &&
      this.rpc === ownerRpc &&
      this.state.threadId === ownerThread &&
      this.turnId === ownerTurn &&
      this.toolEpoch === epoch;
    const ownsTurn = () =>
      ownsRequest() &&
      (waiting.tool === "http"
        ? !!this.state.projectApis?.authorized && this.apiConsentThread === ownerThread
        : waiting.tool === "sql"
          ? !!this.state.projectDatabases?.authorized && this.databaseConsentThread === ownerThread
          : waiting.tool === "browser"
            ? this.state.browser.authorized && this.browserConsentThread === ownerThread
            : this.state.mode === "windows" &&
              this.windowsConsent &&
              this.windowsConsentThread === ownerThread);
    const noAuthority: ToolResult = {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "A autorização da ferramenta mudou. Confira o contexto e autorize novamente antes de continuar.",
        },
      ],
    };
    const execution = this.toolQueue.then(async () => {
      if (!ownsTurn()) {
        if (ownsRequest()) ownerRpc.respond(waiting.message.id!, noAuthority);
        return;
      }
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
            if (!ownsTurn()) {
              if (ownsRequest()) ownerRpc.respond(waiting.message.id!, noAuthority);
              return;
            }
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
              result = await waiting.execute!(accept === true);
              if (ownsTurn() && this.options.optimizeImage)
                result = {
                  ...result,
                  contentItems: result.contentItems.map((item) =>
                    item.type === "inputImage"
                      ? { ...item, imageUrl: this.options.optimizeImage!(item.imageUrl) }
                      : item,
                  ),
                };
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
      if (ownsRequest()) {
        if (!ownsTurn()) result = noAuthority;
        if (!result.success && this.analysis?.working) {
          this.analysis.detach();
          this.state.queuePaused = true;
        }
        ownerRpc.respond(waiting.message.id!, result);
      }
      this.publish();
    });
    // Desktop, browser, HTTP and SQL share one queue, including approved operations.
    this.toolQueue = execution.catch(() => {});
    if (waiting.tool === "sql") this.sqlWork = execution;
    await execution;
  }
  private async sqlRequest(message: RpcMessage): Promise<void> {
    const p = message.params || {};
    const reply = (messageText: string) =>
      this.rpc!.respond(message.id!, {
        success: false,
        contentItems: [{ type: "inputText", text: messageText }],
      });
    if (
      !this.databasesReady ||
      !this.options.databases?.tools ||
      !this.state.project ||
      !this.state.projectDatabases?.authorized ||
      this.databaseConsentThread !== this.state.threadId ||
      !this.settings.threads[this.state.threadId!]?.sqlTool ||
      (p.namespace !== undefined && p.namespace !== null) ||
      !text(p.turnId)
    ) {
      reply(
        "stag_sql não autorizado nesta conversa. Cadastre a conexão e clique em Conexões > Autorizar bancos nesta conversa. Históricos sem stag_sql precisam de nova conversa. Não obtenha credenciais por JDBC/arquivos nem contorne o bloqueio por outra ferramenta.",
      );
      return;
    }
    const parsed = sqlArguments.safeParse(p.arguments);
    if (!parsed.success) {
      reply(
        "Argumentos SQL inválidos. Informe id/revisão, operação, SQL, parâmetros tipados, risco e intenção; nunca envie senha ou destino pela ferramenta.",
      );
      return;
    }
    const id = String(message.id);
    if (this.toolRequests.has(id)) return;
    this.toolRequests.add(id);
    if (!this.turnId) this.turnId = text(p.turnId);
    const args = parsed.data,
      sql = this.options.databases.tools;
    const project = this.state.project.path,
      mode = this.state.mode,
      epoch = this.toolEpoch;
    await this.executeTool(
      {
        message,
        tool: "sql",
        safety: () =>
          cyberSafetyReason([
            args.intent,
            args.sql,
            ...(args.parameters || []).map((parameter) => String(parameter.value ?? "")),
          ]),
        confirmation: async () => sql.confirmation(project, args, mode),
        approval: (reason) => sql.approval(project, args, mode, reason),
        execute: (approved) =>
          sql.execute(project, args, mode, approved, (rows, elapsedMs, failed) => {
            if (this.disposed || this.toolEpoch !== epoch || this.state.project?.path !== project)
              return;
            const metrics = this.state.projectDatabases!.metrics;
            metrics.requests++;
            metrics.elapsedMs += elapsedMs;
            metrics.lastRows = rows;
            if (failed) {
              metrics.failures++;
              this.state.metrics.failures++;
            }
            this.refreshDatabases();
          }),
      },
      null,
    );
    this.publish();
  }
  private async httpRequest(message: RpcMessage): Promise<void> {
    const p = message.params || {};
    const reply = (messageText: string) =>
      this.rpc!.respond(message.id!, {
        success: false,
        contentItems: [{ type: "inputText", text: messageText }],
      });
    if (
      !this.apisReady ||
      !this.state.project ||
      !this.state.projectApis?.authorized ||
      this.apiConsentThread !== this.state.threadId ||
      !this.settings.threads[this.state.threadId!]?.httpTool ||
      (p.namespace !== undefined && p.namespace !== null) ||
      !text(p.turnId)
    ) {
      reply(
        "stag_http não autorizado nesta conversa. Cadastre a conexão e clique em APIs > Autorizar APIs nesta conversa. Históricos sem stag_http precisam de uma nova conversa; não tente obter credenciais nem contornar o bloqueio por outra ferramenta.",
      );
      return;
    }
    const parsed = httpArguments.safeParse(p.arguments);
    if (!parsed.success) {
      reply(
        "Argumentos HTTP inválidos. Informe id/revisão, método, caminho relativo, risco e intenção; não envie credenciais.",
      );
      return;
    }
    const id = String(message.id);
    if (this.toolRequests.has(id)) return;
    this.toolRequests.add(id);
    if (!this.turnId) this.turnId = text(p.turnId);
    const args = parsed.data;
    const api = this.options.apis!;
    const project = this.state.project.path;
    const mode = this.state.mode;
    const epoch = this.toolEpoch;
    const work = this.executeTool(
      {
        message,
        tool: "http",
        safety: () => cyberSafetyReason([args.intent, args.path, args.body || ""]),
        confirmation: async () => api.confirmation(project, args, mode),
        approval: (reason) => api.approval(project, args, mode, reason),
        execute: (approved) =>
          api.execute(project, args, mode, approved, (status, elapsedMs, failed) => {
            if (this.disposed || this.toolEpoch !== epoch || this.state.project?.path !== project)
              return;
            const metrics = this.state.projectApis!.metrics;
            metrics.requests++;
            metrics.elapsedMs += elapsedMs;
            metrics.lastStatus = status;
            if (failed) {
              metrics.failures++;
              this.state.metrics.failures++;
            }
            this.refreshApis();
          }),
      },
      null,
    );
    this.httpWork = work;
    await work;
    this.publish();
  }
  private async answer(action: Extract<Action, { type: "answer" }>): Promise<void> {
    const waiting = this.pending.get(action.id);
    if (!waiting || waiting.message.id === undefined || !this.rpc)
      throw new Error("Esse pedido já foi resolvido.");
    const approval = this.state.approvals.find((a) => a.id === action.id);
    if (approval?.kind !== "questions" && action.accept !== true && this.analysis?.working) {
      this.analysis.detach();
      this.state.queuePaused = true;
    }
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
    this.databaseAbort?.abort();
    this.disableMouseMovement();
    this.disposed = true;
    this.analysis?.dispose();
    this.rejectAnalysisTurn();
    this.clearMessageQueue();
    this.clearVideo();
    this.projectPreparation.abort();
    this.branchController?.abort();
    this.toolEpoch++;
    this.options.desktop.cancel?.();
    this.options.apis?.cancel();
    this.options.databases?.tools?.cancel();
    this.options.browser?.cancel();
    this.rpc?.removeAllListeners();
    this.rpc?.close();
    this.pending.clear();
  }
  async mediaSettled(): Promise<void> {
    await this.toolQueue;
    if (this.options.databases) await this.options.databases.connections.settled();
    await this.options.apis?.connections.settled();
    await this.videoWork;
    await this.analysis?.settled();
  }
}

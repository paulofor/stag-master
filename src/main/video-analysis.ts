import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { videoSegmentSeconds, type VideoAnalysisSummary } from "../shared/request-video";
import type { AccessMode } from "../shared/types";
import {
  videoSourceSchema,
  type BackgroundVideoProcessor,
  type PreparedVideo,
} from "./request-video";

const jobSchema = z
  .object({
    id: z.uuid(),
    projectPath: z.string().min(1).max(32768),
    threadId: z.string().min(1).max(200),
    mode: z.enum(["read", "project", "windows"]),
    accountKey: z.string().regex(/^[a-f0-9]{64}$/),
    source: videoSourceSchema,
    next: z.number().int().min(0).max(144),
    status: z.enum(["running", "paused", "failed", "uncertain", "completed", "cancelled"]),
    pending: z
      .object({ index: z.number().int().min(0).max(143), turnId: z.string().max(200).optional() })
      .nullable(),
  })
  .strict()
  .refine(
    (job) =>
      job.next <= Math.ceil(job.source.seconds / videoSegmentSeconds) &&
      (job.status !== "completed" ||
        job.next === Math.ceil(job.source.seconds / videoSegmentSeconds)) &&
      (!job.pending ||
        (job.pending.index === job.next &&
          job.next < Math.ceil(job.source.seconds / videoSegmentSeconds))),
  );
export type VideoAnalysisJob = z.infer<typeof jobSchema>;
const jobsSchema = z
  .array(jobSchema)
  .max(100)
  .refine(
    (jobs) =>
      new Set(jobs.map((job) => JSON.stringify([job.projectPath, job.accountKey]))).size ===
      jobs.length,
  );

// Main-only checkpoint: no media, transcript, prompts, credentials or persisted consent.
export class VideoAnalysisStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load(): Promise<VideoAnalysisJob[]> {
    try {
      const info = await lstat(this.file);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error();
      const bytes = await readFile(this.file);
      return jobsSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(
        "Não foi possível ler o progresso dos vídeos. Confira o armazenamento do STAG; nenhum vídeo será retomado automaticamente.",
      );
    }
  }
  save(jobs: VideoAnalysisJob[]): Promise<void> {
    let content: string;
    try {
      content = JSON.stringify(jobsSchema.parse(jobs));
    } catch {
      return Promise.reject(new Error("Não foi possível salvar o progresso do vídeo."));
    }
    const write = this.writes.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
        await writeFile(`${this.file}.tmp`, content, { mode: 0o600 });
        await rename(`${this.file}.tmp`, this.file);
      } catch {
        throw new Error(
          "Não foi possível salvar o progresso do vídeo. Confira o armazenamento do STAG antes de retomar.",
        );
      }
    });
    this.writes = write.catch(() => {});
    return write;
  }
  async settled(): Promise<void> {
    await this.writes;
  }
}
export interface AnalysisContext {
  projectPath: string | null;
  threadId: string | null;
  mode: AccessMode;
  accountKey: string | null;
}
export interface AnalysisTurn {
  id: string;
  status: string;
}
interface Hooks {
  context(): AnalysisContext;
  changed(): void;
  ready(job: VideoAnalysisJob): Promise<void>;
  submit(job: VideoAnalysisJob, video: PreparedVideo): Promise<AnalysisTurn>;
  recover(job: VideoAnalysisJob): Promise<AnalysisTurn | null>;
  waitTurn(job: VideoAnalysisJob, turn: AnalysisTurn): Promise<AnalysisTurn>;
  interrupt(job: VideoAnalysisJob): Promise<void>;
  failure(message: string): void;
}
export class VideoAnalysisManager {
  private jobs: VideoAnalysisJob[] = [];
  private active: VideoAnalysisJob | null = null;
  private controller: AbortController | null = null;
  private work: Promise<void> = Promise.resolve();
  private phase = "";
  private stage: VideoAnalysisSummary["stage"] = "idle";
  private phaseStartedAt: number | null = null;
  private errors = new Map<string, string>();
  private disposed = false;
  private initialized = false;
  constructor(
    private store: VideoAnalysisStore,
    private processor: BackgroundVideoProcessor,
    private hooks: Hooks,
  ) {}
  async init(): Promise<void> {
    this.jobs = await this.store.load();
    this.initialized = true;
    // Startup reads checkpoints but grants no authority to resume a job or a consent.
    for (const job of this.jobs) if (job.status === "running") job.status = "paused";
  }
  get working(): boolean {
    return !!this.active;
  }
  get running(): boolean {
    return this.active?.status === "running";
  }
  summary(): VideoAnalysisSummary | null {
    const context = this.hooks.context();
    const job = this.jobs.find(
      (job) =>
        job.projectPath === context.projectPath &&
        job.accountKey === context.accountKey &&
        (!context.threadId || job.threadId === context.threadId),
    );
    if (!job) return null;
    return {
      id: job.id,
      name: job.source.name,
      threadId: job.threadId,
      mode: job.mode,
      seconds: job.source.seconds,
      completed: job.next,
      total: Math.ceil(job.source.seconds / videoSegmentSeconds),
      status: job.status,
      working: this.active === job,
      stage: this.active === job ? this.stage : "idle",
      phaseStartedAt: this.active === job ? this.phaseStartedAt : null,
      phase:
        this.active === job
          ? this.phase
          : job.status === "completed"
            ? "Análise concluída. Confira as respostas e as anotações verificadas pelo assistente."
            : job.status === "cancelled"
              ? "Análise cancelada. As anotações já verificadas são preservadas."
              : job.status === "uncertain"
                ? "Envio não confirmado. Confira o histórico antes de retomar ou reprocessar este trecho."
                : job.status === "failed"
                  ? "Análise interrompida por falha. Confira o erro antes de retomar."
                  : "Análise pausada. Use Retomar análise com o arquivo original disponível.",
      error: this.errors.get(job.id) || null,
    };
  }
  private setPhase(stage: VideoAnalysisSummary["stage"], phase: string): void {
    if (this.stage !== stage || this.phase !== phase) this.phaseStartedAt = Date.now();
    this.stage = stage;
    this.phase = phase;
    this.hooks.changed();
  }
  private owns(job: VideoAnalysisJob): boolean {
    const context = this.hooks.context();
    return (
      !this.disposed &&
      context.projectPath === job.projectPath &&
      context.threadId === job.threadId &&
      context.mode === job.mode &&
      context.accountKey === job.accountKey
    );
  }
  private async save(): Promise<void> {
    await this.store.save(this.jobs);
  }
  async start(job: VideoAnalysisJob): Promise<void> {
    if (!this.initialized)
      throw new Error(
        "Não foi possível ler o progresso salvo. Corrija o armazenamento e reabra o STAG antes de iniciar uma análise.",
      );
    if (this.active) throw new Error("Pause ou cancele a análise de vídeo atual.");
    const previous = this.jobs.find(
      (entry) => entry.projectPath === job.projectPath && entry.accountKey === job.accountKey,
    );
    if (previous && !["completed", "cancelled"].includes(previous.status))
      throw new Error(
        "Retome ou cancele a análise salva deste projeto antes de selecionar outro vídeo.",
      );
    const before = this.jobs;
    this.jobs = [
      ...this.jobs.filter(
        (entry) => entry.projectPath !== job.projectPath || entry.accountKey !== job.accountKey,
      ),
      job,
    ];
    try {
      await this.save();
    } catch (error) {
      this.jobs = before;
      throw error;
    }
    this.launch(job, false);
  }
  async control(id: string, action: "pause" | "resume" | "cancel" | "retry"): Promise<void> {
    const job = this.jobs.find((entry) => entry.id === id);
    if (!job || !this.owns(job))
      throw new Error("Análise indisponível nesta conversa, projeto, conta ou modo de acesso.");
    if (action === "pause") {
      this.detach();
      await this.store.settled();
      return;
    }
    if (action === "cancel") {
      if (job.status === "cancelled") {
        await this.work;
        return;
      }
      job.status = "cancelled";
      this.controller?.abort();
      this.setPhase("stopping", "Cancelando e limpando o trecho atual…");
      await this.save();
      this.hooks.changed();
      if (this.active === job || job.pending) await this.hooks.interrupt(job);
      await this.work;
      this.hooks.changed();
      return;
    }
    if (this.active)
      throw new Error("Aguarde a conclusão ou a limpeza do trecho atual antes de retomar.");
    if (["completed", "cancelled"].includes(job.status))
      throw new Error("Esta análise já foi concluída ou cancelada. Selecione um novo vídeo.");
    this.errors.delete(job.id);
    this.launch(job, action === "retry");
  }
  detach(): void {
    const job = this.active;
    if (!job || job.status === "cancelled") return;
    job.status = "paused";
    this.controller?.abort();
    this.setPhase(
      "stopping",
      job.pending
        ? "Pausa solicitada; concluindo o trecho atual…"
        : "Pausando e limpando o trecho atual…",
    );
    void this.save().catch((error) => {
      this.errors.set(job.id, (error as Error).message);
      this.hooks.failure((error as Error).message);
    });
    this.hooks.changed();
  }
  private launch(job: VideoAnalysisJob, retry: boolean): void {
    this.active = job;
    job.status = "running";
    this.setPhase("checking", "Conferindo o arquivo original e o progresso salvo…");
    this.work = this.work.then(() => this.run(job, retry)).catch(() => {});
  }
  private async advance(job: VideoAnalysisJob, turn: AnalysisTurn): Promise<void> {
    if (!job.pending || turn.status !== "completed") return;
    const previous = { next: job.next, pending: job.pending, status: job.status };
    job.next++;
    job.pending = null;
    if (
      job.next === Math.ceil(job.source.seconds / videoSegmentSeconds) &&
      job.status !== "cancelled"
    )
      job.status = "completed";
    try {
      await this.save();
    } catch (error) {
      Object.assign(job, previous);
      throw error;
    }
    this.hooks.changed();
  }
  private async finish(job: VideoAnalysisJob, turn: AnalysisTurn): Promise<boolean> {
    if (turn.status === "completed") {
      await this.advance(job, turn);
      return true;
    }
    if (job.pending) job.pending.turnId = turn.id;
    if (job.status !== "cancelled") job.status = turn.status === "failed" ? "failed" : "paused";
    this.setPhase("stopping", "O trecho não foi concluído. Confira a conversa antes de retomar.");
    await this.save();
    this.hooks.changed();
    return false;
  }
  private async run(job: VideoAnalysisJob, retry: boolean): Promise<void> {
    try {
      this.controller = new AbortController();
      await this.processor.validate(job.source, this.controller.signal);
      if (!this.owns(job) || job.status !== "running") return;
      if (job.pending) {
        this.setPhase("recovering", "Conferindo o trecho enviado no histórico…");
        const previous = await this.hooks.recover(job);
        if (previous?.status === "inProgress") {
          this.setPhase(
            "recovering",
            "Aguardando o trecho em andamento no histórico. Use Parar execução se ele não avançar.",
          );
          if (!(await this.finish(job, await this.hooks.waitTurn(job, previous)))) return;
        } else if (previous?.status === "completed") await this.advance(job, previous);
        else if (previous || retry) {
          job.pending = null;
          await this.save();
        } else {
          job.status = "uncertain";
          this.phase =
            "Envio não confirmado. Confira o histórico antes de reprocessar este trecho.";
          this.errors.set(job.id, this.phase);
          await this.save();
          return;
        }
      }
      while (
        this.owns(job) &&
        job.status === "running" &&
        job.next < Math.ceil(job.source.seconds / videoSegmentSeconds)
      ) {
        this.controller = new AbortController();
        this.setPhase("preparing", `Preparando trecho ${job.next + 1}…`);
        const prepared = await this.processor.prepare(
          job.source,
          job.next,
          job.id,
          this.controller.signal,
          (phase) => {
            if (this.owns(job) && job.status === "running") {
              this.setPhase("preparing", phase);
            }
          },
        );
        if (!this.owns(job) || job.status !== "running") return;
        this.setPhase("waiting", "Trecho preparado. Aguardando a fila de ferramentas…");
        await this.hooks.ready(job);
        if (!this.owns(job) || job.status !== "running") return;
        job.pending = { index: job.next };
        await this.save(); // Before dispatch, including a lost turn/start response or a crash.
        this.setPhase(
          "analyzing",
          `Assistente analisando trecho ${job.next + 1} de ${Math.ceil(job.source.seconds / videoSegmentSeconds)}…`,
        );
        if (!this.owns(job) || job.status !== "running") {
          job.pending = null;
          await this.save();
          return;
        }
        if (!(await this.finish(job, await this.hooks.submit(job, prepared)))) return;
      }
    } catch (error) {
      if (
        (job.status === "cancelled" || job.status === "paused") &&
        error instanceof Error &&
        error.message.startsWith("Não foi possível limpar os arquivos temporários do vídeo.")
      ) {
        this.errors.set(
          job.id,
          "Não foi possível limpar os arquivos temporários do vídeo. Feche o STAG e confira o armazenamento temporário.",
        );
        this.hooks.failure(this.errors.get(job.id)!);
      }
      if (job.status !== "cancelled" && job.status !== "paused") {
        job.status = job.pending ? "uncertain" : "failed";
        // Only fixed operational messages from the media/checkpoint code may reach the panel.
        const message =
          error instanceof Error &&
          /^(O arquivo|Selecione|Vídeo inválido|As imagens extraídas|Transcrição|Não foi possível (preparar|salvar|decodificar|limpar)|Preparação de vídeo)/.test(
            error.message,
          )
            ? error.message
            : "A análise foi pausada. Confira a conexão e o histórico antes de retomar.";
        this.errors.set(job.id, message);
        this.hooks.failure(message);
      }
      await this.save().catch((error) => this.hooks.failure((error as Error).message));
    } finally {
      if (job.status === "running") job.status = "paused";
      this.controller = null;
      if (this.active === job) this.active = null;
      this.stage = "idle";
      this.phaseStartedAt = null;
      this.hooks.changed();
    }
  }
  dispose(): void {
    this.detach();
    this.disposed = true;
    this.controller?.abort();
  }
  async settled(): Promise<void> {
    await this.work;
    await this.store.settled();
  }
}

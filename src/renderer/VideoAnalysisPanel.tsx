import { useEffect, useState } from "react";
import { CircleCheck, CirclePause, CircleAlert, LoaderCircle } from "lucide-react";
import type { Action, Snapshot } from "../shared/types";
import { videoSegmentSeconds, videoTime } from "../shared/request-video";

export function VideoAnalysisPanel({
  state,
  pending,
  run,
}: {
  state: Snapshot;
  pending: boolean;
  run(action: Action): Promise<boolean>;
}) {
  const job = state.videoAnalysis;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!job?.working) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job?.id, job?.working, job?.phaseStartedAt]);
  if (!job) return null;
  const ended = !job.working && (job.status === "completed" || job.status === "cancelled");
  const decision = job.working && state.threadId === job.threadId && state.approvals.length > 0;
  const question = decision && state.approvals.some((approval) => approval.kind === "questions");
  const waiting =
    decision || (job.working && state.connection !== "ready") || job.stage === "waiting";
  const processing = job.working && job.status === "running" && !waiting;
  const status = waiting
    ? "waiting"
    : job.working && job.status !== "running"
      ? "stopping"
      : job.status;
  const label = decision
    ? question
      ? "Aguardando sua resposta"
      : "Aguardando autorização"
    : job.working && state.connection !== "ready"
      ? "Aguardando conexão"
      : job.stage === "waiting"
        ? "Aguardando a fila de ferramentas"
        : job.working && job.status === "paused"
          ? "Pausando análise"
          : job.working && job.status === "cancelled"
            ? "Cancelando análise"
            : {
                running: "Vídeo em processamento",
                paused: "Análise pausada",
                failed: "Falha na análise",
                uncertain: "Envio não confirmado",
                completed: "Análise concluída",
                cancelled: "Análise cancelada",
              }[job.status];
  const phase = decision
    ? question
      ? "Responda à pergunta na conversa para continuar o trecho."
      : "Confira a aprovação na conversa para continuar o trecho."
    : job.phase;
  const percent = Math.floor((job.completed * 100) / job.total);
  const resumeBlocker =
    state.connection !== "ready" || !state.account
      ? "Entre com sua conta e conecte o STAG Plus para retomar."
      : job.mode === "windows" && state.mode !== "windows"
        ? "Autorize o desktop no modo Windows para retomar a conversa original."
        : state.busy && !job.working
          ? "Conclua ou pare a execução da conversa antes de retomar."
          : null;
  const Icon = processing
    ? LoaderCircle
    : waiting || job.status === "failed" || job.status === "uncertain"
      ? CircleAlert
      : ended
        ? CircleCheck
        : CirclePause;
  const control = (action: "pause" | "resume" | "cancel" | "retry") =>
    void run({ type: "videoAnalysis", id: job.id, control: action });
  return (
    <section
      className="video-analysis"
      data-state={status}
      aria-label="Análise de vídeo em segundo plano"
    >
      <div className="video-analysis-state" role="status">
        <Icon
          size={17}
          aria-hidden="true"
          className={processing ? "video-analysis-spinner" : undefined}
        />
        <strong>{label}</strong>
      </div>
      <strong className="video-analysis-name">{job.name}</strong>
      <div className="video-analysis-progress">
        <span>
          {job.completed} de {job.total} trechos concluídos · {videoTime(job.seconds)}
        </span>
        <strong>{percent}%</strong>
      </div>
      <progress
        aria-label="Progresso da análise de vídeo"
        value={job.completed}
        max={job.total}
        aria-valuetext={`${percent}% · ${job.completed} de ${job.total} trechos concluídos`}
      />
      {!ended && job.completed < job.total && (
        <span>
          {job.working ? "Trecho atual" : "Próximo trecho"} {job.completed + 1} de {job.total} ·{" "}
          {videoTime(job.completed * videoSegmentSeconds)}–
          {videoTime(Math.min(job.seconds, (job.completed + 1) * videoSegmentSeconds))}
        </span>
      )}
      <span role="status">{phase}</span>
      {job.working && !decision && job.phaseStartedAt !== null && (
        <span className="video-analysis-time">
          Nesta etapa há {videoTime(Math.max(0, (now - job.phaseStartedAt) / 1000))}. O progresso
          avança ao concluir o trecho.
        </span>
      )}
      {!ended && !job.working && resumeBlocker && (
        <span className="video-analysis-blocker">{resumeBlocker}</span>
      )}
      {job.error && <span role="alert">{job.error}</span>}
      {job.mode === "read" && <span>Modo Leitura: análise sem salvar anotações.</span>}
      {!ended && (
        <div className="video-analysis-actions">
          {job.status === "running" ? (
            <button className="text-button" disabled={pending} onClick={() => control("pause")}>
              Pausar análise
            </button>
          ) : (
            <button
              className="text-button"
              disabled={pending || job.working || !!resumeBlocker}
              onClick={() => control("resume")}
            >
              Retomar análise
            </button>
          )}
          {job.status === "uncertain" && (
            <button
              className="text-button"
              disabled={pending || job.working || !!resumeBlocker}
              onClick={() => control("retry")}
            >
              Reprocessar trecho
            </button>
          )}
          <button
            className="text-button"
            disabled={pending || job.status === "cancelled"}
            onClick={() => control("cancel")}
          >
            Cancelar análise
          </button>
        </div>
      )}
      <details>
        <summary>Sobre a análise e as anotações</summary>
        <p>
          {job.mode === "read"
            ? "O assistente analisa sem salvar anotações."
            : "Confira nas respostas quais anotações foram gravadas e verificadas em .stag."}{" "}
          Arquivo lido do disco por trechos. Continua minimizado. Ao fechar, retome aqui com o
          arquivo original disponível. Amostragem e transcrição podem conter erros.
        </p>
      </details>
    </section>
  );
}

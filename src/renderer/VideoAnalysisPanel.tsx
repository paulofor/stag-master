import type { Action, Snapshot } from "../shared/types";
import { videoTime } from "../shared/request-video";

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
  if (!job) return null;
  const ended = job.status === "completed" || job.status === "cancelled";
  const control = (action: "pause" | "resume" | "cancel" | "retry") =>
    void run({ type: "videoAnalysis", id: job.id, control: action });
  return (
    <section className="video-analysis" aria-label="Análise de vídeo em segundo plano">
      <strong>{job.name}</strong>
      <span>
        {job.completed} de {job.total} trechos concluídos · {videoTime(job.seconds)}
      </span>
      <progress aria-label="Progresso da análise de vídeo" value={job.completed} max={job.total} />
      <span role="status">{job.phase}</span>
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
              disabled={pending || job.working || state.connection !== "ready"}
              onClick={() => control("resume")}
            >
              Retomar análise
            </button>
          )}
          {job.status === "uncertain" && (
            <button
              className="text-button"
              disabled={pending || state.busy}
              onClick={() => control("retry")}
            >
              Reprocessar trecho
            </button>
          )}
          <button className="text-button" disabled={pending} onClick={() => control("cancel")}>
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
          Continua minimizado. Ao fechar, retome aqui com o arquivo original disponível. Amostragem
          e transcrição podem conter erros.
        </p>
      </details>
    </section>
  );
}

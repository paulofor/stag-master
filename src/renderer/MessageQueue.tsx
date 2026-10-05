import { Pause, Play, X } from "lucide-react";
import type { Action, Snapshot } from "../shared/types";

export function MessageQueue({
  state,
  pending,
  run,
}: {
  state: Snapshot;
  pending: boolean;
  run: (action: Action) => Promise<boolean>;
}) {
  if (!state.queuedMessages.length || !state.threadId) return null;
  const threadId = state.threadId;
  const uncertain = state.queuedMessages.some((message) => message.status === "uncertain");
  return (
    <section className="message-queue" aria-label="Fila de solicitações">
      <div className="queue-heading">
        <strong role="status">
          Fila · {state.queuedMessages.length}
          {state.queuePaused ? " · pausada" : ""}
        </strong>
        <button
          className="text-button"
          disabled={pending || (state.queuePaused && (state.connection !== "ready" || uncertain))}
          onClick={() => void run({ type: "pauseQueue", threadId, paused: !state.queuePaused })}
        >
          {state.queuePaused ? <Play size={12} /> : <Pause size={12} />}
          {state.queuePaused ? "Continuar fila" : "Pausar fila"}
        </button>
      </div>
      <p className="queue-hint">
        {uncertain
          ? "Envio não confirmado. Confira o histórico e remova esse item antes de continuar."
          : state.queuePaused
            ? "Os textos aguardam você continuar a fila."
            : "Um texto por vez, após a tarefa atual. Só nesta conversa, enquanto o STAG estiver aberto."}
      </p>
      <ol>
        {state.queuedMessages.map((message, index) => (
          <li key={message.id}>
            <span className="queue-position">{index + 1}.</span>
            <details>
              <summary>
                {message.text.slice(0, 120)}
                {message.text.length > 120 ? "…" : ""}
              </summary>
              <p>{message.text}</p>
              {message.status !== "pending" && (
                <small>{message.status === "sending" ? "Enviando…" : "Envio não confirmado"}</small>
              )}
            </details>
            <button
              className="icon-button"
              aria-label={`Remover texto ${index + 1} da fila`}
              disabled={pending || message.status === "sending"}
              onClick={() => void run({ type: "removeQueued", threadId, id: message.id })}
            >
              <X size={14} />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

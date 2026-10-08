import { useEffect, useState } from "react";
import { MousePointer2 } from "lucide-react";
import type { Action, Snapshot } from "../shared/types";

export function MouseMovementPanel({
  state,
  pending,
  run,
}: {
  state: Snapshot;
  pending: boolean;
  run: (action: Action) => Promise<unknown>;
}) {
  const { enabled, status, nextAttemptAt, moves, skipped } = state.mouseMovement;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled || nextAttemptAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, nextAttemptAt]);
  if (state.platform !== "win32") return null;
  const prerequisite =
    state.connection !== "ready"
      ? "Conecte o Codex para ativar"
      : !state.account
        ? "Entre com ChatGPT para ativar"
        : !state.project
          ? "Selecione um projeto para ativar"
          : state.mode !== "windows"
            ? "Autorize o desktop para ativar"
            : !state.threadId
              ? "Envie uma mensagem para iniciar a conversa Windows"
              : null;
  const seconds = Math.max(0, Math.ceil(((nextAttemptAt ?? now) - now) / 1000));
  const countdown = `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
  return (
    <section className="mouse-movement" aria-label="Movimento periódico do mouse">
      <button
        className="text-button"
        aria-pressed={enabled}
        aria-describedby="mouse-movement-status"
        disabled={pending || (!enabled && !!prerequisite)}
        title="Move até 2 pixels e retorna com o cursor sobre STAG (inclusive navegador integrado), Postman, IntelliJ, VS Code ou DBeaver em primeiro plano, sem clicar."
        onClick={() =>
          state.threadId &&
          void run({ type: "mouseMovement", threadId: state.threadId, enabled: !enabled })
        }
      >
        <MousePointer2 size={14} />
        {enabled ? "Desligar movimento do mouse" : "Mover mouse a cada 5 min"}
      </button>
      {enabled && nextAttemptAt !== null && (
        <span className="mouse-movement-timer" role="timer" aria-live="off">
          {seconds > 0 ? `Próxima tentativa em ${countdown}` : "Aguardando tentativa"}
        </span>
      )}
      <span id="mouse-movement-status" role="status">
        {!enabled && prerequisite ? prerequisite : status}
        {enabled && (
          <span className="mouse-movement-counts">
            {` · ${moves} movimento(s) · ${skipped} intervalo(s) omitido(s)`}
          </span>
        )}
      </span>
    </section>
  );
}

import { useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import { author, version } from "../../package.json";

export function AboutDialog({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="modal about-dialog"
      aria-labelledby="about-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          event.preventDefault();
          event.currentTarget.querySelector("button")?.focus();
        }
      }}
    >
      <Sparkles className="modal-icon" size={24} />
      <h2 id="about-title">Sobre o STAG</h2>
      <p>Versão {version}</p>
      <p>
        Desenvolvido por: <strong>{author}</strong>
      </p>
      <p>Assistente para arquitetura, programação e regras de negócio, integrado ao Codex.</p>
      <div className="approval-actions">
        <button className="primary-button" autoFocus onClick={close}>
          Fechar
        </button>
      </div>
    </dialog>
  );
}

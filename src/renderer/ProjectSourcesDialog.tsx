import { useEffect, useRef, useState } from "react";
import { BookOpen, Plus, Trash2, X } from "lucide-react";
import {
  maxProjectSources,
  maxSourceUrlLength,
  projectSourcesSchema,
} from "../shared/project-sources";
import type { DocumentationSource } from "../shared/types";

export function ProjectSourcesDialog({
  projectName,
  sources,
  pending,
  error,
  save,
  close,
}: {
  projectName: string;
  sources: DocumentationSource[];
  pending: boolean;
  error: string | null;
  save: (sources: DocumentationSource[]) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(() => structuredClone(sources));
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  function change(index: number, field: keyof DocumentationSource, value: string) {
    setValidation(null);
    setDraft(draft.map((source, i) => (i === index ? { ...source, [field]: value } : source)));
  }
  async function submit() {
    if (pending) return;
    const result = projectSourcesSchema.safeParse(draft);
    if (!result.success) {
      const issue = result.error.issues[0];
      setValidation(
        `${typeof issue.path[0] === "number" ? `Fonte ${issue.path[0] + 1}: ` : ""}${issue.message}`,
      );
      return;
    }
    setValidation(null);
    if (await save(result.data)) close();
  }
  return (
    <dialog
      ref={dialog}
      className="modal sources-dialog"
      aria-labelledby="sources-title"
      aria-describedby="sources-description"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled)",
          ),
        );
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
    >
      <div className="sources-heading">
        <BookOpen size={22} />
        <h2 id="sources-title">Fontes do projeto</h2>
        <button
          className="icon-button"
          aria-label="Fechar fontes"
          disabled={pending}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <p id="sources-description">
        Documentação de referência para <strong>{projectName}</strong>. O modelo recebe estas fontes
        em todas as conversas do projeto e deve consultá-las quando a tarefa depender delas.
      </p>
      <p className="sources-hint">
        A consulta usa o navegador integrado e sua autorização. Não inclua senhas ou tokens nas
        URLs. As alterações serão usadas na próxima solicitação.
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="sources-list">
          {!draft.length && (
            <p className="sources-empty">Nenhuma fonte cadastrada para este projeto.</p>
          )}
          {draft.map((source, index) => (
            <fieldset className="source-entry" key={index} disabled={pending}>
              <legend>Fonte {index + 1}</legend>
              <label>
                Nome
                <input
                  aria-label={`Nome da fonte ${index + 1}`}
                  value={source.name}
                  maxLength={120}
                  placeholder="Ex.: Arquitetura do sistema"
                  onChange={(event) => change(index, "name", event.target.value)}
                />
              </label>
              <label>
                URL da documentação
                <input
                  type="url"
                  aria-label={`URL da fonte ${index + 1}`}
                  value={source.url}
                  maxLength={maxSourceUrlLength}
                  placeholder="https://docs.exemplo.com/projeto"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => change(index, "url", event.target.value)}
                />
              </label>
              <button
                className="text-button source-remove"
                type="button"
                aria-label={`Remover fonte ${index + 1}`}
                onClick={() => {
                  setValidation(null);
                  setDraft(draft.filter((_, i) => i !== index));
                }}
              >
                <Trash2 size={13} /> Remover
              </button>
            </fieldset>
          ))}
        </div>
        <div className="sources-add">
          <button
            className="secondary-button"
            type="button"
            disabled={pending || draft.length >= maxProjectSources}
            onClick={() => {
              setValidation(null);
              setDraft([...draft, { name: "", url: "" }]);
            }}
          >
            <Plus size={14} /> Adicionar fonte
          </button>
          <span>
            {draft.length}/{maxProjectSources} fontes
          </span>
        </div>
        {(validation || error) && (
          <p className="sources-error" role="alert">
            {validation || error}
          </p>
        )}
        <div className="approval-actions">
          <button className="secondary-button" type="button" disabled={pending} onClick={close}>
            Cancelar
          </button>
          <button className="primary-button" type="submit" disabled={pending}>
            {pending ? "Salvando…" : "Salvar fontes"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

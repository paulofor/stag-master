import { useEffect, useRef, useState } from "react";
import { GitBranch, Plus, RefreshCw, X } from "lucide-react";
import {
  branchOperationSchema,
  type BranchOperation,
  type ProjectBranches,
} from "../shared/project-branches";

export function ProjectBranchesDialog({
  projectName,
  data,
  pending,
  readOnly,
  error,
  refresh,
  change,
  close,
}: {
  projectName: string;
  data: ProjectBranches | null;
  pending: boolean;
  readOnly: boolean;
  error: string | null;
  refresh: () => Promise<boolean>;
  change: (repositoryId: string, operation: BranchOperation) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [form, setForm] = useState<BranchOperation | null>(null);
  const [formOwner, setFormOwner] = useState("");
  const [validation, setValidation] = useState<string | null>(null);
  const repository =
    data?.repositories.find((repo) => repo.id === selected) || data?.repositories[0];
  const blocked = pending || readOnly || !!repository?.error;
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  function edit(next: BranchOperation) {
    setFormOwner(repository?.id || "");
    setForm(next);
    setValidation(null);
  }
  async function submit() {
    if (!repository || blocked || !form || formOwner !== repository.id) return;
    const result = branchOperationSchema.safeParse(form);
    if (!result.success) {
      setValidation(result.error.issues[0].message);
      return;
    }
    setValidation(null);
    if (await change(repository.id, result.data)) setForm(null);
  }
  return (
    <dialog
      ref={dialog}
      className="modal sources-dialog branches-dialog"
      aria-labelledby="branches-title"
      aria-describedby="branches-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) close();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
    >
      <div className="sources-heading">
        <GitBranch size={22} />
        <h2 id="branches-title">Branches dos projetos</h2>
        <button
          className="icon-button"
          aria-label="Fechar branches"
          disabled={pending}
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      <p id="branches-description">
        Gerencie as branches de cada projeto em <strong>{projectName}</strong>. O assistente edita
        os arquivos na branch em uso; descreva a alteração na conversa.
      </p>
      <div className="branches-toolbar">
        <span>{data ? `${data.repositories.length} projeto(s) Git` : "Consultando projetos…"}</span>
        <button className="secondary-button" disabled={pending} onClick={() => void refresh()}>
          <RefreshCw size={13} /> {pending ? "Aguarde…" : "Atualizar lista"}
        </button>
      </div>
      {readOnly && (
        <p className="branches-notice">
          Modo Leitura: consulta disponível. Selecione Projeto no acesso da conversa para alterar
          branches.
        </p>
      )}
      {data?.incomplete && (
        <p className="branches-notice" role="status">
          A busca atingiu um limite. A lista é parcial; selecione uma pasta menor para consultar os
          projetos restantes.
        </p>
      )}
      {!!data?.issues.length && (
        <details>
          <summary>Pastas não consultadas ({data.issues.length})</summary>
          {data.issues.map((issue, i) => (
            <p key={i}>
              {issue.path}: {issue.message}
            </p>
          ))}
        </details>
      )}
      {data && !data.repositories.length && (
        <p>Nenhum repositório Git encontrado nesta pasta ou nas subpastas.</p>
      )}
      {repository && (
        <>
          <label className="branches-field">
            Projeto
            <select
              aria-label="Projeto das branches"
              value={repository.id}
              disabled={pending}
              onChange={(event) => {
                setSelected(event.target.value);
                setForm(null);
                setValidation(null);
                setFilter("");
              }}
            >
              {data!.repositories.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.path === "." ? repo.name : repo.path} ·{" "}
                  {repo.error ? "indisponível" : repo.current || "HEAD destacado"}
                </option>
              ))}
            </select>
          </label>
          <div className="branches-summary">
            <strong>{repository.path === "." ? repository.name : repository.path}</strong>
            <span>
              Em uso: <b>{repository.current || "HEAD destacado"}</b>
            </span>
            <span>
              {repository.unborn
                ? "Sem commits: faça o primeiro commit para criar outras branches."
                : repository.error
                  ? "Consulta indisponível"
                  : repository.dirty
                    ? "Alterações locais pendentes"
                    : "Sem alterações locais"}
            </span>
          </div>
          {repository.error && (
            <p className="sources-error" role="alert">
              {repository.error}
            </p>
          )}
          <div className="branches-toolbar">
            <input
              aria-label="Filtrar branches"
              placeholder="Buscar branch…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <button
              className="secondary-button"
              disabled={blocked || !repository.branches.length}
              onClick={() =>
                edit({
                  kind: "create",
                  name: "",
                  from:
                    repository.branches.find((branch) => branch.current)?.ref ||
                    repository.branches[0].ref,
                })
              }
            >
              <Plus size={14} /> Nova branch
            </button>
          </div>
          {form && formOwner === repository.id && (
            <form
              className="branch-form"
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h3>
                {form.kind === "create"
                  ? "Criar branch local"
                  : form.kind === "rename"
                    ? `Renomear ${form.branch}`
                    : `Trocar para ${form.branch}`}
              </h3>
              {form.kind === "create" && (
                <label className="branches-field">
                  A partir de
                  <select
                    aria-label="Branch de origem"
                    disabled={blocked}
                    value={form.from}
                    onChange={(event) => edit({ ...form, from: event.target.value })}
                  >
                    {repository.branches.map((branch) => (
                      <option key={branch.ref} value={branch.ref}>
                        {branch.name}
                        {branch.kind === "remote" ? " (remota já disponível)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {"name" in form && (
                <label className="branches-field">
                  {form.kind === "rename" ? "Novo nome" : "Nome da branch"}
                  <input
                    aria-label="Nome da branch"
                    value={form.name}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="feature/minha-alteracao"
                    disabled={blocked}
                    onChange={(event) => edit({ ...form, name: event.target.value })}
                  />
                </label>
              )}
              {form.kind === "switch" && (
                <p>
                  Os arquivos deste projeto passarão a refletir esta branch. Alterações pendentes
                  precisam ser salvas em commit ou guardadas no seu cliente Git antes da troca.
                </p>
              )}
              <div className="approval-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={pending}
                  onClick={() => {
                    setForm(null);
                    setValidation(null);
                  }}
                >
                  Cancelar edição
                </button>
                <button type="submit" className="primary-button" disabled={blocked}>
                  {form.kind === "create"
                    ? "Criar branch"
                    : form.kind === "rename"
                      ? "Salvar nome"
                      : "Trocar branch"}
                </button>
              </div>
            </form>
          )}
          <div className="branches-list" aria-label="Branches disponíveis">
            {repository.branches
              .filter((branch) =>
                branch.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
              )
              .map((branch) => (
                <article
                  className={`branch-entry ${branch.current ? "branch-current" : ""}`}
                  key={branch.ref}
                  aria-label={`Branch ${branch.name}`}
                >
                  <div>
                    <strong>{branch.name}</strong>
                    <span>
                      {branch.current
                        ? "Em uso"
                        : branch.occupied
                          ? "Em outra pasta de trabalho"
                          : branch.kind === "remote"
                            ? "Remota · referência local"
                            : "Local"}
                    </span>
                  </div>
                  <div className="branch-actions">
                    {branch.kind === "remote" ? (
                      <button
                        className="text-button"
                        disabled={blocked}
                        onClick={() =>
                          edit({
                            kind: "create",
                            name: branch.name.slice(branch.name.indexOf("/") + 1),
                            from: branch.ref,
                          })
                        }
                      >
                        Criar local
                      </button>
                    ) : (
                      <>
                        {!branch.current && (
                          <button
                            className="text-button"
                            disabled={blocked || branch.occupied || repository.dirty}
                            onClick={() => edit({ kind: "switch", branch: branch.name })}
                          >
                            Trocar
                          </button>
                        )}
                        <button
                          className="text-button"
                          disabled={blocked || branch.occupied}
                          onClick={() =>
                            edit({ kind: "rename", branch: branch.name, name: branch.name })
                          }
                        >
                          Renomear
                        </button>
                        {!branch.current && (
                          <button
                            className="text-button"
                            disabled={blocked || branch.occupied}
                            onClick={() => {
                              setValidation(null);
                              void change(repository.id, { kind: "delete", branch: branch.name });
                            }}
                          >
                            Excluir
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </article>
              ))}
            {!!repository.branches.length &&
              !repository.branches.some((branch) =>
                branch.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()),
              ) && <p>Nenhuma branch corresponde à busca.</p>}
          </div>
        </>
      )}
      {(validation || error) && (
        <p className="sources-error" role="alert">
          {validation || error}
        </p>
      )}
      {data?.message && !error && (
        <p className="branches-notice" role="status">
          {data.message}
        </p>
      )}
      <p className="sources-hint">
        A lista usa os dados Git já presentes no computador. Criar ou renomear aqui não publica no
        remoto. Use Atualizar lista após alterações feitas fora desta tela.
      </p>
    </dialog>
  );
}

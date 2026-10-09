import { useEffect, useRef, useState } from "react";
import { Database, Eye, EyeOff, Plus, Trash2, X } from "lucide-react";
import {
  databasePasswordSchema,
  emptySqlServerConfig,
  maxDatabaseConnections,
  sqlServerConfigSchema,
  type ProjectDatabases,
  type SqlServerConfig,
} from "../shared/database-connections";
import type { Action } from "../shared/types";

export function DatabaseConnectionsDialog({
  projectName,
  projectPath,
  data,
  pending,
  busy,
  error,
  run,
  close,
}: {
  projectName: string;
  projectPath: string;
  data: ProjectDatabases | null;
  pending: boolean;
  busy: boolean;
  error: string | null;
  run: (action: Action) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [id, setId] = useState<string | null>(null);
  const [config, setConfig] = useState<SqlServerConfig>(() =>
    structuredClone(emptySqlServerConfig),
  );
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testId, setTestId] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState("");
  const [recoveryRevision, setRecoveryRevision] = useState<string | null>(null);
  const initialized = useRef(false);
  const testing = data?.test?.status === "testing";
  const locked = pending || testing || busy;
  const saved = data?.connections.find((entry) => entry.id === id);
  useEffect(() => {
    if (data && !initialized.current) {
      initialized.current = true;
      select(data.connections[0]?.id || null);
    }
  }, [data]);
  useEffect(() => {
    if (data && recoveryRevision && data.revision !== recoveryRevision) {
      select(data.connections[0]?.id || null);
      setRecoveryRevision(null);
    }
  }, [data, recoveryRevision]);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  function select(nextId: string | null) {
    const entry = data?.connections.find((entry) => entry.id === nextId);
    setId(entry?.id || null);
    setConfig(structuredClone(entry?.config || emptySqlServerConfig));
    setPassword("");
    setShowPassword(false);
    setRemember(!!entry?.passwordSaved);
    setValidation(null);
    setConfirmDelete(false);
    setTestId(null);
  }
  function change(next: Partial<SqlServerConfig>) {
    setConfig((config) => ({ ...config, ...next }));
    setValidation(null);
    setConfirmDelete(false);
    setTestId(null);
  }
  function valid(): SqlServerConfig | null {
    const result = sqlServerConfigSchema.safeParse(config);
    if (!result.success) {
      const field = result.error.issues[0].path[0];
      const labels: Record<string, string> = {
        name: "Nome",
        server: "Servidor",
        database: "Banco de dados",
        user: "Usuário",
        endpoint: "Porta ou instância",
        certificateHost: "Nome no certificado",
        timeoutSeconds: "Prazo",
      };
      setValidation(
        `Confira ${labels[String(field)] || "os campos"}. ${field === "server" ? "Use apenas o hostname ou IP, sem URL, porta ou instância." : "Preencha um valor válido dentro dos limites indicados."}`,
      );
      return null;
    }
    if (!databasePasswordSchema.safeParse(password).success) {
      setValidation("A senha deve ter até 1024 caracteres e não pode conter caractere nulo.");
      return null;
    }
    setValidation(null);
    return result.data;
  }
  async function submit(test: boolean) {
    if (locked || !data) return;
    const parsed = valid();
    if (!parsed) return;
    if ((test || remember) && !password && !saved?.passwordAvailable) {
      setValidation("Informe a senha do usuário.");
      return;
    }
    const common = {
      projectPath,
      revision: data.revision,
      connectionId: id,
      config: parsed,
      password,
    };
    if (test) {
      const current = crypto.randomUUID();
      setTestId(current);
      await run({ type: "testDatabase", testId: current, ...common });
    } else if (await run({ type: "saveDatabase", rememberPassword: remember, ...common })) {
      // Successful persistence clears typed credentials; saved passwords are never loaded into fields.
      setPassword("");
      setShowPassword(false);
      close();
    }
  }
  async function cancelTest() {
    if (data?.test) await run({ type: "cancelDatabaseTest", projectPath, testId: data.test.id });
  }
  async function dismiss() {
    if (testing) {
      await cancelTest();
      close();
    } else if (!pending) close();
  }
  const result = data?.test && (data.test.id === testId || testing) ? data.test : null;
  return (
    <dialog
      ref={dialog}
      className="modal sources-dialog database-dialog"
      aria-labelledby="databases-title"
      onCancel={(event) => {
        event.preventDefault();
        void dismiss();
      }}
    >
      <div className="sources-heading">
        <Database size={22} />
        <h2 id="databases-title">Conexões com banco de dados</h2>
        <button
          className="icon-button"
          aria-label="Fechar conexões"
          disabled={pending && !testing}
          onClick={() => void dismiss()}
        >
          <X size={18} />
        </button>
      </div>
      <p>
        Conexões SQL Server de <strong>{projectName}</strong>.
      </p>
      <p className="sources-hint">
        O assistente consulta os bancos após sua autorização. A senha fica no STAG Plus; resultados
        SQL são enviados ao assistente. Alterações de dados pedem confirmação por operação.
      </p>
      {!data ? (
        <p role="alert">{error || "Carregando conexões…"}</p>
      ) : (
        <>
          <div className="api-consent">
            <p>
              {data.authorized
                ? "Bancos autorizados nesta conversa. Alterações de dados pedem confirmação."
                : "O uso pelo assistente está desautorizado. Salvar ou testar não autoriza consultas."}
            </p>
            <button
              className="secondary-button"
              disabled={(!data.authorized && (locked || busy)) || !data.connections.length}
              onClick={() => (
                setValidation(null),
                void run({
                  type: "databaseConsent",
                  projectPath,
                  revision: data.revision,
                  allow: !data.authorized,
                })
              )}
            >
              {data.authorized ? "Revogar bancos" : "Autorizar bancos nesta conversa"}
            </button>
          </div>
          {data.metrics.requests > 0 && (
            <p className="sources-hint" role="status">
              {data.metrics.requests} operações SQL · {data.metrics.failures} falhas
              {data.metrics.lastRows !== null
                ? ` · última consulta: ${data.metrics.lastRows} linhas`
                : ""}
            </p>
          )}
          <label className="database-saved">
            Conexão salva
            <select
              aria-label="Conexão salva"
              value={id || ""}
              disabled={locked}
              onChange={(event) => select(event.target.value || null)}
            >
              <option value="">Nova conexão</option>
              {data.connections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.config.name}
                </option>
              ))}
            </select>
          </label>
          <p className="sources-hint database-project-summary">
            {data.connections.length === 1
              ? "1 conexão salva"
              : `${data.connections.length} conexões salvas`}{" "}
            nesta pasta: <span>{projectPath}</span>. Selecionar novamente a mesma pasta preserva os
            cadastros. Outra pasta mantém um catálogo separado.
          </p>
          {!!data.recoverySources?.length && (
            <details className="database-recovery">
              <summary>Recuperar conexões de outra pasta</summary>
              <p className="sources-hint">
                Se mudou o caminho da pasta, copie os cadastros anteriores. A origem será
                preservada; confirme as duas pastas antes de copiar.
              </p>
              <label>
                Pasta de origem
                <select
                  aria-label="Pasta de origem"
                  value={recoveryId}
                  disabled={locked}
                  onChange={(event) => setRecoveryId(event.target.value)}
                >
                  <option value="">Escolha a pasta anterior</option>
                  {data.recoverySources.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.path} ({entry.count})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={locked || !recoveryId}
                onClick={async () => {
                  const source = data.recoverySources?.find((entry) => entry.id === recoveryId);
                  if (source) {
                    setRecoveryRevision(data.revision);
                    if (
                      !(await run({
                        type: "recoverDatabases",
                        projectPath,
                        revision: data.revision,
                        sourceId: source.id,
                        sourceRevision: source.revision,
                      }))
                    )
                      setRecoveryRevision(null);
                  }
                }}
              >
                Recuperar conexões
              </button>
            </details>
          )}
          <form
            noValidate
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <fieldset className="source-entry database-fields" disabled={locked}>
              <legend>SQL Server · autenticação por usuário e senha</legend>
              <label>
                Nome da conexão
                <input
                  value={config.name}
                  maxLength={80}
                  placeholder="Ex.: Homologação"
                  onChange={(event) => change({ name: event.target.value })}
                />
              </label>
              <label>
                Servidor
                <input
                  value={config.server}
                  maxLength={253}
                  placeholder="Ex.: localhost ou sql.empresa.com"
                  spellCheck={false}
                  onChange={(event) => change({ server: event.target.value })}
                />
              </label>
              <div className="database-grid">
                <label>
                  Endereço por
                  <select
                    aria-label="Endereço por"
                    value={config.endpoint.kind}
                    onChange={(event) =>
                      change({
                        endpoint:
                          event.target.value === "port"
                            ? { kind: "port", port: 1433 }
                            : { kind: "instance", instance: "" },
                      })
                    }
                  >
                    <option value="port">Porta TCP</option>
                    <option value="instance">Instância nomeada</option>
                  </select>
                </label>
                {config.endpoint.kind === "port" ? (
                  <label>
                    Porta
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={Number.isFinite(config.endpoint.port) ? config.endpoint.port : ""}
                      onChange={(event) =>
                        change({ endpoint: { kind: "port", port: event.target.valueAsNumber } })
                      }
                    />
                  </label>
                ) : (
                  <label>
                    Instância
                    <input
                      value={config.endpoint.instance}
                      maxLength={128}
                      placeholder="Ex.: SQLEXPRESS"
                      onChange={(event) =>
                        change({ endpoint: { kind: "instance", instance: event.target.value } })
                      }
                    />
                  </label>
                )}
              </div>
              {config.endpoint.kind === "instance" && (
                <p className="sources-hint">
                  Requer SQL Server Browser e UDP 1434 acessível. Informe a instância separada do
                  servidor.
                </p>
              )}
              <label>
                Banco de dados
                <input
                  value={config.database}
                  maxLength={128}
                  placeholder="Nome exato do banco"
                  onChange={(event) => change({ database: event.target.value })}
                />
              </label>
              <label>
                Usuário
                <input
                  value={config.user}
                  maxLength={128}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => change({ user: event.target.value })}
                />
              </label>
              <label>
                Senha do usuário
                <span className="database-password">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    maxLength={1024}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      saved?.passwordSaved
                        ? "Salva · deixe vazio para manter ou digite para substituir"
                        : saved?.passwordAvailable
                          ? "Disponível nesta sessão · digite para substituir"
                          : "Digite a senha"
                    }
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setValidation(null);
                      setTestId(null);
                    }}
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </span>
              </label>
              <label className="database-check">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={!data.canRememberPassword && !remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Lembrar senha neste computador
              </label>
              <p className="sources-hint">
                {data.canRememberPassword
                  ? "A senha salva fica protegida pelo sistema para este usuário e projeto. Desmarcar e salvar remove a senha guardada."
                  : "Armazenamento protegido indisponível. Ao salvar, a senha fica somente nesta sessão do STAG Plus."}
              </p>
              <details className="database-advanced">
                <summary>Segurança e opções avançadas</summary>
                <label className="database-check">
                  <input
                    type="checkbox"
                    checked={config.encrypt}
                    onChange={(event) => change({ encrypt: event.target.checked })}
                  />
                  Criptografar conexão (TLS)
                </label>
                {!config.encrypt && (
                  <p className="sources-hint">
                    Sem TLS, a comunicação pode ficar exposta. Use apenas se o ambiente exigir e
                    você confiar na rede.
                  </p>
                )}
                <label className="database-check">
                  <input
                    type="checkbox"
                    checked={config.trustServerCertificate}
                    onChange={(event) => change({ trustServerCertificate: event.target.checked })}
                  />
                  Confiar no certificado do servidor
                </label>
                {config.trustServerCertificate && (
                  <p className="sources-hint">
                    Esta opção dispensa a validação do certificado. Confirme a identidade do
                    servidor com o administrador do banco.
                  </p>
                )}
                <label>
                  Nome no certificado (opcional)
                  <input
                    value={config.certificateHost}
                    maxLength={253}
                    placeholder="Usa o nome do servidor se vazio"
                    onChange={(event) => change({ certificateHost: event.target.value })}
                  />
                </label>
                <label>
                  Prazo por etapa (segundos)
                  <input
                    type="number"
                    min={5}
                    max={60}
                    value={Number.isFinite(config.timeoutSeconds) ? config.timeoutSeconds : ""}
                    onChange={(event) => change({ timeoutSeconds: event.target.valueAsNumber })}
                  />
                </label>
              </details>
            </fieldset>
            {(validation || error) && (
              <p className="sources-error" role="alert">
                {validation || error}
              </p>
            )}
            {result && (
              <p
                className={`database-result ${result.status}`}
                role={result.status === "error" ? "alert" : "status"}
              >
                {result.message}
                {result.elapsedMs !== undefined && (
                  <span> · {(result.elapsedMs / 1000).toFixed(1)} s</span>
                )}
              </p>
            )}
            <div className="database-actions">
              {id && (
                <button
                  className="text-button source-remove"
                  type="button"
                  disabled={locked}
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 size={14} />
                  Excluir conexão
                </button>
              )}
              {id && (
                <button
                  className="text-button"
                  type="button"
                  disabled={locked}
                  onClick={() => select(null)}
                >
                  <Plus size={14} />
                  Nova conexão
                </button>
              )}
              {testing ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void cancelTest()}
                >
                  Cancelar teste
                </button>
              ) : (
                <button
                  className="secondary-button"
                  type="button"
                  disabled={locked}
                  onClick={() => void submit(true)}
                >
                  Testar conexão
                </button>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={locked || (!id && data.connections.length >= maxDatabaseConnections)}
              >
                {pending && !testing ? "Salvando…" : "Salvar conexão"}
              </button>
            </div>
            {confirmDelete && saved && (
              <div className="database-delete" role="alert">
                <p>
                  Excluir a configuração <strong>{saved.config.name}</strong> e a senha salva deste
                  projeto?
                </p>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Manter conexão
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={locked}
                    onClick={async () => {
                      if (
                        await run({
                          type: "deleteDatabase",
                          projectPath,
                          revision: data.revision,
                          connectionId: id!,
                        })
                      )
                        select(null);
                    }}
                  >
                    Confirmar exclusão
                  </button>
                </div>
              </div>
            )}
          </form>
        </>
      )}
    </dialog>
  );
}

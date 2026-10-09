import { useEffect, useRef, useState } from "react";
import { Network, Plus, Trash2, X } from "lucide-react";
import {
  apiConfigSchema,
  apiSecretSchema,
  emptyApiConfig,
  emptyOAuthConfig,
  type ApiConfig,
  type ProjectApis,
} from "../shared/api-connections";
import type { Action } from "../shared/types";

export function ApiConnectionsDialog({
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
  data: ProjectApis | null;
  pending: boolean;
  busy: boolean;
  error: string | null;
  run: (action: Action) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selectAfterSave = useRef<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [config, setConfig] = useState<ApiConfig>(() => structuredClone(emptyApiConfig));
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const working = data?.operation?.status === "working";
  const operation = data?.operation?.connectionId === id || working ? data?.operation : null;
  const locked = pending || working || busy;
  const saved = data?.connections.find((entry) => entry.id === id);
  const oauth = config.auth.type === "oauth2" ? config.auth : null;
  const needsSecret =
    ["bearer", "basic"].includes(config.auth.type) ||
    (oauth && oauth.clientAuthentication !== "none");
  const changed =
    saved &&
    (JSON.stringify(config) !== JSON.stringify(saved.config) ||
      !!secret ||
      remember !== saved.remember);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!selectAfterSave.current) return;
    const entry = data?.connections.find((entry) => entry.config.name === selectAfterSave.current);
    if (!entry || pending) return;
    selectAfterSave.current = null;
    setId(entry.id);
    setConfig(structuredClone(entry.config));
    setRemember(entry.remember);
    setSecret("");
  }, [data, pending]);
  function select(next: string | null) {
    const entry = data?.connections.find((entry) => entry.id === next);
    setId(entry?.id || null);
    setConfig(structuredClone(entry?.config || emptyApiConfig));
    setSecret("");
    setRemember(!!entry?.remember);
    setValidation(null);
    setConfirmDelete(false);
  }
  function change(next: Partial<ApiConfig>) {
    setConfig((value) => ({ ...value, ...next }));
    setValidation(null);
    setConfirmDelete(false);
  }
  async function save() {
    if (!data || locked) return;
    const parsed = apiConfigSchema.safeParse(config);
    if (!parsed.success || !apiSecretSchema.safeParse(secret).success) {
      const field = parsed.success ? "Credencial" : String(parsed.error.issues[0].path[0]);
      const labels: Record<string, string> = {
        name: "Nome da API",
        baseUrl: "URL base",
        allowHttp: "Permitir HTTP",
        auth: "Autenticação",
        timeoutSeconds: "Prazo",
      };
      setValidation(
        `Confira ${labels[field] || field}. Use campos válidos e URLs completas, sem credenciais ou parâmetros. Para HTTP, habilite a opção explícita.`,
      );
      return;
    }
    selectAfterSave.current = parsed.data.name;
    if (
      await run({
        type: "saveApi",
        projectPath,
        revision: data.revision,
        connectionId: id,
        config: parsed.data,
        secret,
        remember,
      })
    ) {
      setSecret("");
      setValidation("API salva. Autorize o uso nesta conversa quando estiver pronta.");
    } else selectAfterSave.current = null;
  }
  async function dismiss() {
    if (working)
      await run({ type: "cancelApiLogin", projectPath, operationId: data!.operation!.id });
    if (!pending || working) close();
  }
  return (
    <dialog
      ref={dialog}
      className="modal sources-dialog database-dialog api-dialog"
      aria-labelledby="apis-title"
      onCancel={(event) => {
        event.preventDefault();
        void dismiss();
      }}
    >
      <div className="sources-heading">
        <Network size={22} />
        <h2 id="apis-title">APIs HTTP e HTTPS</h2>
        <button
          className="icon-button"
          aria-label="Fechar APIs"
          disabled={pending && !working}
          onClick={() => void dismiss()}
        >
          <X size={18} />
        </button>
      </div>
      <p>
        APIs de <strong>{projectName}</strong>.
      </p>
      <p className="sources-hint">
        O assistente faz requisições usando a conexão escolhida. Senhas e tokens ficam no STAG Plus;
        as respostas da API são enviadas ao assistente.
      </p>
      {!data ? (
        <p role="alert">{error || "Carregando APIs…"}</p>
      ) : (
        <>
          <div className="api-consent">
            <p>
              {data.authorized
                ? "APIs autorizadas nesta conversa. Operações com efeitos pedem confirmação."
                : "O uso pelo assistente está desautorizado. Salvar ou entrar não autoriza requisições."}
            </p>
            <button
              className="secondary-button"
              disabled={(!data.authorized && locked) || !data.connections.length}
              onClick={() => (
                setValidation(null),
                void run({
                  type: "apiConsent",
                  projectPath,
                  revision: data.revision,
                  allow: !data.authorized,
                })
              )}
            >
              {data.authorized ? "Revogar APIs" : "Autorizar APIs nesta conversa"}
            </button>
          </div>
          <label className="database-saved">
            API cadastrada
            <select
              aria-label="API cadastrada"
              value={id || ""}
              disabled={locked}
              onChange={(event) => select(event.target.value || null)}
            >
              <option value="">Nova API</option>
              {data.connections.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.config.name}
                </option>
              ))}
            </select>
          </label>
          <form
            noValidate
            autoComplete="off"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset className="source-entry database-fields" disabled={locked}>
              <legend>Conexão com a API</legend>
              <label>
                Nome da API
                <input
                  value={config.name}
                  maxLength={80}
                  placeholder="Ex.: API de homologação"
                  onChange={(event) => change({ name: event.target.value })}
                />
              </label>
              <label>
                URL base
                <input
                  value={config.baseUrl}
                  maxLength={2048}
                  placeholder="https://api.empresa.com/v1/"
                  spellCheck={false}
                  onChange={(event) => change({ baseUrl: event.target.value })}
                />
              </label>
              <p className="sources-hint">
                As requisições ficam restritas a esse endereço e seus caminhos. Não coloque senha ou
                token na URL.
              </p>
              <label>
                Autenticação
                <select
                  aria-label="Autenticação"
                  value={config.auth.type}
                  onChange={(event) => {
                    setSecret("");
                    const type = event.target.value as ApiConfig["auth"]["type"];
                    change({
                      auth:
                        type === "oauth2"
                          ? { ...emptyOAuthConfig }
                          : type === "basic"
                            ? { type, user: "" }
                            : { type },
                    });
                  }}
                >
                  <option value="none">Sem autenticação</option>
                  <option value="bearer">Token Bearer</option>
                  <option value="basic">Usuário e senha (Basic)</option>
                  <option value="oauth2">OAuth2</option>
                </select>
              </label>
              {config.auth.type === "basic" && (
                <label>
                  Usuário da API
                  <input
                    value={config.auth.user}
                    maxLength={256}
                    autoComplete="off"
                    onChange={(event) =>
                      change({ auth: { type: "basic", user: event.target.value } })
                    }
                  />
                </label>
              )}
              {oauth && (
                <>
                  <label>
                    Fluxo OAuth2
                    <select
                      aria-label="Fluxo OAuth2"
                      value={oauth.flow}
                      onChange={(event) =>
                        change({
                          auth: {
                            ...oauth,
                            flow: event.target.value as typeof oauth.flow,
                            clientAuthentication:
                              event.target.value === "client_credentials" ? "basic" : "none",
                          },
                        })
                      }
                    >
                      <option value="authorization_code">Login com redirecionamento (PKCE)</option>
                      <option value="client_credentials">Client Credentials (serviço)</option>
                    </select>
                  </label>
                  {oauth.flow === "authorization_code" && (
                    <label>
                      URL de autorização
                      <input
                        value={oauth.authorizationUrl}
                        maxLength={2048}
                        placeholder="https://login.empresa.com/authorize"
                        onChange={(event) =>
                          change({ auth: { ...oauth, authorizationUrl: event.target.value } })
                        }
                      />
                    </label>
                  )}
                  <label>
                    URL do token
                    <input
                      value={oauth.tokenUrl}
                      maxLength={2048}
                      placeholder="https://login.empresa.com/token"
                      onChange={(event) =>
                        change({ auth: { ...oauth, tokenUrl: event.target.value } })
                      }
                    />
                  </label>
                  <label>
                    Client ID
                    <input
                      value={oauth.clientId}
                      maxLength={512}
                      onChange={(event) =>
                        change({ auth: { ...oauth, clientId: event.target.value } })
                      }
                    />
                  </label>
                  <label>
                    Autenticação do cliente
                    <select
                      aria-label="Autenticação do cliente"
                      value={oauth.clientAuthentication}
                      onChange={(event) =>
                        change({
                          auth: {
                            ...oauth,
                            clientAuthentication: event.target
                              .value as typeof oauth.clientAuthentication,
                          },
                        })
                      }
                    >
                      {oauth.flow === "authorization_code" && (
                        <option value="none">Cliente público (sem segredo)</option>
                      )}
                      <option value="basic">Client secret no header Basic</option>
                      <option value="body">Client secret no corpo</option>
                    </select>
                  </label>
                  <label>
                    Scopes (separados por espaço)
                    <input
                      value={oauth.scopes}
                      maxLength={2048}
                      placeholder="Ex.: api.read offline_access"
                      onChange={(event) =>
                        change({ auth: { ...oauth, scopes: event.target.value } })
                      }
                    />
                  </label>
                  {oauth.flow === "authorization_code" && (
                    <>
                      <label>
                        Porta do retorno OAuth2
                        <input
                          type="number"
                          min={1024}
                          max={65535}
                          value={Number.isFinite(oauth.callbackPort) ? oauth.callbackPort : ""}
                          onChange={(event) =>
                            change({ auth: { ...oauth, callbackPort: event.target.valueAsNumber } })
                          }
                        />
                      </label>
                      <p className="sources-hint">
                        Cadastre este Redirect URI no provedor:{" "}
                        <code>{`http://127.0.0.1:${Number.isFinite(oauth.callbackPort) ? oauth.callbackPort : "PORTA"}/oauth/callback`}</code>
                      </p>
                      <p className="sources-hint">
                        Você informa usuário, senha e MFA na página do provedor. O STAG Plus renova
                        a sessão com o refresh token, quando o provedor permitir. Salve e clique em
                        Entrar com OAuth2.
                      </p>
                    </>
                  )}
                </>
              )}
              {needsSecret && (
                <label>
                  {config.auth.type === "basic"
                    ? "Senha da API"
                    : config.auth.type === "bearer"
                      ? "Token da API"
                      : "Client secret"}
                  <input
                    type="password"
                    value={secret}
                    maxLength={16384}
                    autoComplete="new-password"
                    spellCheck={false}
                    placeholder={
                      saved?.credentialAvailable
                        ? "Guardada · deixe vazio para manter"
                        : "Digite a credencial"
                    }
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
              )}
              {config.auth.type !== "none" && (
                <label className="database-check">
                  <input
                    type="checkbox"
                    checked={remember}
                    disabled={!data.canRemember && !remember}
                    onChange={(event) => setRemember(event.target.checked)}
                  />
                  Lembrar credenciais neste computador
                </label>
              )}
              <p className="sources-hint">
                {data.canRemember
                  ? "Se marcada, protege as credenciais para este usuário e projeto. Desmarcada: uso somente até encerrar o STAG Plus."
                  : "Armazenamento protegido indisponível. As credenciais ficam somente nesta sessão."}
              </p>
              <details className="database-advanced">
                <summary>Segurança e prazo</summary>
                <label className="database-check">
                  <input
                    type="checkbox"
                    checked={config.allowHttp}
                    onChange={(event) => change({ allowHttp: event.target.checked })}
                  />
                  Permitir HTTP sem criptografia nesta conexão
                </label>
                {config.allowHttp && (
                  <p className="sources-hint">
                    HTTP pode expor credenciais e dados na rede. Use apenas no destino de
                    desenvolvimento que você autorizou. Certificados HTTPS continuam sendo
                    validados.
                  </p>
                )}
                <label>
                  Prazo da requisição (segundos)
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={Number.isFinite(config.timeoutSeconds) ? config.timeoutSeconds : ""}
                    onChange={(event) => change({ timeoutSeconds: event.target.valueAsNumber })}
                  />
                </label>
              </details>
            </fieldset>
            {(validation || error) && (
              <p
                className={
                  validation?.startsWith("API salva") && !error
                    ? "database-result success"
                    : "sources-error"
                }
                role={error || !validation?.startsWith("API salva") ? "alert" : "status"}
              >
                {error || validation}
              </p>
            )}
            {operation && (
              <p
                className={`database-result ${operation.status}`}
                role={operation.status === "error" ? "alert" : "status"}
              >
                {operation.message}
              </p>
            )}
            {saved && (
              <p className="sources-hint">
                {saved.authenticated ? "Autenticação disponível" : "Autenticação pendente"}
                {changed ? " · Salve as alterações antes de entrar." : ""}
              </p>
            )}
            <div className="database-actions">
              {id && (
                <>
                  <button
                    type="button"
                    className="text-button source-remove"
                    disabled={locked}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 size={14} />
                    Excluir API
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={locked}
                    onClick={() => select(null)}
                  >
                    <Plus size={14} />
                    Nova API
                  </button>
                </>
              )}
              {working ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() =>
                    void run({
                      type: "cancelApiLogin",
                      projectPath,
                      operationId: data!.operation!.id,
                    })
                  }
                >
                  Cancelar login
                </button>
              ) : (
                oauth &&
                id && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked || !!changed}
                    onClick={() =>
                      void run({
                        type: "authenticateApi",
                        projectPath,
                        revision: data.revision,
                        connectionId: id,
                      })
                    }
                  >
                    {oauth.flow === "authorization_code"
                      ? "Entrar com OAuth2"
                      : "Obter token OAuth2"}
                  </button>
                )
              )}
              <button
                type="submit"
                className="primary-button"
                disabled={locked || (!id && data.connections.length >= 20)}
              >
                Salvar API
              </button>
            </div>
            {confirmDelete && id && (
              <div className="database-delete" role="alert">
                <p>Excluir esta API e as credenciais guardadas neste projeto?</p>
                <div className="approval-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Manter API
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={locked}
                    onClick={async () => {
                      if (
                        await run({
                          type: "deleteApi",
                          projectPath,
                          revision: data.revision,
                          connectionId: id,
                        })
                      )
                        select(null);
                    }}
                  >
                    Confirmar exclusão da API
                  </button>
                </div>
              </div>
            )}
          </form>
          {data.metrics.requests > 0 && (
            <p className="sources-hint" aria-label="Métricas das APIs">
              {data.metrics.requests} requisições · {data.metrics.failures} falhas ·{" "}
              {(data.metrics.elapsedMs / 1000).toFixed(1)} s
              {data.metrics.lastStatus !== null ? ` · HTTP ${data.metrics.lastStatus}` : ""}
            </p>
          )}
        </>
      )}
    </dialog>
  );
}

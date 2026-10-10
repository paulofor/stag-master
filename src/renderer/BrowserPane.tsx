import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Globe2,
  Monitor,
  PanelsTopLeft,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { browserTabs, browserTabLabels, type Action, type BrowserState } from "../shared/types";

const downloadSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function BrowserPane({
  state,
  projectPath,
  busy,
  pending,
  obscured = false,
  run,
  backToChat,
}: {
  state: BrowserState;
  projectPath?: string;
  busy: boolean;
  pending: boolean;
  obscured?: boolean;
  run: (action: Action) => Promise<boolean>;
  backToChat: () => void;
}) {
  const urls = { documentation: state.tabs.documentation.url, system: state.tabs.system.url };
  const previousUrls = useRef(urls);
  const [addresses, setAddresses] = useState(urls);
  const address = addresses[state.activeTab];
  const viewport = useRef<HTMLDivElement>(null);
  const viewBounds = useCallback(() => {
    const rect = viewport.current?.getBoundingClientRect();
    return !obscured && rect?.width && rect.height
      ? {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.floor(rect.width),
          height: Math.floor(rect.height),
        }
      : { x: 0, y: 0, width: 0, height: 0 };
  }, [obscured]);
  useEffect(() => {
    const current = { documentation: state.tabs.documentation.url, system: state.tabs.system.url };
    const changed = Object.fromEntries(
      browserTabs
        .filter((tab) => current[tab] !== previousUrls.current[tab])
        .map((tab) => [tab, current[tab]]),
    );
    if (Object.keys(changed).length) setAddresses((saved) => ({ ...saved, ...changed }));
    previousUrls.current = current;
  }, [state.tabs.documentation.url, state.tabs.system.url]);
  useEffect(() => {
    const target = viewport.current;
    const bridge = window.stag;
    if (!target || !bridge) return;
    const update = () => {
      void bridge.request({ type: "browserBounds", bounds: viewBounds() }).catch(() => {});
    };
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener("resize", update);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
      void bridge
        .request({ type: "browserBounds", bounds: { x: 0, y: 0, width: 0, height: 0 } })
        .catch(() => {});
    };
  }, [viewBounds]);
  const manualDisabled = busy || pending || obscured;
  return (
    <section className="browser-panel" aria-label="Navegador do assistente">
      <header className="browser-heading">
        <span>
          <Globe2 size={17} />
          <strong>Navegador</strong>
        </span>
        <button className="text-button compact-chat-button" onClick={backToChat}>
          Voltar à conversa
        </button>
        <button
          className="icon-button"
          aria-label="Fechar navegador"
          onClick={() => void run({ type: "browserVisibility", visible: false })}
        >
          <X size={17} />
        </button>
      </header>
      <div className="browser-tabs" role="tablist" aria-label="Abas do navegador">
        {browserTabs.map((tab, index) => (
          <button
            key={tab}
            id={`browser-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={state.activeTab === tab}
            aria-controls="browser-page"
            tabIndex={state.activeTab === tab ? 0 : -1}
            disabled={manualDisabled}
            title={state.tabs[tab].error || state.tabs[tab].title || browserTabLabels[tab]}
            onClick={() => void run({ type: "browserTab", tab })}
            onKeyDown={(event) => {
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : event.key === "ArrowRight" || event.key === "ArrowLeft"
                      ? 1 - index
                      : null;
              if (next === null) return;
              event.preventDefault();
              document.getElementById(`browser-tab-${browserTabs[next]}`)?.focus();
              void run({ type: "browserTab", tab: browserTabs[next] });
            }}
          >
            {tab === "documentation" ? <BookOpen size={15} /> : <Monitor size={15} />}
            <span>{browserTabLabels[tab]}</span>
            {state.tabs[tab].loading && (
              <RefreshCw className="loading" size={12} aria-label="Carregando" />
            )}
            {state.tabs[tab].error && (
              <span className="browser-tab-error" aria-label="Falha nesta aba">
                !
              </span>
            )}
          </button>
        ))}
      </div>
      <form
        className="browser-toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          const raw = address.trim();
          if (raw)
            void run({
              type: "browserControl",
              control: {
                action: "navigate",
                tab: state.activeTab,
                url: /^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`,
              },
            });
        }}
      >
        <button
          type="button"
          className="icon-button"
          aria-label="Voltar página"
          disabled={manualDisabled || !state.canGoBack}
          onClick={() =>
            void run({ type: "browserControl", control: { action: "back", tab: state.activeTab } })
          }
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Avançar página"
          disabled={manualDisabled || !state.canGoForward}
          onClick={() =>
            void run({
              type: "browserControl",
              control: { action: "forward", tab: state.activeTab },
            })
          }
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className={`icon-button ${state.loading ? "loading" : ""}`}
          aria-label="Recarregar página"
          disabled={manualDisabled || !state.url}
          onClick={() =>
            void run({
              type: "browserControl",
              control: { action: "reload", tab: state.activeTab },
            })
          }
        >
          <RefreshCw size={15} />
        </button>
        <input
          aria-label="Endereço do navegador"
          placeholder="Digite um endereço ou peça ao STAG Plus"
          value={address}
          disabled={manualDisabled}
          onChange={(event) =>
            setAddresses((saved) => ({ ...saved, [state.activeTab]: event.target.value }))
          }
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="text-button" disabled={manualDisabled || !address.trim()}>
          Ir
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Restaurar visualização"
          title="Restaurar visualização sem recarregar a página"
          disabled={obscured || !state.url}
          onClick={() => void run({ type: "browserBounds", bounds: viewBounds() })}
        >
          <PanelsTopLeft size={16} />
        </button>
      </form>
      <div className="browser-control-status" role="status">
        <span className={state.authorized ? "browser-authorized" : ""}>
          <ShieldCheck size={13} />
          {state.authorized
            ? "Modelo autorizado · confirmações críticas"
            : "Controle do modelo desativado"}
        </span>
        <button
          className="text-button"
          disabled={state.authorized ? pending : manualDisabled}
          onClick={() => void run({ type: "browserConsent", allow: !state.authorized })}
        >
          {state.authorized ? "Revogar navegador" : "Autorizar navegador"}
        </button>
      </div>
      <div className="browser-session-settings">
        <label>
          <input
            type="checkbox"
            checked={state.remember}
            disabled={manualDisabled || !projectPath}
            onChange={(event) =>
              void run({
                type: "browserSession",
                projectPath: projectPath!,
                remember: event.target.checked,
              })
            }
          />
          Lembrar sessões neste projeto
        </label>
        <button
          className="text-button"
          disabled={manualDisabled || !projectPath || !state.remember}
          onClick={() =>
            void run({ type: "browserSession", projectPath: projectPath!, remember: false })
          }
        >
          Esquecer logins
        </button>
        <small>
          {state.remember
            ? "Sessões salvas neste computador. O site pode exigir novo login."
            : "Sessão temporária. Ative antes do login para lembrar neste computador."}
        </small>
      </div>
      {state.error && (
        <div className="browser-error" role="alert">
          {state.error}
        </div>
      )}
      {state.certificate && (
        <div className="browser-certificate" role="alert">
          <strong>Certificado inválido · {state.certificate.origin}</strong>
          <span>
            Você pode abrir este site por sua conta e risco. A identidade do servidor não foi
            confirmada.
          </span>
          <button
            className="text-button"
            disabled={manualDisabled}
            onClick={() =>
              void run({
                type: "browserControl",
                control: {
                  action: "trustCertificate",
                  tab: state.activeTab,
                  certificateId: state.certificate!.id,
                },
              })
            }
          >
            Abrir mesmo assim
          </button>
          {busy && <small>Pare o assistente para liberar o site e depois retome a tarefa.</small>}
        </div>
      )}
      {state.insecureOrigin && (
        <div className="browser-certificate" role="status">
          <strong>Não seguro · {state.insecureOrigin}</strong>
          <span>Certificado aceito por você somente nesta sessão da aba.</span>
          <button
            className="text-button"
            disabled={manualDisabled}
            onClick={() =>
              void run({
                type: "browserControl",
                control: { action: "clearCertificateExceptions", tab: state.activeTab },
              })
            }
          >
            Encerrar acesso não seguro
          </button>
        </div>
      )}
      {state.download && (
        <div className="browser-download" role="status" aria-label="Download do navegador">
          <strong>{state.download.message}</strong>
          <span>
            {downloadSize(state.download.receivedBytes)}
            {state.download.totalBytes !== null && ` de ${downloadSize(state.download.totalBytes)}`}
          </span>
          {state.download.status === "downloading" && (
            <>
              <progress
                aria-label="Progresso do download"
                max={state.download.totalBytes || 1}
                value={state.download.totalBytes ? state.download.receivedBytes : undefined}
              />
              <small>Use Parar na conversa para cancelar.</small>
            </>
          )}
          {state.download.path && <code>{state.download.path}</code>}
        </div>
      )}
      <div
        ref={viewport}
        id="browser-page"
        role="tabpanel"
        aria-labelledby={`browser-tab-${state.activeTab}`}
        className="browser-viewport"
      >
        {!state.url && (
          <div className="browser-empty">
            <span className="browser-empty-icon">
              <Globe2 size={32} strokeWidth={1.3} />
            </span>
            <h2>
              {state.activeTab === "documentation"
                ? "Documentação, junto da conversa"
                : "Seu sistema, junto da conversa"}
            </h2>
            <p>
              {state.activeTab === "documentation"
                ? "Abra suas fontes de referência ou autorize o modelo para consultá-las aqui."
                : "Abra o endereço do sistema do projeto ou peça ao STAG Plus para acessá-lo."}
            </p>
            <p className="small">
              Navegação rotineira segue sem interrupções.
              <br />
              Envios e outras ações críticas pedem confirmação.
            </p>
          </div>
        )}
      </div>
      <footer className="browser-footer">
        <span title={state.url}>
          {state.loading
            ? "Carregando…"
            : state.title ||
              (state.remember ? "Sessões deste projeto" : "Sessão temporária por conversa")}
        </span>
        <span>STAG Plus</span>
      </footer>
    </section>
  );
}

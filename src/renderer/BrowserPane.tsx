import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Globe2, RefreshCw, ShieldCheck, X } from "lucide-react";
import type { Action, BrowserState } from "../shared/types";

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
  const [address, setAddress] = useState(state.url);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setAddress(state.url);
  }, [state.url]);
  useEffect(() => {
    const target = viewport.current;
    const bridge = window.stag;
    if (!target || !bridge) return;
    const update = () => {
      const rect = target.getBoundingClientRect();
      const bounds =
        !obscured && rect.width && rect.height
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.floor(rect.width),
              height: Math.floor(rect.height),
            }
          : { x: 0, y: 0, width: 0, height: 0 };
      void bridge.request({ type: "browserBounds", bounds }).catch(() => {});
    };
    const observer = new ResizeObserver(update);
    observer.observe(target);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      void bridge
        .request({ type: "browserBounds", bounds: { x: 0, y: 0, width: 0, height: 0 } })
        .catch(() => {});
    };
  }, [obscured]);
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
          onClick={() => void run({ type: "browserControl", control: { action: "back" } })}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Avançar página"
          disabled={manualDisabled || !state.canGoForward}
          onClick={() => void run({ type: "browserControl", control: { action: "forward" } })}
        >
          <ArrowRight size={16} />
        </button>
        <button
          type="button"
          className={`icon-button ${state.loading ? "loading" : ""}`}
          aria-label="Recarregar página"
          disabled={manualDisabled || !state.url}
          onClick={() => void run({ type: "browserControl", control: { action: "reload" } })}
        >
          <RefreshCw size={15} />
        </button>
        <input
          aria-label="Endereço do navegador"
          placeholder="Digite um endereço ou peça ao STAG"
          value={address}
          disabled={manualDisabled}
          onChange={(event) => setAddress(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <button type="submit" className="text-button" disabled={manualDisabled || !address.trim()}>
          Ir
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
      <div ref={viewport} className="browser-viewport" aria-label="Conteúdo do navegador">
        {!state.url && (
          <div className="browser-empty">
            <span className="browser-empty-icon">
              <Globe2 size={32} strokeWidth={1.3} />
            </span>
            <h2>A web, junto da conversa</h2>
            <p>Abra um endereço ou autorize o modelo para pesquisar e trabalhar aqui.</p>
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
        <span>STAG</span>
      </footer>
    </section>
  );
}

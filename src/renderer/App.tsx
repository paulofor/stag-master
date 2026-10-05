import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Code2,
  Copy,
  FileCode2,
  Folder,
  FolderOpen,
  Globe2,
  History,
  LogOut,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  X,
} from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { BrowserPane } from "./BrowserPane";
import { readPastedImage } from "./request-images";
import {
  maxRequestImages,
  maxRequestImageBytes,
  requestImageBytes,
  requestImagesSchema,
} from "../shared/request-images";
import {
  emptySnapshot,
  type Action,
  type Approval,
  type ChatItem,
  type Snapshot,
  type RequestImage,
} from "../shared/types";

const effortLabels: Record<string, string> = {
  none: "Sem esforço",
  minimal: "Mínimo",
  low: "Baixo",
  medium: "Médio",
  high: "Alto",
  xhigh: "Extra alto",
  max: "Máximo",
  ultra: "Ultra",
};
const modeLabels = { read: "Leitura", project: "Projeto · leitura e escrita", windows: "Windows" };
const suggestions = [
  {
    icon: Code2,
    title: "Começar pelo código",
    detail: "Conheça a estrutura do projeto",
    prompt:
      "Leia as instruções e a estrutura deste projeto. Explique a arquitetura e sugira o próximo passo de desenvolvimento.",
  },
  {
    icon: CircleHelp,
    title: "Resolver um problema",
    detail: "Investigue, corrija e valide",
    prompt:
      "Quero investigar um problema neste projeto. Leia as instruções e me ajude a localizar a causa; vou descrever o comportamento esperado e o erro.",
  },
  {
    icon: Globe2,
    title: "Consultar documentação",
    detail: "Especificações e fontes oficiais",
    prompt:
      "Leia as especificações e a stack deste projeto e consulte a documentação oficial relevante para orientar o desenvolvimento.",
  },
];

export function App() {
  const [state, setState] = useState<Snapshot>(structuredClone(emptySnapshot));
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<RequestImage[]>([]);
  const [pasting, setPasting] = useState(false);
  const [sendingDraft, setSendingDraft] = useState(false);
  const imageEpoch = useRef(0);
  const pasteInProgress = useRef(false);
  const sendInProgress = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const clearImages = useCallback(() => {
    imageEpoch.current++;
    pasteInProgress.current = false;
    setPasting(false);
    setImages([]);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [menu, setMenu] = useState<"history" | "account" | null>(null);
  const [windowsDialog, setWindowsDialog] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [browserFocused, setBrowserFocused] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const revision = useRef(0);
  const bridge = window.stag;
  useEffect(clearImages, [clearImages, state.project?.path, state.account?.email]);
  useEffect(() => {
    if (state.approvals.length) setBrowserFocused(false);
  }, [state.approvals.length]);

  useEffect(() => {
    if (!bridge) return;
    // A snapshot event may arrive before the initial IPC response.
    const before = revision.current;
    const off = bridge.onSnapshot((snapshot) => {
      revision.current++;
      setState(snapshot);
    });
    void bridge.getSnapshot().then((snapshot) => {
      if (revision.current === before) setState(snapshot);
    });
    return off;
  }, [bridge]);
  const run = useCallback(
    async (action: Action): Promise<boolean> => {
      if (!bridge) {
        setError("Abra o aplicativo desktop para conectar sua conta e acessar o projeto.");
        return false;
      }
      setError(null);
      setPending(true);
      try {
        const before = stateRef.current;
        const next = await bridge.request(action);
        if (["newChat", "resume", "logout"].includes(action.type)) {
          clearImages();
          setDraft("");
        } else if (
          (action.type === "preferences" && before.mode !== next.mode) ||
          (action.type === "selectProject" &&
            (before.project?.path !== next.project?.path ||
              before.threadId !== next.threadId ||
              before.mode !== next.mode))
        )
          clearImages();
        return true;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
            : "Não foi possível concluir a ação.",
        );
        return false;
      } finally {
        setPending(false);
      }
    },
    [bridge, clearImages],
  );
  const canSend =
    (!!draft.trim() || images.length > 0) &&
    !!state.account &&
    !!state.project &&
    !!state.model &&
    state.connection === "ready" &&
    !state.busy &&
    !pending &&
    !pasting &&
    !sendingDraft;
  async function send() {
    if (!canSend || pasteInProgress.current || sendInProgress.current) return;
    sendInProgress.current = true;
    setSendingDraft(true);
    const text = draft.trim();
    setAtBottom(true);
    if (await run({ type: "send", text, ...(images.length ? { images } : {}) })) {
      setDraft("");
      clearImages();
    }
    sendInProgress.current = false;
    setSendingDraft(false);
    input.current?.focus();
  }
  async function pasteImages(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return; // Normal text paste remains the textarea's native behavior.
    event.preventDefault();
    if (pasteInProgress.current || sendInProgress.current || pending) return;
    setError(null);
    if (images.length + files.length > maxRequestImages) {
      setError("Envie no máximo 4 imagens por mensagem.");
      return;
    }
    if (
      files.reduce(
        (size, file) => size + file.size,
        images.reduce((size, image) => size + requestImageBytes(image), 0),
      ) > maxRequestImageBytes
    ) {
      setError("As imagens devem somar no máximo 4 MB por mensagem.");
      return;
    }
    const epoch = imageEpoch.current;
    pasteInProgress.current = true;
    setPasting(true);
    try {
      const pasted = await Promise.all(files.map(readPastedImage));
      if (epoch !== imageEpoch.current) return;
      const result = requestImagesSchema.safeParse([...images, ...pasted]);
      if (!result.success) throw new Error(result.error.issues[0].message);
      setImages(result.data);
    } catch (err) {
      if (epoch === imageEpoch.current)
        setError(err instanceof Error ? err.message : "Não foi possível colar a imagem.");
    } finally {
      if (epoch === imageEpoch.current) {
        pasteInProgress.current = false;
        setPasting(false);
      }
    }
  }
  useEffect(() => {
    if (atBottom && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [state.items, state.plan, state.busy, atBottom]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        if (!state.busy && !pending) {
          void run({ type: "newChat" });
        }
      }
      if (event.key === "Escape") {
        setMenu(null);
        setWindowsDialog(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, state.busy, pending]);
  const chosenModel = state.models.find((m) => m.model === state.model);
  const disabledContext = state.busy || pending;
  const visibleError = error || state.error;
  const connectionLabel =
    state.connection === "ready"
      ? "Conectado"
      : state.connection === "connecting"
        ? "Conectando"
        : state.connection === "error"
          ? "Desconectado"
          : "Local";

  return (
    <main
      className={`workspace ${state.browser.available && state.browser.visible ? "browser-open" : ""} ${browserFocused && state.browser.visible ? "browser-focused" : ""}`}
    >
      <div className="app-shell">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark">
              <Sparkles size={17} strokeWidth={1.7} />
            </span>
            <span>STAG</span>
            <span className="brand-divider" />
            <span className="brand-caption">seu assistente</span>
          </div>
          <div className="header-actions">
            {state.browser.available && (
              <button
                className="icon-button"
                aria-label="Mostrar navegador"
                title="Navegador ao lado da conversa"
                onClick={() => {
                  if (!state.browser.visible)
                    void run({ type: "browserVisibility", visible: true });
                  setBrowserFocused(true);
                }}
              >
                <Globe2 size={18} />
              </button>
            )}
            <button
              className={`icon-button ${menu === "history" ? "selected" : ""}`}
              title="Histórico"
              aria-label="Histórico de conversas"
              aria-expanded={menu === "history"}
              onClick={() => setMenu(menu === "history" ? null : "history")}
            >
              <History size={18} />
            </button>
            <button
              className="icon-button"
              title="Nova conversa · Ctrl+N"
              aria-label="Nova conversa"
              disabled={disabledContext}
              onClick={() => {
                void run({ type: "newChat" });
              }}
            >
              <Plus size={19} />
            </button>
            <button
              className={`icon-button ${menu === "account" ? "selected" : ""}`}
              title="Conta e conexão"
              aria-label="Conta e conexão"
              aria-expanded={menu === "account"}
              onClick={() => setMenu(menu === "account" ? null : "account")}
            >
              <MoreHorizontal size={20} />
            </button>
          </div>
        </header>
        <div className="context-bar">
          <button
            className="project-button"
            disabled={disabledContext}
            onClick={() => void run({ type: "selectProject" })}
            title={state.project?.path || "Selecionar pasta do projeto"}
          >
            <FolderOpen size={15} />
            <span>{state.project?.name || "Selecionar projeto"}</span>
            <ChevronDown size={12} />
          </button>
          <span className="connection" title={state.account?.email || "Codex App Server local"}>
            <span
              className={`status-dot ${state.connection === "ready" ? "online" : state.connection === "connecting" ? "connecting" : ""}`}
            />
            {connectionLabel}
          </span>
        </div>
        {menu && (
          <>
            <button
              className="menu-backdrop"
              aria-label="Fechar menu"
              onClick={() => setMenu(null)}
            />
            <section className="popover" aria-label={menu === "history" ? "Histórico" : "Conta"}>
              {menu === "history" ? (
                <>
                  <div className="popover-heading">CONVERSAS DO PROJETO</div>
                  {!state.threads.length ? (
                    <p className="muted small">
                      Suas conversas aparecem aqui depois da primeira tarefa.
                    </p>
                  ) : (
                    <div className="history-list">
                      {state.threads.map((thread) => (
                        <button
                          key={thread.id}
                          disabled={disabledContext}
                          className={`history-row ${state.threadId === thread.id ? "active" : ""}`}
                          onClick={async () => {
                            if (await run({ type: "resume", threadId: thread.id })) setMenu(null);
                          }}
                        >
                          <History size={15} />
                          <span>{thread.title}</span>
                          {state.threadId === thread.id && <Check size={14} />}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="popover-heading">CONTA E CONEXÃO</div>
                  <p className="account-email">
                    {state.account?.email || "Nenhuma conta conectada"}
                  </p>
                  <p className="muted small">
                    {state.account
                      ? `ChatGPT${state.account.plan ? ` · ${state.account.plan}` : ""}`
                      : "Entre com a sua conta do ChatGPT."}
                  </p>
                  <button
                    className="menu-row"
                    disabled={disabledContext}
                    onClick={() => void run({ type: "connect" })}
                  >
                    <RefreshCw size={15} />
                    Reconectar Codex
                  </button>
                  {state.account && (
                    <button
                      className="menu-row"
                      disabled={disabledContext}
                      onClick={() => void run({ type: "logout" })}
                    >
                      <LogOut size={15} />
                      Sair da conta
                    </button>
                  )}
                </>
              )}
            </section>
          </>
        )}
        {!bridge && (
          <div className="browser-note">
            <Monitor size={15} />
            <span>Prévia da interface. Abra o STAG desktop para usar seu assistente.</span>
          </div>
        )}
        <div
          ref={scroll}
          className="conversation"
          role="log"
          aria-label="Conversa com o assistente"
          aria-live="polite"
          onScroll={() => {
            const el = scroll.current;
            if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          {!state.items.length ? (
            <section className="welcome">
              <div className="welcome-symbol">
                <Sparkles size={30} strokeWidth={1.25} />
              </div>
              <div className="eyebrow">UM POUCO MENOS DE ATRITO</div>
              <h1>
                Do que vamos
                <br />
                cuidar hoje?
              </h1>
              <p className="welcome-description">
                Arquitetura, programação e regras de negócio.
                <br />
                Engenharia de sistemas ao seu lado.
              </p>
              {!state.account ? (
                <div className="onboarding">
                  <button
                    className="primary-button"
                    disabled={pending || state.loginPending || state.connection === "connecting"}
                    onClick={() => void run({ type: "login" })}
                  >
                    <span className="login-symbol">
                      <Sparkles size={16} />
                    </span>
                    {state.loginPending ? "Continue no navegador…" : "Entrar com ChatGPT"}
                    <ArrowUp size={15} className="diagonal-arrow" />
                  </button>
                  {state.loginPending ? (
                    <button
                      className="text-button"
                      onClick={() => void run({ type: "cancelLogin" })}
                    >
                      Cancelar login
                    </button>
                  ) : (
                    <span className="onboarding-note">
                      Sua conta, seus modelos. Sem chave de API.
                    </span>
                  )}
                </div>
              ) : !state.project ? (
                <button
                  className="primary-button"
                  disabled={pending}
                  onClick={() => void run({ type: "selectProject" })}
                >
                  <Folder size={17} />
                  Escolher meu projeto
                </button>
              ) : (
                <div className="ready-note">
                  <ShieldCheck size={14} />
                  {state.project.name} está no contexto
                </div>
              )}
              <div className="suggestions">
                {suggestions.map((suggestion) => (
                  <button
                    className="suggestion"
                    key={suggestion.title}
                    onClick={() => {
                      setDraft(suggestion.prompt);
                      input.current?.focus();
                    }}
                  >
                    <suggestion.icon size={17} strokeWidth={1.6} />
                    <span>
                      <strong>{suggestion.title}</strong>
                      <small>{suggestion.detail}</small>
                    </span>
                    <ArrowUp size={14} className="diagonal-arrow" />
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="messages">
              {state.items.map((item) => (
                <Message
                  key={item.id}
                  item={item}
                  openLink={(url) => void run({ type: "openLink", url })}
                />
              ))}
              {state.plan.length > 0 && (
                <details className="plan-panel" open={state.busy}>
                  <summary>
                    <CheckCheck size={15} />
                    Plano de execução
                    <span>
                      {state.plan.filter((p) => p.status === "completed").length}/
                      {state.plan.length}
                    </span>
                  </summary>
                  <ol>
                    {state.plan.map((step, i) => (
                      <li className={step.status} key={`${i}-${step.step}`}>
                        <span>{step.status === "completed" ? <Check size={12} /> : i + 1}</span>
                        {step.step}
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {state.diff && (
                <details className="tool-item">
                  <summary>
                    <FileCode2 size={15} />
                    Alterações desta execução
                  </summary>
                  <pre>{state.diff}</pre>
                </details>
              )}
              {state.busy && (
                <div className="working" role="status">
                  <span className="working-pulse" />
                  Assistente trabalhando<span className="working-ellipsis">…</span>
                </div>
              )}
            </div>
          )}
        </div>
        {!atBottom && state.items.length > 0 && (
          <button
            className="scroll-bottom icon-button"
            aria-label="Ir para a última mensagem"
            onClick={() => setAtBottom(true)}
          >
            <ArrowDown size={17} />
          </button>
        )}
        <div className="bottom-area">
          {visibleError && (
            <div className="error-banner" role="alert">
              <span>{visibleError}</span>
              {state.connection === "error" && (
                <button
                  className="text-button"
                  disabled={pending}
                  onClick={() => void run({ type: "connect" })}
                >
                  Reconectar
                </button>
              )}
              <button
                className="icon-button"
                aria-label="Fechar aviso"
                onClick={() => {
                  setError(null);
                  if (state.error) setState({ ...state, error: null });
                }}
              >
                <X size={14} />
              </button>
            </div>
          )}
          {state.approvals.length > 0 && (
            <ApprovalCard
              key={state.approvals[0].id}
              approval={state.approvals[0]}
              count={state.approvals.length}
              pending={pending}
              answer={(action) => run(action)}
            />
          )}
          {state.platform === "win32" && (
            <section className="desktop-access" aria-label="Controle do desktop">
              <span className={state.mode === "windows" ? "desktop-authorized" : ""}>
                <Monitor size={14} />
                {state.mode === "windows"
                  ? "Desktop autorizado · Postman, IntelliJ e VS Code"
                  : "Desktop · Postman, IntelliJ e VS Code"}
              </span>
              <button
                className="text-button"
                disabled={disabledContext || !state.account || !state.project}
                onClick={() => {
                  if (state.mode === "windows") void run({ type: "preferences", mode: "project" });
                  else setWindowsDialog(true);
                }}
              >
                {state.mode === "windows" ? "Revogar acesso" : "Autorizar desktop"}
              </button>
            </section>
          )}
          <section className="composer" aria-label="Escrever mensagem">
            <ImageStrip
              images={images}
              disabled={pasting || sendingDraft}
              remove={(index) => setImages(images.filter((_, imageIndex) => imageIndex !== index))}
            />
            <textarea
              ref={input}
              aria-label="Mensagem para o assistente"
              placeholder="Descreva uma tarefa, uma ideia ou um problema…"
              value={draft}
              rows={3}
              disabled={sendingDraft}
              onPaste={(event) => void pasteImages(event)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="paste-hint" role="status">
              {pasting
                ? "Preparando imagem…"
                : "Cole imagens com Ctrl+V · até 4 imagens, 4 MB no total"}
            </div>
            <div className="composer-controls">
              <button
                className="attach-button icon-button"
                aria-label="Selecionar pasta do projeto"
                title="Selecionar pasta e autorizar leitura e escrita nela e nas subpastas"
                disabled={disabledContext}
                onClick={() => void run({ type: "selectProject" })}
              >
                <Plus size={20} />
              </button>
              <div className="model-controls">
                <label className="select-wrap model-select">
                  <span className="sr-only">Modelo</span>
                  <select
                    aria-label="Modelo"
                    disabled={!state.models.length || disabledContext}
                    value={state.model}
                    onChange={(e) => void run({ type: "preferences", model: e.target.value })}
                  >
                    {!state.models.length && <option value="">Modelo da conta</option>}
                    {state.models.map((model) => (
                      <option key={model.id} value={model.model}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
                <label className="select-wrap effort-select">
                  <span className="sr-only">Esforço</span>
                  <select
                    aria-label="Esforço"
                    disabled={!chosenModel || disabledContext}
                    value={state.effort}
                    onChange={(e) => void run({ type: "preferences", effort: e.target.value })}
                  >
                    {!chosenModel && <option value="">Esforço</option>}
                    {chosenModel?.supportedReasoningEfforts.map((effort) => (
                      <option key={effort.reasoningEffort} value={effort.reasoningEffort}>
                        {effortLabels[effort.reasoningEffort] || effort.reasoningEffort}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={12} />
                </label>
              </div>
              {state.busy ? (
                <button
                  className="send-button stopping"
                  aria-label="Parar execução"
                  onClick={() => void run({ type: "stop" })}
                >
                  <Square size={13} fill="currentColor" />
                </button>
              ) : (
                <button
                  className="send-button"
                  aria-label="Enviar mensagem"
                  disabled={!canSend}
                  onClick={() => void send()}
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </section>
          <footer className="footer">
            <label
              className={`mode-select ${state.mode === "windows" ? "windows-mode" : ""}`}
              title={
                state.mode === "read"
                  ? "Somente leitura da pasta e subpastas"
                  : state.mode === "project"
                    ? "Leitura e escrita autorizadas na pasta e subpastas; confirmação nos pontos críticos"
                    : "Desktop autorizado nesta conversa; confirmação nos pontos críticos"
              }
            >
              <ShieldCheck size={12} />
              <span className="sr-only">Acesso</span>
              <select
                aria-label="Acesso"
                value={state.mode}
                disabled={disabledContext}
                onChange={(e) => {
                  if (e.target.value === "windows") setWindowsDialog(true);
                  else
                    void run({ type: "preferences", mode: e.target.value as "read" | "project" });
                }}
              >
                <option value="read">{modeLabels.read}</option>
                <option value="project">{modeLabels.project}</option>
                <option value="windows" disabled={state.platform !== "win32"}>
                  {modeLabels.windows}
                </option>
              </select>
              <ChevronDown size={10} />
            </label>
            {state.metrics.totalTokens > 0 ? (
              <span
                className="metrics"
                title={`${state.metrics.requests} chamadas locais · ${state.metrics.failures} falhas`}
              >
                {state.metrics.totalTokens.toLocaleString("pt-BR")} tokens
                {state.metrics.elapsedMs > 0
                  ? ` · ${(state.metrics.elapsedMs / 1000).toFixed(1)}s`
                  : ""}
              </span>
            ) : (
              <span className="footer-hint">
                Enter para enviar<span> · Shift+Enter para nova linha</span>
              </span>
            )}
            <span className="local-label">
              <span className="tiny-dot" />
              local
            </span>
          </footer>
        </div>
        {windowsDialog && (
          <div className="modal-overlay" role="presentation">
            <section
              className="modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="windows-title"
            >
              <div className="modal-icon">
                <Monitor size={22} />
              </div>
              <h2 id="windows-title">Trabalhar no Windows</h2>
              <p>
                O STAG poderá controlar somente Postman, IntelliJ IDEA e Visual Studio Code pelo
                desktop, com capturas apenas da janela escolhida, mouse e teclado. Outros programas
                e atalhos globais ficam bloqueados, mesmo com aprovação. Páginas web usam o
                navegador integrado, autorizado separadamente. Capturas e edição local rotineiras
                seguem sem novas permissões. Exclusão, envio externo, publicação, pagamentos,
                credenciais e mudanças no sistema pedem confirmação, assim como interações sem
                contexto suficiente. Capturas e títulos dessas janelas são enviados ao ChatGPT para
                realizar a tarefa.
              </p>
              <p className="muted small">
                A mudança inicia uma nova conversa. Seu projeto continua selecionado.
              </p>
              <div className="approval-actions">
                <button
                  className="secondary-button"
                  autoFocus
                  disabled={pending}
                  onClick={() => setWindowsDialog(false)}
                >
                  Cancelar
                </button>
                <button
                  className="primary-button"
                  disabled={pending}
                  onClick={async () => {
                    if (await run({ type: "preferences", mode: "windows", windowsConsent: true }))
                      setWindowsDialog(false);
                  }}
                >
                  Continuar
                </button>
              </div>
            </section>
          </div>
        )}
      </div>
      {state.browser.available && state.browser.visible && (
        <BrowserPane
          state={state.browser}
          busy={state.busy}
          pending={pending}
          run={run}
          backToChat={() => setBrowserFocused(false)}
        />
      )}
    </main>
  );
}

function Message({ item, openLink }: { item: ChatItem; openLink: (url: string) => void }) {
  const [copied, setCopied] = useState(false);
  if (item.kind === "user")
    return (
      <div className="user-message">
        <ImageStrip images={item.images || []} />
        <div>{item.text}</div>
      </div>
    );
  if (item.kind === "assistant")
    return (
      <article
        className={`assistant-message ${item.phase === "commentary" ? "commentary-message" : ""}`}
      >
        <div className="assistant-label">
          <Sparkles size={14} strokeWidth={1.6} />
          <span>STAG</span>
          {item.phase === "commentary" && <small>em andamento</small>}
        </div>
        <div className="markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    if (href) openLink(href);
                  }}
                >
                  {children}
                </a>
              ),
              img: ({ alt }) => <span className="image-alt">{alt || "Imagem citada"}</span>,
            }}
          >
            {item.text}
          </Markdown>
        </div>
        {item.text && item.phase !== "commentary" && (
          <button
            className="copy-message"
            aria-label="Copiar resposta"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(item.text);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copiado" : "Copiar"}
          </button>
        )}
      </article>
    );
  if (item.kind === "status")
    return (
      <div className="status-item">
        <Check size={13} />
        {item.text}
        {item.status && (
          <span>
            {item.status === "inProgress"
              ? "em andamento"
              : item.status === "completed"
                ? "concluído"
                : item.status === "failed"
                  ? "falhou"
                  : item.status}
          </span>
        )}
      </div>
    );
  const Icon = item.kind === "command" ? Terminal : item.kind === "file" ? FileCode2 : Globe2;
  return (
    <details className="tool-item">
      <summary>
        <Icon size={15} />
        <span>{item.kind === "file" ? "Arquivos alterados" : item.text}</span>
        {item.status && (
          <small>
            {item.status === "inProgress"
              ? "executando"
              : item.status === "completed"
                ? "concluído"
                : item.status === "failed"
                  ? "falhou"
                  : item.status}
          </small>
        )}
        <ChevronDown size={13} />
      </summary>
      {item.kind === "file" && <div className="tool-paths">{item.text}</div>}
      {item.output && <pre>{item.output}</pre>}
    </details>
  );
}

function ImageStrip({
  images,
  remove,
  disabled = false,
}: {
  images: RequestImage[];
  remove?: (index: number) => void;
  disabled?: boolean;
}) {
  if (!images.length) return null;
  return (
    <div
      className={`request-images ${remove ? "pending-images" : "sent-images"}`}
      aria-label="Imagens anexadas"
    >
      {images.map((image, index) => (
        <figure key={index}>
          <img src={image.dataUrl} alt={`Imagem anexada ${index + 1}`} />
          {remove && (
            <button
              className="icon-button remove-image"
              aria-label={`Remover imagem ${index + 1}`}
              title="Remover imagem"
              disabled={disabled}
              onClick={() => remove(index)}
            >
              <X size={13} />
            </button>
          )}
        </figure>
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  count,
  pending,
  answer,
}: {
  approval: Approval;
  count: number;
  pending: boolean;
  answer: (action: Extract<Action, { type: "answer" }>) => Promise<boolean>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <section className="approval-card" aria-label="Solicitação do assistente">
      <div className="approval-title">
        <ShieldCheck size={16} />
        <strong>{approval.title}</strong>
        {count > 1 && <small>1 de {count}</small>}
      </div>
      {approval.detail && <pre className="approval-detail">{approval.detail}</pre>}
      {approval.questions?.map((q) => (
        <label className="question" key={q.id}>
          <span>{q.question}</span>
          {q.options.length > 0 && (
            <select
              aria-label={q.question}
              value={answers[q.id] || ""}
              onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            >
              <option value="">Escolha ou escreva abaixo</option>
              {q.options.map((o) => (
                <option key={o.label} value={o.label}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <input
            aria-label={`Resposta: ${q.question}`}
            type={q.isSecret ? "password" : "text"}
            value={answers[q.id] || ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            placeholder="Sua resposta"
          />
        </label>
      ))}
      <div className="approval-actions">
        {approval.kind === "questions" ? (
          <button
            className="primary-button"
            disabled={pending || !approval.questions?.every((q) => answers[q.id]?.trim())}
            onClick={() => void answer({ type: "answer", id: approval.id, answers })}
          >
            Responder
          </button>
        ) : (
          <>
            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => void answer({ type: "answer", id: approval.id, accept: false })}
            >
              Recusar
            </button>
            <button
              className="primary-button"
              disabled={pending}
              onClick={() => void answer({ type: "answer", id: approval.id, accept: true })}
            >
              Permitir esta ação
            </button>
          </>
        )}
      </div>
    </section>
  );
}

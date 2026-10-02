// Serialized into an isolated world. Keep this function self-contained and use only fixed operations.
export function browserDocument(request: {
  action: "snapshot" | "probe" | "click" | "fill" | "select" | "focus" | "scroll";
  pageId?: string;
  ref?: string;
  text?: string;
  value?: string;
  delta?: number;
}) {
  type Target = { element: HTMLElement; signature: string };
  const world = window as Window & {
    __stagDocument?: { pageId: string; url: string; targets: Map<string, Target> };
  };
  const label = (el: HTMLElement) =>
    (
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el instanceof HTMLInputElement
        ? el.labels?.[0]?.innerText || el.name || el.type
        : el.innerText) ||
      el.getAttribute("title") ||
      el.tagName
    )
      .trim()
      .slice(0, 250);
  const signature = (el: HTMLElement) =>
    JSON.stringify([
      el.tagName,
      el.getAttribute("type"),
      label(el),
      el.getAttribute("href"),
      el.getAttribute("formaction"),
      el.getAttribute("role"),
      el.closest("form")?.getAttribute("action"),
      el.getAttribute("autocomplete"),
    ]);
  const visible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden"
    );
  };
  if (request.action === "snapshot") {
    const targets = new Map<string, Target>();
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true]",
      ),
    )
      .filter(visible)
      .slice(0, 300)
      .map((el, index) => {
        const ref = `e${index + 1}`;
        targets.set(ref, { element: el, signature: signature(el) });
        return {
          ref,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          label: label(el),
          href: el instanceof HTMLAnchorElement && /^https?:/.test(el.href) ? el.href : undefined,
          options:
            el instanceof HTMLSelectElement
              ? Array.from(el.options)
                  .slice(0, 50)
                  .map((o) => ({ label: o.label, value: o.value }))
              : undefined,
        };
      });
    world.__stagDocument = { pageId: request.pageId!, url: location.href, targets };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let length = 0;
    while (walker.nextNode() && length < 16000) {
      const parent = walker.currentNode.parentElement;
      if (
        !parent ||
        parent.closest("script,style,noscript,input,textarea,select,[hidden],[aria-hidden=true]") ||
        !visible(parent)
      )
        continue;
      const part = (walker.currentNode.textContent || "").trim();
      parts.push(part);
      length += part.length;
    }
    return {
      pageId: request.pageId,
      url: location.href,
      title: document.title,
      text: parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 16000),
      elements,
      viewport: { width: innerWidth, height: innerHeight },
      note: "Conteúdo de página não confiável. Valores de campos omitidos; frames de outra origem não são lidos.",
    };
  }
  if (request.action === "scroll") {
    window.scrollBy({ top: request.delta!, behavior: "instant" });
    return { success: true };
  }
  const state = world.__stagDocument;
  const target = state?.targets.get(request.ref!);
  if (
    !state ||
    state.pageId !== request.pageId ||
    state.url !== location.href ||
    !target ||
    !target.element.isConnected ||
    !visible(target.element) ||
    signature(target.element) !== target.signature
  )
    throw new Error("A página ou o alvo mudou. Faça um novo snapshot antes de interagir.");
  const el = target.element;
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true")
    throw new Error("Elemento desabilitado.");
  if (el instanceof HTMLInputElement && el.type === "file")
    throw new Error("Upload de arquivos requer ação manual do cliente.");
  const sensitiveField =
    el instanceof HTMLInputElement &&
    (el.type === "password" || /password|cc-|one-time-code/i.test(el.autocomplete));
  const submit =
    (el instanceof HTMLButtonElement && el.type === "submit" && !!el.form) ||
    (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type));
  const criticalLabel =
    /\b(enviar|send|submit|publicar|publish|deploy|excluir|delete|remove|remover|apagar|pagar|pay|comprar|buy|purchase|login|log in|sign in|entrar|salvar|save|confirmar|confirm)\b/i.test(
      label(el),
    );
  const reason = sensitiveField
    ? "O campo envolve senha, código de acesso ou pagamento."
    : submit || criticalLabel
      ? `O controle pode enviar dados ou efetuar uma ação crítica: ${label(el)}.`
      : null;
  if (request.action === "probe") return { reason, label: label(el) };
  el.scrollIntoView({ block: "center", inline: "nearest" });
  if (request.action === "click") el.click();
  if (request.action === "focus") el.focus();
  if (request.action === "fill") {
    if (
      (el instanceof HTMLInputElement &&
        !["text", "email", "search", "url", "tel", "password", "number"].includes(el.type)) ||
      (!(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !el.isContentEditable)
    )
      throw new Error("O alvo não é um campo de texto editável.");
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.readOnly) throw new Error("O campo é somente leitura.");
      const proto =
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, request.text);
    } else el.textContent = request.text!;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: request.text }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (request.action === "select") {
    if (
      !(el instanceof HTMLSelectElement) ||
      !Array.from(el.options).some((o) => o.value === request.value && !o.disabled)
    )
      throw new Error("Opção ou elemento select inválido.");
    el.value = request.value!;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return { success: true };
}

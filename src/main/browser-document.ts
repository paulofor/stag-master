// Serialized into an isolated world. Keep this function self-contained and use only fixed operations.
export function browserDocument(request: {
  action: "snapshot" | "probe" | "download" | "click" | "fill" | "select" | "focus" | "scroll";
  pageId?: string;
  ref?: string;
  text?: string;
  value?: string;
  label?: string;
  index?: number;
  operation?: "select";
  delta?: number;
}) {
  type Target = { element: HTMLElement; signature: string };
  const world = window as Window & {
    __stagDocument?: { pageId: string; url: string; targets: Map<string, Target> };
  };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const label = (el: HTMLElement) =>
    (
      (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ")
        .trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el instanceof HTMLInputElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
        ? el.labels?.[0]?.innerText || el.name || el.type
        : el.getAttribute("role") === "combobox"
          ? ""
          : el.innerText) ||
      el.getAttribute("title") ||
      el.tagName
    )
      .trim()
      .slice(0, 250);
  const checkedState = (el: HTMLElement): boolean | "mixed" | undefined =>
    el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)
      ? el.indeterminate
        ? "mixed"
        : el.checked
      : el.matches('[role="checkbox"],[role="radio"],[role="switch"]') &&
          el.hasAttribute("aria-checked")
        ? el.getAttribute("aria-checked") === "mixed"
          ? "mixed"
          : el.getAttribute("aria-checked") === "true"
        : undefined;
  const signature = (el: HTMLElement) =>
    JSON.stringify([
      el.tagName,
      el.getAttribute("type"),
      label(el),
      el instanceof HTMLAnchorElement ? el.href : el.getAttribute("href"),
      el.getAttribute("download"),
      el.getAttribute("formaction"),
      el.getAttribute("role"),
      el.closest("form")?.getAttribute("action"),
      el.getAttribute("autocomplete"),
      el.getAttribute("aria-controls"),
      el.getAttribute("aria-owns"),
      el.getAttribute("aria-haspopup"),
      el.getAttribute("aria-readonly"),
      el.getAttribute("aria-disabled"),
      checkedState(el),
      el instanceof HTMLSelectElement
        ? [el.multiple, Array.from(el.options).map((o) => [o.label, o.value, unavailable(o)])]
        : null,
    ]);
  const unavailable = (el: HTMLElement) =>
    el.matches(":disabled") || !!el.closest('[aria-disabled="true"],[inert],[hidden]');
  const owners = (el: HTMLElement): HTMLElement[] => {
    const list = el.closest<HTMLElement>('[role="listbox"]');
    if (!list) return [];
    return [
      list,
      ...Array.from(
        document.querySelectorAll<HTMLElement>('[role="combobox"],[aria-haspopup="listbox"]'),
      ).filter(
        (combo) =>
          combo.contains(list) ||
          [combo.getAttribute("aria-controls"), combo.getAttribute("aria-owns")].some(
            (ids) => !!list.id && ids?.split(/\s+/).includes(list.id),
          ),
      ),
    ].filter((owner) => owner !== el);
  };
  const targetSignature = (el: HTMLElement) =>
    JSON.stringify([signature(el), owners(el).map(signature)]);
  const visible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden"
    );
  };
  if (request.action === "snapshot") {
    const targets = new Map<string, Target>();
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true],[role=combobox],[role=listbox],[role=option],[aria-haspopup=listbox],[role=checkbox],[role=radio],[role=switch]",
      ),
    )
      .filter(visible)
      .slice(0, 300);
    const refs = new Map(nodes.map((el, index) => [el, `e${index + 1}`]));
    const elements = nodes.map((el, index) => {
      const ref = `e${index + 1}`;
      targets.set(ref, { element: el, signature: targetSignature(el) });
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || "",
        label: label(el),
        role: el.getAttribute("role") || undefined,
        hasPopup: el.getAttribute("aria-haspopup") || undefined,
        expanded: el.hasAttribute("aria-expanded")
          ? el.getAttribute("aria-expanded") === "true"
          : undefined,
        disabled: unavailable(el),
        checked: checkedState(el),
        controlsRefs: (el.getAttribute("aria-controls") || el.getAttribute("aria-owns") || "")
          .split(/\s+/)
          .map((id) => refs.get(document.getElementById(id)!))
          .filter(Boolean),
        listboxRef: refs.get(el.closest<HTMLElement>('[role="listbox"]')!),
        href: el instanceof HTMLAnchorElement && /^https?:/.test(el.href) ? el.href : undefined,
        options:
          el instanceof HTMLSelectElement
            ? Array.from(el.options)
                .slice(0, 50)
                .map((o, index) => ({
                  label: normalize(o.label).slice(0, 500),
                  index,
                  disabled: unavailable(o),
                }))
            : undefined,
        optionCount: el instanceof HTMLSelectElement ? el.options.length : undefined,
        optionsTruncated: el instanceof HTMLSelectElement ? el.options.length > 50 : undefined,
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
    targetSignature(target.element) !== target.signature
  )
    throw new Error("A página ou o alvo mudou. Faça um novo snapshot antes de interagir.");
  const el = target.element;
  const related = [el, ...owners(el)];
  if (related.some(unavailable)) throw new Error("Elemento desabilitado.");
  if (related.some((node) => node.getAttribute("aria-readonly") === "true"))
    throw new Error("O campo é somente leitura.");
  if (el instanceof HTMLInputElement && el.type === "file")
    throw new Error("Upload de arquivos requer ação manual do cliente.");
  let option: HTMLOptionElement | undefined;
  if (request.action === "select" || request.operation === "select") {
    if (!(el instanceof HTMLSelectElement))
      throw new Error(
        "Select exige um combo nativo. Para combo personalizado, abra com click/ArrowDown, faça snapshot e clique no ref da option.",
      );
    if (el.multiple) throw new Error("Seleção múltipla requer ação manual do cliente.");
    const matches = Array.from(el.options).filter((o, index) =>
      request.index !== undefined
        ? index === request.index
        : request.label !== undefined
          ? normalize(o.label) === normalize(request.label)
          : o.value === request.value,
    );
    if (matches.length > 1)
      throw new Error("Opção ambígua. Use o index do snapshot para escolher exatamente uma opção.");
    option = matches[0];
    if (!option || unavailable(option))
      throw new Error("Opção inexistente ou desabilitada. Faça um novo snapshot.");
  }
  const sensitiveField = related.some(
    (node) =>
      (node instanceof HTMLInputElement && node.type === "password") ||
      /password|cc-|one-time-code/i.test(node.getAttribute("autocomplete") || ""),
  );
  const submit =
    (el instanceof HTMLButtonElement && el.type === "submit" && !!el.form) ||
    (el instanceof HTMLInputElement && ["submit", "image"].includes(el.type));
  const criticalLabel =
    /\b(enviar|send|submit|publicar|publish|deploy|excluir|delete|remove|remover|apagar|pagar|pay|comprar|buy|purchase|login|log in|sign in|entrar|salvar|save|confirmar|confirm)\b/i.test(
      [...related.map(label), option?.label || ""].join(" "),
    );
  const rememberLogin =
    /continuar conectado|manter conectado|permanecer conectado|lembrar|remember|stay (?:signed|logged) in|keep me (?:signed|logged) in/i.test(
      label(el),
    );
  const reason = sensitiveField
    ? "O campo envolve senha, código de acesso ou pagamento."
    : rememberLogin
      ? "O controle pode manter o login neste computador. Confirme essa preferência de acesso."
      : submit || criticalLabel
        ? "O controle ou a opção pode enviar dados ou efetuar uma ação crítica."
        : null;
  if (request.action === "probe") return { reason, label: label(el) };
  if (request.action === "download") {
    if (!(el instanceof HTMLAnchorElement) || !/^https?:/.test(el.href))
      throw new Error(
        "Download exige um link HTTP(S) do snapshot atual. Botões e URLs blob/data não são suportados.",
      );
    return { url: el.href };
  }
  el.scrollIntoView({ block: "center", inline: "nearest" });
  if (request.action === "click") {
    // Custom combos commonly open on mouse/pointer down, not on HTMLElement.click().
    if (el.matches('[role="combobox"],[role="option"],[aria-haspopup="listbox"]')) {
      const rect = el.getBoundingClientRect();
      const pointer = {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 0,
        clientX: rect.x + rect.width / 2,
        clientY: rect.y + rect.height / 2,
      };
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
        if (!el.isConnected || !visible(el)) return { success: true };
        if (targetSignature(el) !== target.signature)
          throw new Error("O alvo mudou durante a interação. Faça um novo snapshot.");
        const event = type.startsWith("pointer")
          ? new PointerEvent(type, {
              ...pointer,
              pointerId: 1,
              pointerType: "mouse",
              isPrimary: true,
              buttons: type.endsWith("down") ? 1 : 0,
            })
          : new MouseEvent(type, { ...pointer, buttons: type.endsWith("down") ? 1 : 0 });
        const allowed = el.dispatchEvent(event);
        if (type === "mousedown" && allowed && el.isConnected) el.focus({ preventScroll: true });
      }
      if (!el.isConnected || !visible(el)) return { success: true };
      if (targetSignature(el) !== target.signature)
        throw new Error("O alvo mudou durante a interação. Faça um novo snapshot.");
    }
    el.click();
  }
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
    const select = el as HTMLSelectElement;
    const index = option!.index;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex")!.set!.call(
      select,
      index,
    );
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (!select.isConnected || select.selectedIndex !== index || select.options[index] !== option)
      throw new Error(
        "A página não manteve a seleção. Faça um novo snapshot para conferir o resultado.",
      );
  }
  return { success: true };
}

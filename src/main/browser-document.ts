// Serialized into an isolated world. Keep this function self-contained and use only fixed operations.
export function browserDocument(request: {
  action: "snapshot" | "probe" | "download" | "click" | "fill" | "select" | "focus" | "scroll";
  pageId?: string;
  ref?: string;
  text?: string;
  value?: string;
  label?: string;
  index?: number;
  operation?: "select" | "fill";
  delta?: number;
  testOrigin?: string;
}) {
  type Target = { element: HTMLElement; signature: string };
  const world = window as Window & {
    __stagDocument?: { pageId: string; url: string; targets: Map<string, Target> };
  };
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  // PrimeNG Calendar 17 renders these choices as spans without an ARIA role.
  // Keep explicit DOM targets; no selectors or script supplied by the model.
  const calendarCells =
    ".p-datepicker .p-monthpicker-month,.p-datepicker .p-yearpicker-year,.p-datepicker .p-datepicker-calendar td > span";
  const calendarScope = (el: HTMLElement): HTMLElement | null =>
    el.closest<HTMLElement>(".p-datepicker") ||
    (el.closest<HTMLElement>('[role="dialog"]')?.querySelector('[role="grid"]')
      ? el.closest<HTMLElement>('[role="dialog"]')
      : el.closest<HTMLElement>('[role="grid"]'));
  const selectedState = (el: HTMLElement) =>
    el.hasAttribute("aria-selected")
      ? el.getAttribute("aria-selected") === "true"
      : el.matches(calendarCells)
        ? el.classList.contains("p-highlight")
        : undefined;
  const dateFormats: Record<string, { format: string; pattern: RegExp }> = {
    date: { format: "YYYY-MM-DD", pattern: /^\d{4}-\d{2}-\d{2}$/ },
    month: { format: "YYYY-MM", pattern: /^\d{4}-\d{2}$/ },
    "datetime-local": {
      format: "YYYY-MM-DDTHH:mm[:ss[.SSS]]",
      pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/,
    },
    time: { format: "HH:mm[:ss[.SSS]]", pattern: /^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/ },
    week: { format: "YYYY-Www", pattern: /^\d{4}-W\d{2}$/ },
  };
  const dateInfo = (el: HTMLElement) => {
    if (!(el instanceof HTMLInputElement) || !dateFormats[el.type]) return undefined;
    const { format, pattern } = dateFormats[el.type];
    return {
      format,
      min: pattern.test(el.min) ? el.min : undefined,
      max: pattern.test(el.max) ? el.max : undefined,
      step: /^(?:any|\d+(?:\.\d+)?)$/.test(el.step) ? el.step : undefined,
    };
  };
  const label = (el: HTMLElement) =>
    (
      (el.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.innerText || "")
        .join(" ")
        .trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      (el.matches(calendarCells)
        ? Array.from(el.childNodes)
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent || "")
            .join(" ")
            .trim()
        : "") ||
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
      el.getAttribute("readonly"),
      el.getAttribute("disabled"),
      el.getAttribute("aria-selected"),
      el.getAttribute("min"),
      el.getAttribute("max"),
      el.getAttribute("step"),
      el.getAttribute("required"),
      el.getAttribute("data-date"),
      selectedState(el),
      unavailable(el),
      checkedState(el),
      el instanceof HTMLSelectElement
        ? [el.multiple, Array.from(el.options).map((o) => [o.label, o.value, unavailable(o)])]
        : null,
    ]);
  const unavailable = (el: HTMLElement) =>
    el.matches(":disabled") ||
    !!el.closest('[aria-disabled="true"],[inert],[hidden]') ||
    (!!calendarScope(el) && !!el.closest(".p-disabled"));
  const owners = (el: HTMLElement): HTMLElement[] => {
    const list = el.closest<HTMLElement>('[role="listbox"]');
    const calendar = calendarScope(el);
    const container = calendar || list;
    if (!container) return [];
    return [
      container,
      ...Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="combobox"],[aria-haspopup="listbox"],[aria-haspopup="dialog"],[aria-haspopup="grid"]',
        ),
      ).filter(
        (combo) =>
          combo.contains(container) ||
          [combo.getAttribute("aria-controls"), combo.getAttribute("aria-owns")].some(
            (ids) => !!container.id && ids?.split(/\s+/).includes(container.id),
          ),
      ),
    ].filter((owner) => owner !== el);
  };
  const targetSignature = (el: HTMLElement) =>
    JSON.stringify([
      signature(el),
      owners(el).map(signature),
      // A month/day with the same label in another year/month is a different target.
      normalize(calendarScope(el)?.innerText || "").slice(0, 4000),
    ]);
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
        "a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[contenteditable=true],[role=combobox],[role=listbox],[role=option],[aria-haspopup=listbox],[role=checkbox],[role=radio],[role=switch],[role=grid],[role=gridcell],[role=dialog],[tabindex]:not(input[type=hidden])," +
          calendarCells,
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
        selected: selectedState(el),
        otherMonth: el.matches(".p-datepicker .p-datepicker-calendar td > span")
          ? !!el.closest(".p-datepicker-other-month")
          : undefined,
        readOnly:
          el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
            ? el.readOnly
            : el.getAttribute("aria-readonly") === "true",
        date: dateInfo(el),
        calendarRef: refs.get(calendarScope(el)!),
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
  let dateValue: string | undefined;
  if (request.action === "fill" || request.operation === "fill") {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.readOnly) throw new Error("O campo é somente leitura. Use o calendário disponível.");
    }
    if (el instanceof HTMLInputElement && dateFormats[el.type]) {
      const info = dateFormats[el.type];
      if (request.text !== "" && !info.pattern.test(request.text || ""))
        throw new Error(`Formato de data inválido. Use ${info.format}, sem fuso horário.`);
      // Check a detached native control before mutating the live form or emitting events.
      const candidate = el.cloneNode(false) as HTMLInputElement;
      candidate.value = request.text!;
      if ((request.text !== "" && !candidate.value) || !candidate.validity.valid)
        throw new Error("Data/hora inválida ou fora dos limites min/max/step do campo.");
      dateValue = candidate.value;
    }
  }
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
  const form =
    related
      .map((node) => ("form" in node ? (node as HTMLInputElement).form : null))
      .find(Boolean) || el.closest("form");
  const protectedLabel =
    /\b(publicar|publish|deploy|pagar|pagamento|pay|payment|comprar|buy|purchase|checkout|login|log in|sign in|entrar|senha|password|token|credencial|credenciais|seguran[cç]a|security|permiss[oõ]es|permissions|configura[cç](?:[aã]o|[oõ]es)|settings)\b/i.test(
      [...related.map(label), option?.label || ""].join(" "),
    );
  const destinations = [
    ...related
      .filter((node) => node instanceof HTMLAnchorElement)
      .map((node) => (node as HTMLAnchorElement).href),
    ...(form ? [form.action] : []),
    ...related
      .filter((node) => node.hasAttribute("formaction"))
      .map((node) => node.getAttribute("formaction")!),
  ];
  const externalDestination = destinations.some((url) => {
    try {
      return new URL(url, location.href).origin !== location.origin;
    } catch {
      return true;
    }
  });
  const sensitiveForm = !!form?.querySelector(
    'input[type="password"], [autocomplete^="cc-"], [autocomplete="one-time-code"]',
  );
  const protectedInteraction =
    sensitiveField || sensitiveForm || rememberLogin || protectedLabel || externalDestination;
  const reason = sensitiveField
    ? "O campo envolve senha, código de acesso ou pagamento."
    : rememberLogin
      ? "O controle pode manter o login neste computador. Confirme essa preferência de acesso."
      : submit || criticalLabel
        ? "O controle ou a opção pode enviar dados ou efetuar uma ação crítica."
        : null;
  if (request.action === "probe") return { reason, protectedInteraction, label: label(el) };
  if (request.testOrigin && (location.origin !== request.testOrigin || protectedInteraction))
    throw new Error(
      "O alvo ou o efeito saiu da autorização de testes. Faça um novo snapshot e solicite confirmação específica.",
    );
  if (request.action === "download") {
    if (el instanceof HTMLAnchorElement && /^https?:/.test(el.href)) return { url: el.href };
    if (
      (el instanceof HTMLAnchorElement && /^(blob|data):/.test(el.href)) ||
      el instanceof HTMLButtonElement ||
      el.getAttribute("role") === "button" ||
      (el instanceof HTMLInputElement && ["button", "submit"].includes(el.type))
    )
      return { click: true };
    throw new Error("Download exige um link ou botão de exportação do snapshot atual.");
  }
  el.scrollIntoView({ block: "center", inline: "nearest" });
  if (request.action === "click") {
    // Custom combos commonly open on mouse/pointer down, not on HTMLElement.click().
    if (
      el.matches(
        '[role="combobox"]:not([aria-haspopup="dialog"]):not([aria-haspopup="grid"]),[role="option"],[aria-haspopup="listbox"]',
      )
    ) {
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
        !["text", "email", "search", "url", "tel", "password", "number"].includes(el.type) &&
        !dateFormats[el.type]) ||
      (!(el instanceof HTMLInputElement) &&
        !(el instanceof HTMLTextAreaElement) &&
        !el.isContentEditable)
    )
      throw new Error("O alvo não é um campo de texto editável.");
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.readOnly) throw new Error("O campo é somente leitura.");
      const proto =
        el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, dateValue ?? request.text);
    } else el.textContent = request.text!;
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: request.text }),
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (
      dateValue !== undefined &&
      (!el.isConnected || (el as HTMLInputElement).value !== dateValue)
    )
      throw new Error(
        "A página não manteve a data. Faça um novo snapshot para conferir o resultado.",
      );
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

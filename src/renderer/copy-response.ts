import { safeLink } from "../shared/validation";

// Rebuild the rendered Markdown with only document formatting. Never export the
// application's controls, arbitrary attributes/styles, or remote images.
const styles: Record<string, string> = {
  div: "font-family:Arial,sans-serif;font-size:11pt;line-height:1.5;color:#222222;",
  p: "margin:0 0 10pt;",
  h1: "font-size:20pt;font-weight:bold;margin:14pt 0 8pt;",
  h2: "font-size:17pt;font-weight:bold;margin:12pt 0 7pt;",
  h3: "font-size:14pt;font-weight:bold;margin:10pt 0 6pt;",
  h4: "font-size:12pt;font-weight:bold;",
  blockquote: "border-left:2pt solid #aaaaaa;padding-left:10pt;margin-left:0;",
  pre: "font-family:Consolas,monospace;font-size:10pt;white-space:pre-wrap;",
  code: "font-family:Consolas,monospace;font-size:10pt;",
  table: "border-collapse:collapse;margin:10pt 0;",
  th: "border:1pt solid #aaaaaa;padding:5pt;text-align:left;font-weight:bold;",
  td: "border:1pt solid #aaaaaa;padding:5pt;text-align:left;",
};
const allowedTags = new Set([
  ...Object.keys(styles),
  "span",
  "h5",
  "h6",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "br",
  "hr",
  "thead",
  "tbody",
  "tfoot",
  "tr",
]);

function documentNode(node: Node, document: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
  if (!(node instanceof HTMLElement)) return null;
  if (node.localName === "input" && node.getAttribute("type") === "checkbox") {
    const marker = document.createElement("span");
    marker.textContent = (node as HTMLInputElement).checked ? "☑" : "☐";
    return marker;
  }
  if (!allowedTags.has(node.localName)) return null;
  const result = document.createElement(node.localName);
  if (styles[node.localName]) result.setAttribute("style", styles[node.localName]);
  if (node.localName === "a") {
    try {
      result.setAttribute("href", safeLink(node.getAttribute("href") || ""));
    } catch {
      // Keep the label of links that cannot safely be exported.
    }
  }
  if (node.localName === "ol" && /^\d{1,9}$/.test(node.getAttribute("start") || ""))
    result.setAttribute("start", node.getAttribute("start")!);
  for (const child of node.childNodes) {
    const formatted = documentNode(child, document);
    if (formatted) result.append(formatted);
  }
  return result;
}

function plainText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || "";
    return /^\s*\n\s*$/.test(text) ? "" : text.replace(/\r?\n/g, " ");
  }
  if (!(node instanceof HTMLElement)) return "";
  if (node.localName === "pre") return `${node.textContent || ""}\n\n`;
  if (node.localName === "br") return "\n";
  if (node.localName === "hr") return "\n\n";
  if (node.localName === "tr")
    return `${Array.from(node.children)
      .map((cell) => plainText(cell).trim())
      .join("\t")}\n`;
  const text = Array.from(node.childNodes).map(plainText).join("");
  if (node.localName === "li") {
    const parent = node.parentElement!;
    const index = Array.from(parent.children).indexOf(node);
    const prefix =
      parent.localName === "ol" ? `${Number(parent.getAttribute("start") || 1) + index}.` : "•";
    let depth = 0;
    for (let ancestor = parent.parentElement; ancestor; ancestor = ancestor.parentElement)
      if (["ul", "ol"].includes(ancestor.localName)) depth++;
    return `${"  ".repeat(depth)}${prefix} ${text.trim()}\n`;
  }
  if (["ul", "ol"].includes(node.localName)) return `\n${text}\n`;
  if (["p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "table"].includes(node.localName))
    return `${text.trimEnd()}\n\n`;
  return text;
}

export function copyResponse(content: HTMLElement): void {
  const document = content.ownerDocument;
  const formatted = document.createElement("div");
  formatted.setAttribute("style", styles.div);
  for (const child of content.childNodes) {
    const node = documentNode(child, document);
    if (node) formatted.append(node);
  }
  const text = plainText(formatted).replace(/^\n+|\n+$/g, "");
  let written = false;
  const copy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    event.clipboardData.setData("text/html", formatted.outerHTML);
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    written = true;
  };
  // Chromium's user-initiated copy event works under the desktop's closed
  // permission policy. No clipboard read permission or native bridge is added.
  document.addEventListener("copy", copy);
  try {
    if (!document.execCommand("copy") || !written) throw new Error("Cópia indisponível.");
  } finally {
    document.removeEventListener("copy", copy);
  }
}

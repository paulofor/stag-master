import { describe, expect, it } from "vitest";
import {
  browserArguments,
  browserApproval,
  browserConfirmationReason,
  browserUrl,
} from "../../src/main/browser-tools";
import { actionSchema } from "../../src/shared/validation";

describe("contrato do navegador", () => {
  it("recusa protocolos locais, credenciais na URL e código arbitrário", () => {
    for (const url of [
      "file:///C:/private",
      "javascript:alert(1)",
      "data:text/html,test",
      "stag://app/",
      "https://user:pass@example.invalid/",
    ])
      expect(() => browserUrl(url)).toThrow();
    expect(browserUrl("http://127.0.0.1:1234/")).toBe("http://127.0.0.1:1234/");
    for (const args of [
      { action: "evaluate", code: "unsafe" },
      { action: "click", pageId: "id", ref: "input" },
      { action: "snapshot", cookies: true },
      { action: "press", pageId: "id", ref: "e1", key: "Control+Alt+Delete" },
      { action: "scroll", delta: 0 },
      { action: "click", pageId: "id", ref: "e1", risk: "unknown" },
    ])
      expect(browserArguments.safeParse(args).success).toBe(false);
  });
  it("leitura/rotina não pedem cards; cada efeito crítico ou incerto pede confirmação", () => {
    for (const args of [
      { action: "snapshot" },
      { action: "screenshot" },
      { action: "scroll", delta: 200 },
      {
        action: "navigate",
        url: "https://example.invalid/",
        risk: "routine",
        intent: "Ler documentação",
      },
      {
        action: "fill",
        pageId: "page",
        ref: "e1",
        text: "local",
        risk: "routine",
        intent: "Editar campo local",
      },
    ])
      expect(browserConfirmationReason(browserArguments.parse(args))).toBeNull();
    for (const args of [
      { action: "click", pageId: "page", ref: "e2" },
      { action: "click", pageId: "page", ref: "e2", risk: "critical", intent: "Excluir dado" },
      {
        action: "press",
        pageId: "page",
        ref: "e1",
        key: "Enter",
        risk: "routine",
        intent: "Confirmar",
      },
      {
        action: "press",
        pageId: "page",
        ref: "e1",
        key: "Delete",
        risk: "routine",
        intent: "Editar",
      },
      {
        action: "fill",
        pageId: "page",
        ref: "e1",
        text: "a\nb",
        risk: "routine",
        intent: "Preencher",
      },
    ])
      expect(browserConfirmationReason(browserArguments.parse(args))).toBeTruthy();
  });
  it("omite conteúdo de campo no card e valida limites IPC", () => {
    const args = browserArguments.parse({
      action: "fill",
      pageId: "page",
      ref: "e1",
      text: "SYNTHETIC_PRIVATE_FIELD",
      risk: "critical",
      intent: "Preencher credencial sintética",
    });
    expect(JSON.stringify(browserApproval(args, "Senha"))).not.toContain("SYNTHETIC_PRIVATE_FIELD");
    expect(
      actionSchema.safeParse({
        type: "browserBounds",
        bounds: { x: -1, y: 0, width: 100, height: 100 },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({ type: "browserConsent", allow: true, threadId: "other" }).success,
    ).toBe(false);
  });
});

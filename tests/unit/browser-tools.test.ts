import { describe, expect, it } from "vitest";
import {
  browserArguments,
  browserApproval,
  browserConfirmationReason,
  browserUrl,
  browserTool,
  browserCaptureCapability,
} from "../../src/main/browser-tools";
import {
  browserTestAction,
  browserOrigin,
  browserTestingCapability,
  browserTestingInstructions,
} from "../../src/main/browser-testing";
import { actionSchema } from "../../src/shared/validation";

describe("contrato do navegador", () => {
  it("distingue captura autorizada, falta de consentimento e histórico sem ferramenta", () => {
    expect(browserCaptureCapability(true, true).stag_browser_capture.value).toContain(
      "sem pedir autorização por captura",
    );
    expect(browserCaptureCapability(true, false).stag_browser_capture.value).toContain(
      "Autorizar navegador",
    );
    for (const authorized of [true, false]) {
      const value = browserCaptureCapability(false, authorized).stag_browser_capture.value;
      expect(value).toContain("nova conversa");
      expect(value).not.toContain("sem pedir autorização por captura");
    }
    for (const tab of ["documentation", "system"]) {
      const args = browserArguments.parse({ action: "screenshot", tab });
      expect(browserConfirmationReason(args)).toBeNull();
      for (const extra of [{ processId: 1 }, { pageId: "old" }, { path: "print.png" }])
        expect(browserArguments.safeParse({ ...args, ...extra }).success).toBe(false);
    }
  });
  it("aceita somente as duas abas em tools e IPC e identifica a aba na aprovação", () => {
    for (const tab of ["documentation", "system"] as const) {
      expect(browserArguments.parse({ action: "snapshot", tab }).tab).toBe(tab);
      expect(actionSchema.parse({ type: "browserTab", tab })).toEqual({ type: "browserTab", tab });
      const input = browserArguments.parse({
        action: "navigate",
        tab,
        url: "http://127.0.0.1:1234/",
        risk: "critical",
        intent: "Abrir página sintética",
      });
      expect(browserApproval(input, "Confirmar navegação").detail).toContain(
        tab === "system" ? "Aba: Sistema do projeto" : "Aba: Documentação",
      );
    }
    for (const tab of ["other", "", 1, "../../profile"]) {
      expect(browserArguments.safeParse({ action: "snapshot", tab }).success).toBe(false);
      expect(actionSchema.safeParse({ type: "browserTab", tab }).success).toBe(false);
      expect(
        actionSchema.safeParse({ type: "browserControl", control: { action: "reload", tab } })
          .success,
      ).toBe(false);
    }
    expect(
      actionSchema.safeParse({ type: "browserTab", tab: "system", processId: 1 }).success,
    ).toBe(false);
    expect(browserTool.inputSchema.properties.tab.enum).toEqual(["documentation", "system"]);
    expect(browserTool.description).toContain("pageId/ref só valem na aba");
  });
  it("seleciona por exatamente um texto, índice ou valor legado, sem ampliar outras operações", () => {
    for (const selection of [{ label: "Ambiente local" }, { index: 0 }, { value: "" }]) {
      const input = browserArguments.parse({
        action: "select",
        pageId: "page",
        ref: "e1",
        ...selection,
        risk: "routine",
        intent: "Escolher ambiente local",
      });
      expect(browserConfirmationReason(input)).toBeNull();
    }
    for (const selection of [
      {},
      { label: "" },
      { index: -1 },
      { index: 1.5 },
      { index: 10000 },
      { label: "a", value: "a" },
      { label: "a", index: 1 },
      { value: "a", index: 1 },
      { label: "a".repeat(501) },
      { value: "a".repeat(501) },
    ])
      expect(
        browserArguments.safeParse({ action: "select", pageId: "page", ref: "e1", ...selection })
          .success,
      ).toBe(false);
    expect(
      browserArguments.safeParse({ action: "click", pageId: "page", ref: "e1", label: "a" })
        .success,
    ).toBe(false);
    expect(browserTool.description).toContain("combos personalizados");
    expect(browserTool.description).toContain("faça novo snapshot");
    expect(browserTool.inputSchema.properties.label.maxLength).toBe(500);
  });
  it("confirma seleção incerta/crítica e omite opção e valor no card", () => {
    for (const choice of [
      { value: "SYNTHETIC_PRIVATE_VALUE" },
      { label: "SYNTHETIC_PRIVATE_LABEL" },
    ]) {
      const input = browserArguments.parse({
        action: "select",
        pageId: "page",
        ref: "e1",
        ...choice,
      });
      expect(browserConfirmationReason(input)).toBeTruthy();
      expect(JSON.stringify(browserApproval(input, "Confirmar opção crítica"))).not.toContain(
        "SYNTHETIC_PRIVATE",
      );
    }
  });
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

it("autorização de teste não pode vir do modelo, da URL ou de um risco incerto", () => {
  const origin = "https://test.invalid:8443";
  const action = browserArguments.parse({
    action: "press",
    tab: "system",
    pageId: "page",
    ref: "e1",
    key: "Enter",
    risk: "routine",
    intent: "Cadastrar registro sintético",
  });
  expect(browserTestAction(action, origin, origin + "/form")).toBe(true);
  expect(browserConfirmationReason(action, true)).toBeNull();
  expect(browserConfirmationReason(action)).toBeTruthy();
  for (const [args, grant, url] of [
    [{ ...action, tab: "documentation" }, origin, origin],
    [action, undefined, origin],
    [action, origin, "https://test.invalid:8444"],
    [{ ...action, risk: "critical" }, origin, origin],
    [{ ...action, intent: undefined }, origin, origin],
  ] as const)
    expect(browserTestAction(browserArguments.parse(args), grant, url)).toBe(false);
  expect(browserArguments.safeParse({ ...action, testOrigin: origin }).success).toBe(false);
  expect(browserArguments.safeParse({ action: "authorizeTesting", origin }).success).toBe(false);
  expect(browserOrigin("https://user:secret@test.invalid")).toBeUndefined();
  expect(browserOrigin("file:///project")).toBeUndefined();
  expect(browserTool.description).toContain(browserTestingInstructions);
  expect(browserTestingCapability("read", origin).stag_browser_testing.value).not.toContain(origin);
  expect(browserTestingCapability("project").stag_browser_testing.value).toContain(
    "Nenhuma origem autorizada",
  );
});

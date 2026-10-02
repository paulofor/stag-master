import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopTools,
  desktopArguments,
  desktopConfirmationReason,
  withoutAssistantWindow,
  windowsPowerShellEnvironment,
  type DesktopArguments,
  type ToolResult,
} from "../../src/main/desktop-tools";

const runScript = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: runScript }),
}));

const result: ToolResult = {
  success: true,
  contentItems: [{ type: "inputText", text: '{"ok":true}' }],
};
const stdin = { on: vi.fn(), end: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
  vi.stubEnv("PSExecutionPolicyPreference", "Restricted");
  runScript.mockImplementation(() =>
    Object.assign(Promise.resolve({ stdout: '{"ok":true}' }), { child: { stdin } }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("confirmação pelo efeito da interação", () => {
  it.each<DesktopArguments>([
    { action: "list_windows" },
    { action: "screenshot" },
    { action: "focus_window", processId: 4242 },
    { action: "scroll", x: 120, y: 180, delta: -120 },
    { action: "click", x: 120, y: 180, risk: "routine", intent: "Abrir aba do editor" },
    {
      action: "type_text",
      processId: 4242,
      text: "literal + ^ % {x}",
      risk: "routine",
      intent: "Editar campo local",
    },
    {
      action: "send_keys",
      processId: 4242,
      keys: "^s",
      risk: "routine",
      intent: "Salvar arquivo local",
    },
    {
      action: "send_keys",
      processId: 4242,
      keys: "^{HOME}",
      risk: "routine",
      intent: "Navegar no editor",
    },
  ])("usa consentimento da conversa para $action: $intent", (input) => {
    expect(desktopConfirmationReason(desktopArguments.parse(input))).toBeNull();
  });
  it.each<DesktopArguments>([
    { action: "click", x: 120, y: 180 },
    { action: "click", x: 120, y: 180, risk: "routine" },
    { action: "click", x: 120, y: 180, intent: "Abrir editor" },
    { action: "click", x: 120, y: 180, risk: "critical", intent: "Excluir arquivo" },
    { action: "send_keys", processId: 4242, keys: "^s", risk: "critical", intent: "Salvar senha" },
    {
      action: "type_text",
      processId: 4242,
      text: "SYNTHETIC_SECRET",
      risk: "critical",
      intent: "Digitar credencial sintética",
    },
  ])("confirma contexto ausente ou efeito crítico em $action: $intent", (input) => {
    expect(desktopConfirmationReason(desktopArguments.parse(input))).toBeTruthy();
  });
  it.each([
    "~",
    "{ENTER}",
    "^{ENTER}",
    "{DEL}",
    "+{DELETE}",
    "%{F4}",
    "^s{ENTER}",
    "^lhttps://example.invalid~",
  ])("declaração routine não libera atalho que envia/exclui ou sequência complexa: %s", (keys) => {
    expect(
      desktopConfirmationReason({
        action: "send_keys",
        processId: 4242,
        keys,
        risk: "routine",
        intent: "Interagir com editor",
      }),
    ).toBeTruthy();
  });
  it.each(["comando\n", "texto\r\n", "texto\r", "campo\tvalor"])(
    "texto que envia teclas especiais exige confirmação: %j",
    (text) => {
      expect(
        desktopConfirmationReason({
          action: "type_text",
          processId: 4242,
          text,
          risk: "routine",
          intent: "Editar campo local",
        }),
      ).toBeTruthy();
    },
  );
  it.each([
    { action: "click", x: 0, y: 0, risk: "unknown", intent: "Abrir editor" },
    { action: "click", x: 0, y: 0, risk: "routine", intent: "  " },
    { action: "click", x: 0, y: 0, risk: "routine", intent: "x".repeat(501) },
    { action: "screenshot", risk: "routine", intent: "Capturar" },
  ])("recusa classificação inválida ou metadados em operação sem contexto: %j", (input) => {
    expect(desktopArguments.safeParse(input).success).toBe(false);
  });
});

describe("driver de desktop com processo simulado", () => {
  const inputs: DesktopArguments[] = [
    { action: "list_windows" },
    { action: "focus_window", processId: 4242 },
    { action: "send_keys", processId: 4242, keys: "^s" },
    { action: "type_text", processId: 4242, text: "Texto + ^ % {x}; $(dummy); `literal`" },
    { action: "click", x: -100, y: 120, button: "right", clicks: 2 },
    { action: "scroll", x: 10, y: 20, delta: -240 },
  ];
  it.each(inputs)("executa $action com argumentos fixos e dados apenas em stdin", async (input) => {
    const tools = new DesktopTools("C:\\STAG\\windows-control.ps1", async () => result, "win32");
    await expect(tools.execute(input)).resolves.toEqual(result);
    expect(runScript).toHaveBeenCalledOnce();
    const [command, args, options] = runScript.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:\\STAG\\windows-control.ps1",
    ]);
    expect({
      windowsHide: options.windowsHide,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    }).toEqual({ windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
    expect(Object.keys(options.env).map((key) => key.toUpperCase())).not.toContain("PSMODULEPATH");
    expect(options.env.PSExecutionPolicyPreference).toBe("Restricted");
    expect(process.env.PSModulePath).toBe("C:\\Program Files\\PowerShell\\7\\Modules");
    const encoded = stdin.end.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(input);
  });
  it("captura imagem sem iniciar PowerShell", async () => {
    const image: ToolResult = {
      success: true,
      contentItems: [{ type: "inputImage", imageUrl: "data:image/png;base64,SYNTHETIC" }],
    };
    const capture = vi.fn(async () => image);
    const tools = new DesktopTools("unused", capture, "win32");
    await expect(tools.execute({ action: "screenshot" })).resolves.toEqual(image);
    expect(capture).toHaveBeenCalledOnce();
    expect(runScript).not.toHaveBeenCalled();
  });
  it.each([
    "CategoryInfo : SecurityError: (:) [], PSSecurityException",
    "CategoryInfo : Erro de seguran�a: (:) [], ParentContainsErrorRecordException\nFullyQualifiedErrorId : UnauthorizedAccess",
    "FullyQualifiedErrorId : AuthorizationManagerCheckFailed",
  ])("explica bloqueio de política sem repassar stderr ilegível: %s", async (stderr) => {
    const failure = Object.assign(
      new Error("Command failed: powershell.exe C:\\STAG\\script.ps1"),
      {
        stderr,
      },
    );
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.reject(failure), { child: { stdin } }),
    );
    const tools = new DesktopTools("C:\\STAG\\windows-control.ps1", async () => result, "win32");
    await expect(tools.execute({ action: "list_windows" })).rejects.toThrow("política de execução");
    expect(runScript).toHaveBeenCalledOnce();
    await expect(tools.execute({ action: "list_windows" })).resolves.toEqual(result);
    expect(runScript).toHaveBeenCalledTimes(2);
  });
  it("preserva falhas que não são de política e não tenta executar novamente", async () => {
    const failure = Object.assign(new Error("Janela sintética indisponível."), {
      stderr: "FullyQualifiedErrorId : GetContentReaderUnauthorizedAccessError",
    });
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.reject(failure), { child: { stdin } }),
    );
    const tools = new DesktopTools("unused", async () => result, "win32");
    await expect(tools.execute({ action: "list_windows" })).rejects.toBe(failure);
    expect(runScript).toHaveBeenCalledOnce();
  });
  it("não executa input inválido ou plataforma não Windows", async () => {
    const capture = vi.fn(async () => result);
    await expect(
      new DesktopTools("unused", capture, "win32").execute({
        action: "click",
        x: 0,
        y: 0,
        clicks: 3,
      }),
    ).rejects.toThrow();
    await expect(
      new DesktopTools("unused", capture, "linux").execute({ action: "screenshot" }),
    ).rejects.toThrow("Windows");
    expect(runScript).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

it("reconstrói módulos do PowerShell 5.1 sem alterar o ambiente ou a política do pai", () => {
  const base = {
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    PsModulePath: "C:\\PS7\\Modules",
    PSExecutionPolicyPreference: "Restricted",
    PATH: "C:\\Windows\\System32",
  };
  const original = { ...base };
  expect(windowsPowerShellEnvironment(base)).toEqual({
    PSExecutionPolicyPreference: "Restricted",
    PATH: "C:\\Windows\\System32",
  });
  expect(base).toEqual(original);
});

describe("painel durante a captura e ações por coordenadas", () => {
  it.each([false, true])(
    "oculta e restaura sem roubar foco, inclusive após falha=%s",
    async (fail) => {
      const actions: string[] = [];
      const window = {
        isDestroyed: () => false,
        isVisible: () => true,
        hide: () => actions.push("hide"),
        showInactive: () => actions.push("restore"),
      };
      const execution = withoutAssistantWindow(
        window,
        async () => {
          actions.push("execute");
          if (fail) throw new Error("capture failed");
          return result;
        },
        async () => {
          actions.push("settle");
        },
      );
      if (fail) await expect(execution).rejects.toThrow("capture failed");
      else await expect(execution).resolves.toEqual(result);
      expect(actions).toEqual(["hide", "settle", "execute", "restore"]);
    },
  );
  it("não reabre janela oculta ou destruída durante a ação", async () => {
    const hide = vi.fn();
    const showInactive = vi.fn();
    const settle = vi.fn();
    let destroyed = false;
    await withoutAssistantWindow(
      { isDestroyed: () => false, isVisible: () => false, hide, showInactive },
      async () => result,
      settle,
    );
    await withoutAssistantWindow(
      { isDestroyed: () => destroyed, isVisible: () => true, hide, showInactive },
      async () => {
        destroyed = true;
        return result;
      },
      settle,
    );
    expect(hide).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledOnce();
    expect(showInactive).not.toHaveBeenCalled();
  });
});

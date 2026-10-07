import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DesktopTools,
  desktopArguments,
  desktopConfirmationReason,
  desktopApproval,
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
const child = {
  stdin,
  once: vi.fn((_event: string, listener: () => void) => queueMicrotask(listener)),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
  vi.stubEnv("PSExecutionPolicyPreference", "Restricted");
  runScript.mockImplementation(() =>
    Object.assign(Promise.resolve({ stdout: '{"ok":true}' }), { child }),
  );
});
afterEach(() => vi.unstubAllEnvs());

describe("movimento fixo pertencente ao main", () => {
  it("passa somente o marcador interno e o sinal de cancelamento, sem coordenadas", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: '{"moved":true}' }), { child }),
    );
    const controller = new AbortController();
    await expect(
      new DesktopTools("unused", "win32").pulseCursor(controller.signal),
    ).resolves.toEqual({ moved: true });
    const received = runScript.mock.calls[0][2].signal as AbortSignal;
    expect(received.aborted).toBe(false);
    controller.abort();
    expect(received.aborted).toBe(true);
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      action: "nudge_cursor",
      stagPeriodicMovement: true,
    });
    expect(child.once).toHaveBeenCalledWith("close", expect.any(Function));
  });
  it("recusa resposta inválida e plataforma sem Windows", async () => {
    await expect(new DesktopTools("unused", "linux").pulseCursor()).rejects.toThrow("Windows");
    expect(runScript).not.toHaveBeenCalled();
    await expect(new DesktopTools("unused", "win32").pulseCursor()).rejects.toThrow();
  });
  it("aguarda fechamento do subprocesso mesmo após cancelamento", async () => {
    let close!: () => void;
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.reject(new Error("aborted")), {
        child: {
          stdin,
          once: (_event: string, listener: () => void) => {
            close = listener;
          },
        },
      }),
    );
    let settled = false;
    const work = new DesktopTools("unused", "win32").pulseCursor().catch(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    close();
    await work;
    expect(settled).toBe(true);
  });
});

describe("interrupção do subprocesso desktop", () => {
  it("aborta a execução e aguarda close antes de permitir a limpeza", async () => {
    let close!: () => void;
    let received!: AbortSignal;
    runScript.mockImplementationOnce((_command, _args, options) => {
      received = options.signal;
      return Object.assign(
        new Promise((_resolve, reject) => {
          received.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
        {
          child: {
            stdin,
            once: (_event: string, listener: () => void) => {
              close = listener;
            },
          },
        },
      );
    });
    const driver = new DesktopTools("unused", "win32");
    let settled = false;
    const work = driver.execute({ action: "list_windows" }).catch(() => {
      settled = true;
    });
    driver.cancel();
    expect(received.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    close();
    await work;
    expect(settled).toBe(true);
    await expect(driver.execute({ action: "list_windows" })).resolves.toMatchObject({
      success: true,
    });
    expect(runScript).toHaveBeenCalledTimes(2);
  });
  it("não inicia processo com sinal já cancelado", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new DesktopTools("unused", "win32").execute(
        { action: "list_windows" },
        false,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(runScript).not.toHaveBeenCalled();
  });
});

describe("confirmação pelo efeito da interação", () => {
  it.each<DesktopArguments>([
    { action: "list_windows" },
    { action: "screenshot", processId: 4242 },
    { action: "focus_window", processId: 4242 },
    { action: "scroll", processId: 4242, x: 120, y: 180, delta: -120 },
    {
      action: "click",
      processId: 4242,
      x: 120,
      y: 180,
      risk: "routine",
      intent: "Abrir aba do editor",
    },
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
    { action: "click", processId: 4242, x: 120, y: 180 },
    { action: "click", processId: 4242, x: 120, y: 180, risk: "routine" },
    { action: "click", processId: 4242, x: 120, y: 180, intent: "Abrir editor" },
    {
      action: "click",
      processId: 4242,
      x: 120,
      y: 180,
      risk: "critical",
      intent: "Excluir arquivo",
    },
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
    { action: "click", processId: 4242, x: 0, y: 0, risk: "unknown", intent: "Abrir editor" },
    { action: "click", processId: 4242, x: 0, y: 0, risk: "routine", intent: "  " },
    { action: "click", processId: 4242, x: 0, y: 0, risk: "routine", intent: "x".repeat(501) },
    { action: "screenshot", processId: 4242, risk: "routine", intent: "Capturar" },
    { action: "click", processId: 8383, x: 0, y: 0, stagCriticalApproved: true },
    { action: "click", processId: 8383, x: 0, y: 0, stagCheckOnly: true },
  ])("recusa classificação inválida ou metadados em operação sem contexto: %j", (input) => {
    expect(desktopArguments.safeParse(input).success).toBe(false);
  });
});

describe("abertura do console FortiClient sem automação do ícone", () => {
  const input: DesktopArguments = {
    action: "open_forticlient",
    risk: "critical",
    intent: "Abrir console para conferir a VPN sintética",
  };
  it("inspeciona instalação sem abrir, exige confirmação e não permite efeito seguinte", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: '{"requiresConfirmation":true}' }), { child }),
    );
    const reason = await new DesktopTools("unused", "win32").confirmationReason(input);
    expect(reason).toContain("somente para a abertura");
    expect(desktopApproval(input, reason).detail).toContain(input.intent);
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      ...input,
      stagCheckOnly: true,
    });
  });
  it("abre somente no caminho aprovado e orienta verificar o estado sem afirmar conexão", async () => {
    const tools = new DesktopTools("unused", "win32");
    await expect(tools.execute(input)).rejects.toThrow("confirmação específica");
    expect(runScript).not.toHaveBeenCalled();
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: '{"opened":true}' }), { child }),
    );
    const result = await tools.execute(input, true);
    expect(result.success).toBe(true);
    expect(result.contentItems[0]).toMatchObject({
      text: expect.stringContaining("Isso não comprova conexão da VPN"),
    });
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      ...input,
      stagCriticalApproved: true,
    });
  });
  it.each([
    { ...input, risk: "routine" },
    { action: "open_forticlient", risk: "critical" },
    ...["processId", "path", "args", "profile", "stagCriticalApproved", "stagCheckOnly"].map(
      (key) => ({ ...input, [key]: key === "processId" ? 8383 : "synthetic" }),
    ),
  ])("recusa controle arbitrário e marcadores externos: %j", (args) => {
    expect(desktopArguments.safeParse(args).success).toBe(false);
  });
  it.each([
    ["STAG_FORTICLIENT_UNAVAILABLE", "não foi encontrado"],
    ["STAG_FORTICLIENT_DENIED", "instalação verificada"],
  ])("falha %s preserva diagnóstico sem expor caminho ou configuração", async (code, expected) => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.reject(
          Object.assign(new Error("synthetic error"), { stderr: `${code}: PRIVATE_PATH` }),
        ),
        { child },
      ),
    );
    const error = await new DesktopTools("unused", "win32")
      .confirmationReason(input)
      .catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(expected);
    expect(JSON.stringify(error)).not.toContain("PRIVATE_PATH");
    expect((error as Error).message).not.toContain("PRIVATE_PATH");
    expect(child.once).toHaveBeenCalledWith("close", expect.any(Function));
  });
  it.each([{}, { requiresConfirmation: false }, { requiresConfirmation: true, path: "PRIVATE" }])(
    "inspeção inválida falha fechada: %j",
    async (inspection) => {
      runScript.mockImplementationOnce(() =>
        Object.assign(Promise.resolve({ stdout: JSON.stringify(inspection) }), { child }),
      );
      await expect(new DesktopTools("unused", "win32").confirmationReason(input)).rejects.toThrow();
    },
  );
  it("não aceita resposta que declare conexão sem evidência", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: '{"opened":true,"connected":true}' }), { child }),
    );
    await expect(new DesktopTools("unused", "win32").execute(input, true)).rejects.toThrow();
  });
});

describe("driver de desktop com processo simulado", () => {
  it.each<DesktopArguments>([
    { action: "click", processId: 8383, x: 10, y: 20, risk: "routine", intent: "Navegar" },
    { action: "type_text", processId: 8383, text: "synthetic", risk: "routine", intent: "Editar" },
    { action: "send_keys", processId: 8383, keys: "^s", risk: "routine", intent: "Salvar" },
    {
      action: "click",
      processId: 8383,
      x: 10,
      y: 20,
      risk: "critical",
      intent: "Reconectar VPN sintética",
    },
    { action: "click", processId: 8383, x: 10, y: 20 },
  ])("inspeciona o alvo real e confirma FortiClient mesmo com routine: $action", async (input) => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.resolve({
          stdout: JSON.stringify({ processId: 8383, requiresConfirmation: true }),
        }),
        { child },
      ),
    );
    const reason = await new DesktopTools("unused", "win32").confirmationReason(input);
    expect(reason).toContain("Interação no FortiClient");
    expect(reason).toContain("perfil/conexão");
    expect(runScript).toHaveBeenCalledOnce();
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      ...input,
      stagCheckOnly: true,
    });
  });
  it("inspeção sem aprovação preserva rotina em outro aplicativo", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.resolve({ stdout: '{"processId":4242,"requiresConfirmation":false}' }),
        { child },
      ),
    );
    await expect(
      new DesktopTools("unused", "win32").confirmationReason({
        action: "click",
        processId: 4242,
        x: 10,
        y: 20,
        risk: "routine",
        intent: "Abrir aba",
      }),
    ).resolves.toBeNull();
  });
  it.each([
    { processId: 9001, requiresConfirmation: false },
    { processId: 8383 },
    { processId: 8383, requiresConfirmation: "false" },
  ])("inspeção inválida falha fechada antes de interagir: %j", async (inspection) => {
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: JSON.stringify(inspection) }), { child }),
    );
    await expect(
      new DesktopTools("unused", "win32").confirmationReason({
        action: "click",
        processId: 8383,
        x: 10,
        y: 20,
        risk: "routine",
        intent: "Navegar",
      }),
    ).rejects.toThrow();
    expect(runScript).toHaveBeenCalledOnce();
  });
  it("consulta visual não dispara inspeção extra nem concede aprovação", async () => {
    const tools = new DesktopTools("unused", "win32");
    for (const input of [
      { action: "list_windows" },
      { action: "screenshot", processId: 8383 },
      { action: "focus_window", processId: 8383 },
      { action: "scroll", processId: 8383, x: 10, y: 20, delta: 120 },
    ])
      expect(await tools.confirmationReason(input)).toBeNull();
    expect(runScript).not.toHaveBeenCalled();
  });
  it("somente o caminho aprovado acrescenta o marcador interno", async () => {
    const input = {
      action: "click",
      processId: 8383,
      x: 10,
      y: 20,
      risk: "routine",
      intent: "Reconectar VPN sintética",
    };
    await new DesktopTools("unused", "win32").execute(input, true);
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      ...input,
      stagCriticalApproved: true,
    });
  });
  it("alvo alterado para FortiClient entre inspeção e execução não recebe entrada", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.reject(
          Object.assign(new Error("approval needed"), { stderr: "STAG_DESKTOP_APPROVAL_REQUIRED" }),
        ),
        { child },
      ),
    );
    await expect(
      new DesktopTools("unused", "win32").execute({
        action: "click",
        processId: 8383,
        x: 10,
        y: 20,
      }),
    ).rejects.toThrow("Nenhuma entrada foi enviada");
  });
  const inputs: DesktopArguments[] = [
    { action: "list_windows" },
    { action: "focus_window", processId: 4242 },
    { action: "send_keys", processId: 4242, keys: "^s" },
    { action: "type_text", processId: 4242, text: "Texto + ^ % {x}; $(dummy); `literal`" },
    { action: "click", processId: 4242, x: -100, y: 120, button: "right", clicks: 2 },
    { action: "scroll", processId: 4242, x: 10, y: 20, delta: -240 },
  ];
  it.each(inputs)("executa $action com argumentos fixos e dados apenas em stdin", async (input) => {
    const tools = new DesktopTools("C:\\STAG\\windows-control.ps1", "win32");
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
    }).toEqual({ windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
    expect(Object.keys(options.env).map((key) => key.toUpperCase())).not.toContain("PSMODULEPATH");
    expect(options.env.PSExecutionPolicyPreference).toBe("Restricted");
    expect(process.env.PSModulePath).toBe("C:\\Program Files\\PowerShell\\7\\Modules");
    const encoded = stdin.end.mock.calls[0][0];
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toEqual(input);
  });
  it("captura somente a janela validada pelo driver e informa sua origem física", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.resolve({
          stdout: JSON.stringify({
            processId: 4242,
            bounds: { x: -200, y: 20, width: 800, height: 600 },
            imageBase64: "aW1hZ2VtLXNpbnRldGljYQ==",
          }),
        }),
        { child },
      ),
    );
    const tools = new DesktopTools("unused", "win32");
    const capture = await tools.execute({ action: "screenshot", processId: 4242 });
    expect(capture.success).toBe(true);
    expect(capture.contentItems[0]).toMatchObject({
      type: "inputText",
      text: expect.stringContaining("x=-200, y=20"),
    });
    expect(capture.contentItems[1]).toEqual({
      type: "inputImage",
      imageUrl: "data:image/png;base64,aW1hZ2VtLXNpbnRldGljYQ==",
    });
    expect(runScript).toHaveBeenCalledOnce();
    expect(JSON.parse(Buffer.from(stdin.end.mock.calls[0][0], "base64").toString("utf8"))).toEqual({
      action: "screenshot",
      processId: 4242,
    });
  });
  it.each([
    { processId: 9001, bounds: { x: 0, y: 0, width: 800, height: 600 }, imageBase64: "aW1hZ2Vt" },
    { processId: 4242, bounds: { x: 0, y: 0, width: 0, height: 600 }, imageBase64: "aW1hZ2Vt" },
    { processId: 4242, bounds: { x: 0, y: 0, width: 9000, height: 600 }, imageBase64: "aW1hZ2Vt" },
    {
      processId: 4242,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      imageBase64: "https://fixture.invalid/image",
    },
  ])("não retorna imagem com alvo/dimensões/conteúdo inválidos", async (capture) => {
    runScript.mockImplementationOnce(() =>
      Object.assign(Promise.resolve({ stdout: JSON.stringify(capture) }), { child }),
    );
    await expect(
      new DesktopTools("unused", "win32").execute({ action: "screenshot", processId: 4242 }),
    ).rejects.toThrow();
  });
  it.each(["screenshot", "click", "scroll"])(
    "recusa %s sem processo alvo antes de executar",
    async (action) => {
      await expect(
        new DesktopTools("unused", "win32").execute({ action, x: 10, y: 20, delta: 120 }),
      ).rejects.toThrow();
      expect(runScript).not.toHaveBeenCalled();
    },
  );
  it("explica bloqueio de aplicativo sem tentativa alternativa e permite recuperação", async () => {
    runScript.mockImplementationOnce(() =>
      Object.assign(
        Promise.reject(
          Object.assign(new Error("denied"), { stderr: "STAG_DESKTOP_DENIED: synthetic target" }),
        ),
        { child },
      ),
    );
    const tools = new DesktopTools("unused", "win32");
    await expect(tools.execute({ action: "focus_window", processId: 9001 })).rejects.toThrow(
      "Desktop restrito a Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient",
    );
    expect(runScript).toHaveBeenCalledOnce();
    await expect(tools.execute({ action: "focus_window", processId: 4242 })).resolves.toEqual(
      result,
    );
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
    runScript.mockImplementationOnce(() => Object.assign(Promise.reject(failure), { child }));
    const tools = new DesktopTools("C:\\STAG\\windows-control.ps1", "win32");
    await expect(tools.execute({ action: "list_windows" })).rejects.toThrow("política de execução");
    expect(runScript).toHaveBeenCalledOnce();
    await expect(tools.execute({ action: "list_windows" })).resolves.toEqual(result);
    expect(runScript).toHaveBeenCalledTimes(2);
  });
  it("preserva falhas que não são de política e não tenta executar novamente", async () => {
    const failure = Object.assign(new Error("Janela sintética indisponível."), {
      stderr: "FullyQualifiedErrorId : GetContentReaderUnauthorizedAccessError",
    });
    runScript.mockImplementationOnce(() => Object.assign(Promise.reject(failure), { child }));
    const tools = new DesktopTools("unused", "win32");
    await expect(tools.execute({ action: "list_windows" })).rejects.toBe(failure);
    expect(runScript).toHaveBeenCalledOnce();
  });
  it("não executa input inválido ou plataforma não Windows", async () => {
    await expect(
      new DesktopTools("unused", "win32").execute({
        action: "click",
        processId: 4242,
        x: 0,
        y: 0,
        clicks: 3,
      }),
    ).rejects.toThrow();
    await expect(
      new DesktopTools("unused", "linux").execute({ action: "screenshot", processId: 4242 }),
    ).rejects.toThrow("Windows");
    expect(runScript).not.toHaveBeenCalled();
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

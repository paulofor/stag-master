import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AssistantService } from "../../src/main/service";
import { RpcClient } from "../../src/main/rpc";
import { SettingsStore } from "../../src/main/settings";
import { codexEnvironment } from "../../src/main/policy";
import type { DesktopArguments, ToolResult } from "../../src/main/desktop-tools";
import { browserConfirmationReason, type BrowserArguments } from "../../src/main/browser-tools";

let dir: string;
let service: AssistantService;
let rpc: RpcClient;
let store: SettingsStore;
const openExternal = vi.fn(async (_url: string) => {});
const selectProject = vi.fn<() => Promise<string | null>>();
const desktop = {
  execute: vi.fn(async (_args: unknown): Promise<ToolResult> => ({
    success: true,
    contentItems: [{ type: "inputText" as const, text: "[]" }],
  })),
};
const browser = {
  execute: vi.fn(async (_args: BrowserArguments): Promise<ToolResult> => ({
    success: true,
    contentItems: [{ type: "inputText", text: "synthetic-browser-result" }],
  })),
  confirmationReason: vi.fn(async (args: BrowserArguments) => browserConfirmationReason(args)),
  control: vi.fn(async () => {}),
  reset: vi.fn(),
  cancel: vi.fn(),
  setVisible: vi.fn(),
};
beforeEach(async () => {
  await mkdir(resolve(".local"), { recursive: true });
  dir = await mkdtemp(resolve(".local/service-test-"));
  store = new SettingsStore(resolve(dir, "settings.json"));
  selectProject.mockResolvedValue(dir);
  service = new AssistantService({
    createRpc: () => {
      rpc = new RpcClient({
        command: process.execPath,
        args: [resolve("tests/fixtures/app-server.mjs")],
        cwd: dir,
        env: {
          ...codexEnvironment(resolve(dir, "home")),
          STAG_FIXTURE_STATE: resolve(dir, "server-state.json"),
        },
      });
      return rpc;
    },
    store,
    openExternal,
    selectProject,
    desktop,
    browser,
    platform: "win32",
  });
  await service.init();
  await service.request({ type: "connect" });
});
afterEach(async () => {
  service.dispose();
  await rpc.shutdown();
  vi.resetAllMocks();
  desktop.execute.mockResolvedValue({
    success: true,
    contentItems: [{ type: "inputText", text: "[]" }],
  });
  browser.execute.mockResolvedValue({
    success: true,
    contentItems: [{ type: "inputText", text: "synthetic-browser-result" }],
  });
  browser.confirmationReason.mockImplementation(async (args) => browserConfirmationReason(args));
  await rm(dir, { recursive: true, force: true });
});
async function ready() {
  await service.request({ type: "login" });
  await vi.waitFor(() => expect(service.snapshot().models).toHaveLength(1));
  await service.request({ type: "selectProject" });
}
async function send(message: string) {
  await service.request({ type: "send", text: message });
}
async function complete() {
  await vi.waitFor(() => expect(service.snapshot().busy).toBe(false));
}
async function approve(accept: boolean) {
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  await service.request({ type: "answer", id: service.snapshot().approvals[0].id, accept });
  await complete();
}
describe("fluxo local do assistente", () => {
  it("selecionar pasta ativa escrita recursiva e reconectar conserva somente a raiz escolhida", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "read" });
    await send("analise em Leitura");
    await complete();
    const readThread = service.snapshot().threadId!;
    await service.request({ type: "selectProject" });
    expect(service.snapshot().mode).toBe("project");
    expect(service.snapshot().threadId).toBeNull();
    await send("trabalhe nas subpastas");
    await complete();
    const projectThread = service.snapshot().threadId!;
    await service.request({ type: "connect" });
    expect(service.snapshot().threadId).toBe(projectThread);
    expect(service.snapshot().approvals).toEqual([]);
    const calls =
      await rpc.call<{ method: string; params: Record<string, unknown> }[]>("_fixture/readCalls");
    const resume = calls.find((call) => call.method === "thread/resume")!;
    expect(resume.params.runtimeWorkspaceRoots).toEqual([dir]);
    expect(resume.params.config).toMatchObject({ sandbox_workspace_write: { writable_roots: [] } });
    expect(resume.params.developerInstructions).toContain(
      "leitura e escrita nela e em suas subpastas",
    );
    expect(resume.params.developerInstructions).toContain(JSON.stringify(dir));
    await send("continue nas subpastas");
    await complete();
    const continued =
      await rpc.call<{ method: string; params: Record<string, unknown> }[]>("_fixture/readCalls");
    const turn = continued.find((call) => call.method === "turn/start")!;
    expect(turn.params.runtimeWorkspaceRoots).toEqual([dir]);
    expect(turn.params.sandboxPolicy).toMatchObject({
      type: "workspaceWrite",
      writableRoots: [dir],
    });
    await service.request({ type: "resume", threadId: readThread });
    expect(service.snapshot().mode).toBe("read");
    expect((await store.load()).threads[readThread].mode).toBe("read");
    await send("leia sem editar");
    await complete();
  });
  it("trocar pasta não reutiliza raízes, históricos ou consentimentos de desktop/navegador", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await service.request({ type: "browserConsent", allow: true });
    await send("analise");
    await complete();
    const oldThread = service.snapshot().threadId!;
    const other = resolve(dir, "pasta vizinha-ação");
    await mkdir(other);
    selectProject.mockResolvedValueOnce(other);
    await service.request({ type: "selectProject" });
    expect(service.snapshot().project?.path).toBe(other);
    expect(service.snapshot().mode).toBe("project");
    expect(service.snapshot().browser.authorized).toBe(false);
    expect(service.snapshot().threadId).toBeNull();
    await expect(service.request({ type: "resume", threadId: oldThread })).rejects.toThrow(
      "indisponível",
    );
    await send("trabalhe na nova pasta");
    await complete();
    const calls =
      await rpc.call<{ method: string; params: Record<string, unknown> }[]>("_fixture/readCalls");
    const start = calls.filter((call) => call.method === "thread/start").at(-1)!;
    expect(start.params.runtimeWorkspaceRoots).toEqual([other]);
    expect(start.params.config).toMatchObject({ sandbox_workspace_write: { writable_roots: [] } });
    expect(start.params.dynamicTools).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "windows_desktop" })]),
    );
    expect(start.params.developerInstructions).toContain(JSON.stringify(other));
    expect(start.params.developerInstructions).not.toContain(
      `Pasta de trabalho selecionada: ${JSON.stringify(dir)}.`,
    );
  });
  it("cancelamento ou seleção inválida preservam a pasta, modo e histórico ativos", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "read" });
    await send("analise");
    await complete();
    const before = service.snapshot();
    selectProject.mockResolvedValueOnce(null);
    await service.request({ type: "selectProject" });
    selectProject.mockResolvedValueOnce(resolve(dir, "não existe"));
    await expect(service.request({ type: "selectProject" })).rejects.toThrow();
    expect(service.snapshot().project).toEqual(before.project);
    expect(service.snapshot().threadId).toBe(before.threadId);
    expect(service.snapshot().mode).toBe("read");
    expect(service.snapshot().items).toEqual(before.items);
  });
  it("abre aplicação local no navegador integrado após consentimento, com desktop autorizado", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    const task = "abrir aplicação local http://localhost:4201/";
    await send(task);
    await complete();
    const thread = service.snapshot().threadId;
    expect(service.snapshot().items.at(-1)?.text).toContain("Autorizar navegador");
    expect(desktop.execute).not.toHaveBeenCalled();
    expect(browser.execute).not.toHaveBeenCalled();
    expect(service.snapshot().approvals).toEqual([]);

    await service.request({ type: "browserConsent", allow: true });
    expect(service.snapshot().threadId).toBe(thread);
    await send(task);
    await complete();
    expect(browser.execute.mock.calls.map(([args]) => args.action)).toEqual([
      "navigate",
      "snapshot",
    ]);
    expect(browser.execute).toHaveBeenCalledWith({
      action: "navigate",
      url: "http://localhost:4201/",
      risk: "routine",
      intent: "Conferir aplicação local no navegador do STAG",
    });
    expect(desktop.execute).not.toHaveBeenCalled();
    expect(openExternal.mock.calls).toEqual([["https://auth.openai.com/fixture-login"]]);
    expect(service.snapshot().items.at(-1)?.text).toContain("aplicação local conferida no STAG");
    expect(service.snapshot().approvals).toEqual([]);
    expect(service.snapshot().mode).toBe("windows");

    const calls =
      await rpc.call<{ method: string; params: Record<string, unknown> }[]>("_fixture/readCalls");
    const start = calls.find((call) => call.method === "thread/start")!;
    const resume = calls.find((call) => call.method === "thread/resume")!;
    for (const call of [start, resume]) {
      expect(call.params.developerInstructions).toContain("use exclusivamente stag_browser");
      expect(call.params.developerInstructions).toContain("localhost/127.0.0.1");
      expect(call.params.sandbox).toBe("danger-full-access");
    }
    expect(start.params.developerInstructions).toContain("clicar em Autorizar navegador");
    expect(resume.params.developerInstructions).toContain("O cliente autorizou stag_browser");
    expect(resume.params).not.toHaveProperty("dynamicTools");
  });
  it("mantém o roteamento integrado ao reconectar, fechar, trocar e retomar conversa", async () => {
    await ready();
    const task = "abrir aplicação local http://127.0.0.1:4201/";
    await service.request({ type: "browserConsent", allow: true });
    await send(task);
    await complete();
    const first = service.snapshot().threadId!;
    await service.request({ type: "connect" });
    await send(task);
    await complete();
    expect(browser.execute).toHaveBeenCalledTimes(4);

    await service.request({ type: "browserVisibility", visible: false });
    await send(task);
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("Autorizar navegador");
    await service.request({ type: "browserVisibility", visible: true });
    await send(task);
    await complete();
    expect(service.snapshot().browser.authorized).toBe(false);
    expect(browser.execute).toHaveBeenCalledTimes(4);

    await service.request({ type: "newChat" });
    await send(task);
    await complete();
    await service.request({ type: "resume", threadId: first });
    await send(task);
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("Autorizar navegador");
    expect(browser.execute).toHaveBeenCalledTimes(4);
    expect(desktop.execute).not.toHaveBeenCalled();
    const calls =
      await rpc.call<{ method: string; params: Record<string, unknown> }[]>("_fixture/readCalls");
    for (const call of calls.filter((c) => ["thread/start", "thread/resume"].includes(c.method))) {
      expect(call.params.developerInstructions).toContain("use exclusivamente stag_browser");
      expect(call.params.sandbox).toBe("workspace-write");
      if (call.method === "thread/resume") expect(call.params).not.toHaveProperty("dynamicTools");
    }
    expect(openExternal.mock.calls).toEqual([["https://auth.openai.com/fixture-login"]]);
  });
  it("orienta recuperação de navegador negado e histórico sem tool sem recorrer ao desktop", async () => {
    await ready();
    const reply = vi.spyOn(rpc, "respond");
    await send("navegador forçar");
    await complete();
    expect(reply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        success: false,
        contentItems: [
          expect.objectContaining({
            text: expect.stringContaining("Autorizar navegador"),
          }),
        ],
      }),
    );
    const refusal = JSON.stringify(reply.mock.calls);
    expect(refusal).toContain("Não abra nem controle Chrome/Edge");
    expect(refusal).toContain("Mostrar navegador");
    const thread = service.snapshot().threadId!;
    const settings = await store.load();
    delete settings.threads[thread].browserTool;
    await store.save(settings);
    await service.init();
    await service.request({ type: "resume", threadId: thread });
    await send("abrir aplicação local http://localhost:4201/");
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("nova conversa");
    await expect(service.request({ type: "browserConsent", allow: true })).rejects.toThrow(
      "nova conversa",
    );
    expect(browser.execute).not.toHaveBeenCalled();
    expect(desktop.execute).not.toHaveBeenCalled();
    expect(service.snapshot().mode).toBe("project");
    expect((await store.load()).threads[thread].browserTool).toBeUndefined();
  });
  it("revogação do navegador permanece efetiva quando a interrupção remota falha", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    await send("navegador crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    vi.spyOn(rpc, "call").mockRejectedValueOnce(new Error("Interrupção sintética falhou."));
    await expect(service.request({ type: "browserVisibility", visible: false })).rejects.toThrow(
      "Interrupção sintética falhou",
    );
    expect(service.snapshot().browser.authorized).toBe(false);
    expect(service.snapshot().browser.visible).toBe(false);
    expect(browser.execute).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(service.snapshot().connection).toBe("error"));
    await service.request({ type: "connect" });
    expect(service.snapshot().browser.authorized).toBe(false);
  });
  it("desktop e navegador compartilham a fila de execução", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await service.request({ type: "browserConsent", allow: true });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    desktop.execute.mockImplementationOnce(async () => {
      await blocked;
      return { success: true, contentItems: [] };
    });
    await send("navegador misto");
    await vi.waitFor(() => expect(desktop.execute).toHaveBeenCalledOnce());
    expect(browser.execute).not.toHaveBeenCalled();
    release();
    await complete();
    expect(browser.execute).toHaveBeenCalledOnce();
    expect(browser.execute).toHaveBeenCalledWith({ action: "scroll", delta: 200 });
  });
  it("navegador exige consentimento e segue sequência rotineira sem cards nem pixels públicos", async () => {
    await ready();
    await send("navegador forçar");
    await complete();
    expect(browser.execute).not.toHaveBeenCalled();
    await service.request({ type: "browserConsent", allow: true });
    browser.execute.mockImplementation(async (args) => ({
      success: true,
      contentItems:
        args.action === "screenshot"
          ? [{ type: "inputImage", imageUrl: "data:image/png;base64,SYNTHETIC_BROWSER_PIXELS" }]
          : [{ type: "inputText", text: "synthetic-browser-result" }],
    }));
    await send("navegador sequência");
    await complete();
    expect(browser.execute.mock.calls.map(([args]) => args.action)).toEqual([
      "navigate",
      "snapshot",
      "fill",
      "click",
      "scroll",
      "screenshot",
    ]);
    expect(service.snapshot().approvals).toEqual([]);
    expect(JSON.stringify(service.snapshot())).not.toContain("SYNTHETIC_BROWSER_PIXELS");
    expect(service.snapshot().mode).toBe("project");
  });
  it("navegador confirma cada efeito crítico e recusa não executa", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    await send("navegador crítico");
    await approve(false);
    expect(browser.execute).not.toHaveBeenCalled();
    await send("navegador crítico");
    await approve(true);
    expect(browser.execute).toHaveBeenCalledOnce();
  });
  it("navegador trata erros do probe/driver, recupera e não duplica pedidos", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    browser.confirmationReason.mockRejectedValueOnce(new Error("Alvo sintético mudou."));
    await send("navegador crítico");
    await complete();
    expect(service.snapshot().error).toContain("Alvo sintético mudou");
    expect(service.snapshot().metrics.failures).toBe(1);
    expect(browser.execute).not.toHaveBeenCalled();
    browser.execute.mockRejectedValueOnce(new Error("Falha sintética do navegador."));
    await send("navegador");
    await complete();
    expect(service.snapshot().metrics.failures).toBe(2);
    await send("navegador duplicado");
    await complete();
    expect(browser.execute).toHaveBeenCalledTimes(2);
    expect(service.snapshot().error).toBeNull();
  });
  it("navegador rejeita argumentos, namespace e outro thread/turn sem prender o servidor", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    const reply = vi.spyOn(rpc, "respond");
    for (const suffix of ["inválido", "namespace", "outro thread", "outro turno"]) {
      await send(`navegador ${suffix}`);
      await complete();
    }
    expect(browser.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(reply.mock.calls)).not.toContain("Autorizar navegador");
  });
  it("navegador reconecta no mesmo thread, autoriza durante conversa e não transfere acesso", async () => {
    await ready();
    await send("analise");
    await complete();
    const first = service.snapshot().threadId!;
    await service.request({ type: "browserConsent", allow: true });
    await send("navegador");
    await complete();
    await service.request({ type: "connect" });
    expect(service.snapshot().browser.authorized).toBe(true);
    await send("navegador");
    await complete();
    await service.request({ type: "newChat" });
    expect(service.snapshot().browser.authorized).toBe(false);
    await service.request({ type: "browserConsent", allow: true });
    await send("analise outra");
    await complete();
    await service.request({ type: "resume", threadId: first });
    expect(service.snapshot().browser.authorized).toBe(false);
    await send("navegador forçar");
    await complete();
    expect(browser.execute).toHaveBeenCalledTimes(2);
    expect((await store.load()).threads[first].browserTool).toBe(true);
    expect(JSON.stringify(await store.load())).not.toContain("authorized");
  });
  it("navegador histórico antigo conserva tools e exige nova conversa para autorizar", async () => {
    await ready();
    await send("analise");
    await complete();
    const id = service.snapshot().threadId!;
    const settings = await store.load();
    delete settings.threads[id].browserTool;
    await store.save(settings);
    await service.init();
    await expect(service.request({ type: "browserConsent", allow: true })).rejects.toThrow(
      "nova conversa",
    );
    expect(service.snapshot().threadId).toBe(id);
    expect(service.snapshot().mode).toBe("project");
  });
  it("navegador revoga enquanto aguarda aprovação e fechar não transfere autorização", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    await send("navegador crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const id = service.snapshot().approvals[0].id;
    await service.request({ type: "browserVisibility", visible: false });
    await complete();
    expect(service.snapshot().browser.authorized).toBe(false);
    expect(service.snapshot().browser.visible).toBe(false);
    await expect(service.request({ type: "answer", id, accept: true })).rejects.toThrow(
      "resolvido",
    );
    expect(browser.execute).not.toHaveBeenCalled();
    await service.request({ type: "browserVisibility", visible: true });
    expect(service.snapshot().browser.authorized).toBe(false);
  });
  it("navegador serializa operações e cancela fila/resultados antigos na interrupção", async () => {
    await ready();
    await service.request({ type: "browserConsent", allow: true });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    browser.execute.mockImplementationOnce(async () => {
      await blocked;
      return { success: true, contentItems: [{ type: "inputText", text: "OLD_BROWSER_RESULT" }] };
    });
    await send("navegador paralelo");
    await vi.waitFor(() => expect(browser.execute).toHaveBeenCalledOnce());
    await expect(
      service.request({
        type: "browserControl",
        control: { action: "navigate", url: "https://fixture.invalid" },
      }),
    ).rejects.toThrow("Pare");
    await service.request({ type: "stop" });
    await complete();
    await service.request({ type: "newChat" });
    release();
    await vi.waitFor(() => expect(browser.confirmationReason).toHaveBeenCalledOnce());
    expect(browser.execute).toHaveBeenCalledOnce();
    expect(service.snapshot().items).toEqual([]);
    expect(JSON.stringify(service.snapshot())).not.toContain("OLD_BROWSER_RESULT");
    expect(browser.cancel).toHaveBeenCalled();
  });
  it("autentica por ChatGPT e não transmite tokens", async () => {
    await ready();
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/fixture-login");
    expect(service.snapshot().account?.email).toBe("fixture@example.invalid");
    expect(JSON.stringify(service.snapshot())).not.toContain("MUST_NOT_REACH_RENDERER");
    expect(service.snapshot().model).toBe("fixture-model");
  });
  it("exige conta/projeto e valida mensagem e modelo", async () => {
    await expect(send("sem login")).rejects.toThrow("Entre");
    await service.request({ type: "login" });
    await vi.waitFor(() => expect(service.snapshot().models.length).toBe(1));
    await expect(send("sem projeto")).rejects.toThrow("pasta");
    await service.request({ type: "selectProject" });
    await expect(send("  ")).rejects.toThrow();
    await expect(service.request({ type: "preferences", model: "inventado" })).rejects.toThrow(
      "indisponível",
    );
    await expect(service.request({ type: "preferences", effort: "impossivel" })).rejects.toThrow(
      "indisponível",
    );
  });
  it("recebe deltas e texto final sem duplicar usuário/resposta ou vazar raciocínio", async () => {
    await ready();
    await send("analise o projeto");
    await complete();
    const snapshot = service.snapshot();
    expect(snapshot.items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(snapshot.items.filter((i) => i.kind === "assistant")).toHaveLength(1);
    expect(
      snapshot.items.find((i) => i.kind === "assistant")!.text.match(/Li o projeto/g),
    ).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /WRONG_THREAD|PRIVATE_REASONING|STALE_COMPLETED_TURN/,
    );
    expect(snapshot.metrics.totalTokens).toBe(1234);
  });
  it("não reativa turno concluído antes da resposta turn/start", async () => {
    await ready();
    await send("fluxo rápido");
    await complete();
    await service.request({ type: "newChat" });
    expect(service.snapshot().threadId).toBeNull();
  });
  it("aceita comando e envia resposta bidirecional", async () => {
    await ready();
    await send("aprovar comando");
    await approve(true);
    expect(service.snapshot().items.find((i) => i.kind === "command")?.status).toBe("completed");
    const calls = await rpc.call<{ result?: { decision?: string } }[]>("_fixture/readCalls");
    expect(calls.some((c) => c.result?.decision === "accept")).toBe(true);
  });
  it("recusa comando, impede decisão repetida e limpa aprovação", async () => {
    await ready();
    await send("recusar comando");
    await vi.waitFor(() => expect(service.snapshot().approvals.length).toBe(1));
    const id = service.snapshot().approvals[0].id;
    await approve(false);
    expect(service.snapshot().items.find((i) => i.kind === "command")?.status).toBe("declined");
    await expect(service.request({ type: "answer", id, accept: true })).rejects.toThrow(
      "resolvido",
    );
  });
  it("valida perguntas obrigatórias e devolve respostas", async () => {
    await ready();
    await send("perguntar stack");
    await vi.waitFor(() => expect(service.snapshot().approvals.length).toBe(1));
    const id = service.snapshot().approvals[0].id;
    await expect(service.request({ type: "answer", id, answers: {} })).rejects.toThrow("todas");
    await service.request({ type: "answer", id, answers: { stack: "TypeScript" } });
    await complete();
    expect(service.snapshot().approvals).toEqual([]);
  });
  it("recusa request desconhecido e permissões avançadas sem deadlock", async () => {
    await ready();
    await send("desconhecido");
    await complete();
    await send("permissao");
    await complete();
    const calls =
      await rpc.call<{ error?: unknown; result?: { permissions?: object } }[]>(
        "_fixture/readCalls",
      );
    expect(calls.some((c) => c.error)).toBe(true);
    expect(calls.some((c) => c.result?.permissions)).toBe(true);
  });
  it("protege projeto/conversa e permite interromper um turno", async () => {
    await ready();
    await send("lento");
    await expect(service.request({ type: "newChat" })).rejects.toThrow("Pare");
    await expect(service.request({ type: "selectProject" })).rejects.toThrow("Pare");
    await expect(send("outra mensagem")).rejects.toThrow("Aguarde");
    await service.request({ type: "stop" });
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("interrompida");
  });
  it("retoma histórico preservando política original", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "read" });
    await send("analise");
    await complete();
    const id = service.snapshot().threadId!;
    await vi.waitFor(() => expect(service.snapshot().threads.length).toBe(1));
    await service.request({ type: "newChat" });
    await service.request({ type: "preferences", mode: "project" });
    await service.request({ type: "resume", threadId: id });
    expect(service.snapshot().mode).toBe("read");
    expect(service.snapshot().items.some((i) => i.kind === "assistant")).toBe(true);
    await expect(service.request({ type: "resume", threadId: "other" })).rejects.toThrow(
      "indisponível",
    );
    expect((await store.load()).threads[id].mode).toBe("read");
  });
  it("mostra falha de turno e permite próxima tarefa", async () => {
    await ready();
    await send("erro");
    await complete();
    expect(service.snapshot().error).toContain("recuperável");
    await send("analise");
    await complete();
    expect(service.snapshot().error).toBeNull();
  });
  it("limpa estado quando o processo morre e pode reconectar", async () => {
    await ready();
    await send("sair");
    await vi.waitFor(() => expect(service.snapshot().connection).toBe("error"));
    expect(service.snapshot().busy).toBe(false);
    expect(service.snapshot().approvals).toEqual([]);
    await service.request({ type: "newChat" });
    await service.request({ type: "connect" });
    expect(service.snapshot().connection).toBe("ready");
  });
  it("exige consentimento Windows e usa esse acesso nas operações rotineiras", async () => {
    await ready();
    await expect(service.request({ type: "preferences", mode: "windows" })).rejects.toThrow(
      "Confirme",
    );
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
    await complete();
    expect(service.snapshot().approvals).toEqual([]);
    expect(desktop.execute).toHaveBeenCalledWith({ action: "list_windows" });
    const id = service.snapshot().threadId!;
    await service.request({ type: "newChat" });
    expect(service.snapshot().mode).toBe("project");
    await expect(service.request({ type: "resume", threadId: id })).rejects.toThrow("confirme");
  });
  it("recusar ação Windows nunca executa o driver", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await approve(false);
    expect(desktop.execute).not.toHaveBeenCalled();
  });
  it("recusa ferramenta desktop fora do modo Windows", async () => {
    await ready();
    await send("desktop forçar");
    await complete();
    expect(desktop.execute).not.toHaveBeenCalled();
    expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
  });
  it("oferece instruções de autorização e registra tools só após consentimento", async () => {
    await ready();
    await send("acessar desktop");
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("Autorizar desktop");
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await approve(false);
    const calls =
      await rpc.call<{ method?: string; params?: Record<string, unknown> }[]>("_fixture/readCalls");
    const starts = calls.filter((call) => call.method === "thread/start");
    expect(starts[0].params?.dynamicTools).toEqual([
      expect.objectContaining({ name: "stag_browser" }),
    ]);
    expect(starts[0].params?.developerInstructions).toContain("Autorizar desktop");
    expect(starts[1].params?.dynamicTools).toEqual([
      expect.objectContaining({ name: "windows_desktop" }),
      expect.objectContaining({ name: "stag_browser" }),
    ]);
    expect(starts[1].params?.developerInstructions).toContain("cliente autorizou");
    expect(starts[1].params?.developerInstructions).toContain("sem pedir permissão novamente");
    expect(starts[1].params?.developerInstructions).toContain(
      "critical e aguardam confirmação específica",
    );
    expect(starts[1].params?.developerInstructions).toContain(
      "contornar uma confirmação ou recusa",
    );
  });
  it("controla tela, foco, mouse, texto, atalhos e rolagem rotineiros sem novas aprovações", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    const expected: DesktopArguments[] = [
      { action: "list_windows" },
      { action: "screenshot" },
      { action: "focus_window", processId: 4242 },
      {
        action: "click",
        x: 120,
        y: 180,
        button: "left",
        clicks: 2,
        risk: "routine",
        intent: "Abrir editor local",
      },
      {
        action: "type_text",
        processId: 4242,
        text: "Teste + ^ % {texto}",
        risk: "routine",
        intent: "Editar texto local",
      },
      {
        action: "send_keys",
        processId: 4242,
        keys: "^s",
        risk: "routine",
        intent: "Salvar arquivo local",
      },
      { action: "scroll", x: 120, y: 180, delta: -240 },
      { action: "screenshot" },
    ];
    desktop.execute.mockImplementation(async (raw) => ({
      success: true,
      contentItems:
        (raw as DesktopArguments).action === "screenshot"
          ? [{ type: "inputImage", imageUrl: "data:image/png;base64,SYNTHETIC_SCREEN" }]
          : [{ type: "inputText", text: "[]" }],
    }));
    const approvals: number[] = [];
    service.on("snapshot", (snapshot) => approvals.push(snapshot.approvals.length));
    await send("desktop sequência");
    await complete();
    for (const [index, args] of expected.entries()) {
      expect(desktop.execute).toHaveBeenNthCalledWith(index + 1, args);
    }
    expect(approvals.every((count) => count === 0)).toBe(true);
    expect(desktop.execute).toHaveBeenCalledTimes(expected.length);
    expect(service.snapshot().items.at(-1)?.text).toContain("concluída");
    expect(JSON.stringify(service.snapshot())).not.toContain("SYNTHETIC_SCREEN");
  });
  it.each(["inválido", "risco inválido", "namespace", "outro turno", "outro thread", "sem turno"])(
    "recusa request desktop %s e libera o agente",
    async (probe) => {
      await ready();
      await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
      await send(`desktop ${probe}`);
      await complete();
      expect(desktop.execute).not.toHaveBeenCalled();
      expect(service.snapshot().approvals).toEqual([]);
    },
  );
  it.each([
    "Excluir arquivo do cliente",
    "Enviar mensagem externa",
    "Publicar alteração em produção",
    "Pagar compra",
    "Digitar credencial",
    "Alterar segurança do Windows",
  ])("confirma o ponto crítico com intenção e alvo: %s", async (intent) => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send(`desktop crítico ${intent}`);
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    expect(service.snapshot().approvals[0].detail).toContain(intent);
    expect(service.snapshot().approvals[0].detail).toContain("x=120, y=180");
    expect(desktop.execute).not.toHaveBeenCalled();
    await approve(true);
    expect(desktop.execute).toHaveBeenCalledOnce();
    await send(`desktop crítico ${intent}`);
    await approve(false);
    expect(desktop.execute).toHaveBeenCalledOnce();
  });
  it.each(["legado", "enter", "quebra"])(
    "confirma interação incerta ou que envia teclas: %s",
    async (probe) => {
      await ready();
      await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
      await send(`desktop ${probe}`);
      await approve(false);
      expect(desktop.execute).not.toHaveBeenCalled();
    },
  );
  it("responde falha automática e recupera sem repetir nem pedir aprovação rotineira", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    desktop.execute.mockRejectedValueOnce(new Error("Falha da captura sintética."));
    await send("desktop");
    await complete();
    expect(service.snapshot().metrics.failures).toBe(1);
    expect(service.snapshot().error).toBe("Falha da captura sintética.");
    expect(desktop.execute).toHaveBeenCalledOnce();
    expect(service.snapshot().approvals).toEqual([]);
    await send("desktop");
    await complete();
    expect(desktop.execute).toHaveBeenCalledTimes(2);
    expect(service.snapshot().error).toBeNull();
  });
  it("responde controle automático mesmo quando o request precede o início do turno", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop sem início");
    await complete();
    expect(desktop.execute).toHaveBeenCalledOnce();
    expect(service.snapshot().approvals).toEqual([]);
    expect(service.snapshot().items.at(-1)?.text).toContain("executado");
  });
  it.each(["", "crítico"])("pedido repetido executa apenas uma vez: %s", async (risk) => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send(`desktop ${risk} duplicado`);
    if (risk) await approve(true);
    else await complete();
    expect(desktop.execute).toHaveBeenCalledOnce();
    expect(service.snapshot().approvals).toEqual([]);
  });
  it.each([false, true])(
    "serializa rotina concorrente e cancela a fila ao interromper=%s",
    async (interrupt) => {
      await ready();
      await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const steps: string[] = [];
      desktop.execute.mockImplementation(async (raw) => {
        const action = (raw as DesktopArguments).action;
        steps.push(`start:${action}`);
        if (action === "screenshot") await blocked;
        steps.push(`finish:${action}`);
        if (interrupt) throw new Error("Falha antiga da captura sintética.");
        return { success: true, contentItems: [] };
      });
      await send("desktop paralelo");
      await vi.waitFor(() => expect(desktop.execute).toHaveBeenCalledOnce());
      // Both requests are already handled locally; the second must remain queued.
      const calls = await rpc.call<{ method?: string }[]>("_fixture/readCalls");
      expect(calls.at(-1)?.method).toBe("_fixture/readCalls");
      expect(steps).toEqual(["start:screenshot"]);
      if (interrupt) {
        await service.request({ type: "stop" });
        await complete();
        await service.request({ type: "newChat" });
      }
      release();
      if (interrupt) {
        // Drain the queue deterministically without sleeping or starting another native action.
        await vi.waitFor(() => expect(steps).toEqual(["start:screenshot", "finish:screenshot"]));
        await rpc.call("_fixture/readCalls");
        expect(desktop.execute).toHaveBeenCalledOnce();
        expect(service.snapshot().error).toBeNull();
        expect(service.snapshot().items).toEqual([]);
        expect(service.snapshot().metrics.failures).toBe(0);
      } else {
        await complete();
        expect(steps).toEqual([
          "start:screenshot",
          "finish:screenshot",
          "start:scroll",
          "finish:scroll",
        ]);
      }
    },
  );
  it.each([
    "Janela de teste indisponível.",
    "O Windows bloqueou o script de controle do STAG por uma política de execução.",
  ])("responde falha do driver e exige nova aprovação na recuperação: %s", async (message) => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    desktop.execute.mockRejectedValueOnce(new Error(message));
    await send("desktop crítico");
    await approve(true);
    expect(service.snapshot().metrics.failures).toBe(1);
    expect(service.snapshot().error).toBe(message);
    expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
    const calls =
      await rpc.call<{ result?: { contentItems?: { text?: string }[] } }[]>("_fixture/readCalls");
    expect(
      calls.some((call) => call.result?.contentItems?.some((item) => item.text === message)),
    ).toBe(true);
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    expect(desktop.execute).toHaveBeenCalledOnce();
    await approve(true);
    expect(desktop.execute).toHaveBeenCalledTimes(2);
    expect(service.snapshot().error).toBeNull();
  });
  it("interromper descarta aprovação e decisão repetida não executa duas vezes", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const stoppedId = service.snapshot().approvals[0].id;
    await service.request({ type: "stop" });
    await complete();
    await expect(service.request({ type: "answer", id: stoppedId, accept: true })).rejects.toThrow(
      "resolvido",
    );
    expect(desktop.execute).not.toHaveBeenCalled();
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const id = service.snapshot().approvals[0].id;
    const first = service.request({ type: "answer", id, accept: true });
    await expect(service.request({ type: "answer", id, accept: true })).rejects.toThrow(
      "resolvido",
    );
    await first;
    await complete();
    expect(desktop.execute).toHaveBeenCalledTimes(1);
  });
  it("parar descarta a aprovação antes de o servidor confirmar a interrupção", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const id = service.snapshot().approvals[0].id;
    const call = rpc.call.bind(rpc);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(rpc, "call").mockImplementation(async (method, params) => {
      if (method === "turn/interrupt") await blocked;
      return call(method, params);
    });
    const stopping = service.request({ type: "stop" });
    expect(service.snapshot().approvals).toEqual([]);
    await expect(service.request({ type: "answer", id, accept: true })).rejects.toThrow(
      "resolvido",
    );
    expect(desktop.execute).not.toHaveBeenCalled();
    release();
    await stopping;
    await complete();
  });
  it("falha ao interromper encerra a conexão e permite recuperar sem ação indevida", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    vi.spyOn(rpc, "call").mockRejectedValueOnce(new Error("Interrupção sintética falhou."));
    await expect(service.request({ type: "stop" })).rejects.toThrow("Interrupção sintética falhou");
    await vi.waitFor(() => expect(service.snapshot().connection).toBe("error"));
    expect(service.snapshot().approvals).toEqual([]);
    expect(service.snapshot().busy).toBe(false);
    expect(desktop.execute).not.toHaveBeenCalled();
    await service.request({ type: "newChat" });
    await service.request({ type: "connect" });
    expect(service.snapshot().connection).toBe("ready");
  });
  it("reconecta a mesma conversa Windows e restaura as tools sem renovar acesso", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await approve(false);
    const threadId = service.snapshot().threadId!;
    await service.request({ type: "connect" });
    expect(service.snapshot().threadId).toBe(threadId);
    expect(service.snapshot().mode).toBe("windows");
    await send("desktop crítico");
    await approve(true);
    expect(desktop.execute).toHaveBeenCalledTimes(1);
    await send("desktop");
    await complete();
    expect(service.snapshot().approvals).toEqual([]);
    expect(desktop.execute).toHaveBeenCalledTimes(2);
  });
  it("resultado de desktop interrompido não contamina uma nova conversa", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    let fail!: (error: Error) => void;
    desktop.execute.mockImplementationOnce(
      () =>
        new Promise<ToolResult>((_resolve, reject) => {
          fail = reject;
        }),
    );
    await send("desktop crítico");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const answering = service.request({
      type: "answer",
      id: service.snapshot().approvals[0].id,
      accept: true,
    });
    await vi.waitFor(() => expect(desktop.execute).toHaveBeenCalledOnce());
    await service.request({ type: "stop" });
    await complete();
    await service.request({ type: "newChat" });
    fail(new Error("Falha antiga de desktop."));
    await answering;
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().approvals).toEqual([]);
    expect(service.snapshot().items).toEqual([]);
  });
  it("consentimento não migra para outra conversa Windows", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await approve(false);
    const first = service.snapshot().threadId!;
    await service.request({ type: "newChat" });
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop crítico");
    await approve(false);
    await expect(service.request({ type: "resume", threadId: first })).rejects.toThrow("confirme");
    await service.request({ type: "newChat" });
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await service.request({ type: "resume", threadId: first });
    await send("desktop crítico");
    await approve(true);
    expect((await store.load()).threads[first].mode).toBe("windows");
  });
});

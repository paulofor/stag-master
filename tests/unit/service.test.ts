import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AssistantService } from "../../src/main/service";
import { RpcClient } from "../../src/main/rpc";
import { SettingsStore } from "../../src/main/settings";
import { codexEnvironment } from "../../src/main/policy";
import type { DesktopArguments, ToolResult } from "../../src/main/desktop-tools";

let dir: string;
let service: AssistantService;
let rpc: RpcClient;
let store: SettingsStore;
const openExternal = vi.fn(async (_url: string) => {});
const desktop = {
  execute: vi.fn(async (_args: unknown): Promise<ToolResult> => ({
    success: true,
    contentItems: [{ type: "inputText" as const, text: "[]" }],
  })),
};
beforeEach(async () => {
  await mkdir(resolve(".local"), { recursive: true });
  dir = await mkdtemp(resolve(".local/service-test-"));
  store = new SettingsStore(resolve(dir, "settings.json"));
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
    selectProject: async () => dir,
    desktop,
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
  it("exige consentimento Windows e aprovação antes do controle nativo", async () => {
    await ready();
    await expect(service.request({ type: "preferences", mode: "windows" })).rejects.toThrow(
      "Confirme",
    );
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
    await vi.waitFor(() => expect(service.snapshot().approvals.length).toBe(1));
    expect(desktop.execute).not.toHaveBeenCalled();
    await approve(true);
    expect(desktop.execute).toHaveBeenCalledWith({ action: "list_windows" });
    const id = service.snapshot().threadId!;
    await service.request({ type: "newChat" });
    expect(service.snapshot().mode).toBe("project");
    await expect(service.request({ type: "resume", threadId: id })).rejects.toThrow("confirme");
  });
  it("recusar ação Windows nunca executa o driver", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
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
    await send("desktop");
    await approve(false);
    const calls =
      await rpc.call<{ method?: string; params?: Record<string, unknown> }[]>("_fixture/readCalls");
    const starts = calls.filter((call) => call.method === "thread/start");
    expect(starts[0].params?.dynamicTools).toBeUndefined();
    expect(starts[0].params?.developerInstructions).toContain("Autorizar desktop");
    expect(starts[1].params?.dynamicTools).toEqual([
      expect.objectContaining({ name: "windows_desktop" }),
    ]);
    expect(starts[1].params?.developerInstructions).toContain("cliente autorizou");
  });
  it("controla tela, foco, mouse, texto, atalhos e rolagem com aprovação por operação", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    const expected: DesktopArguments[] = [
      { action: "list_windows" },
      { action: "screenshot" },
      { action: "focus_window", processId: 4242 },
      { action: "click", x: 120, y: 180, button: "left", clicks: 2 },
      { action: "type_text", processId: 4242, text: "Teste + ^ % {texto}" },
      { action: "send_keys", processId: 4242, keys: "^s" },
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
    await send("desktop sequência");
    for (const [index, args] of expected.entries()) {
      await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
      expect(desktop.execute).toHaveBeenCalledTimes(index);
      const approval = service.snapshot().approvals[0];
      if (args.action === "screenshot") expect(approval.detail).toContain("enviada ao ChatGPT");
      await service.request({ type: "answer", id: approval.id, accept: true });
      expect(desktop.execute).toHaveBeenNthCalledWith(index + 1, args);
    }
    await complete();
    expect(service.snapshot().items.at(-1)?.text).toContain("concluída");
    expect(JSON.stringify(service.snapshot())).not.toContain("SYNTHETIC_SCREEN");
  });
  it.each(["inválido", "namespace", "outro turno"])(
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
  it("falha do driver é respondida e a próxima tarefa funciona", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    desktop.execute.mockRejectedValueOnce(new Error("Janela de teste indisponível."));
    await send("desktop");
    await approve(true);
    expect(service.snapshot().metrics.failures).toBe(1);
    expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
    const calls =
      await rpc.call<{ result?: { contentItems?: { text?: string }[] } }[]>("_fixture/readCalls");
    expect(
      calls.some((call) =>
        call.result?.contentItems?.some((item) => item.text?.includes("indisponível")),
      ),
    ).toBe(true);
    await send("analise");
    await complete();
    expect(service.snapshot().error).toBeNull();
  });
  it("interromper descarta aprovação e decisão repetida não executa duas vezes", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
    await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
    const stoppedId = service.snapshot().approvals[0].id;
    await service.request({ type: "stop" });
    await complete();
    await expect(service.request({ type: "answer", id: stoppedId, accept: true })).rejects.toThrow(
      "resolvido",
    );
    expect(desktop.execute).not.toHaveBeenCalled();
    await send("desktop");
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
  it("reconecta a mesma conversa Windows e restaura as tools sem renovar acesso", async () => {
    await ready();
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
    await approve(false);
    const threadId = service.snapshot().threadId!;
    await service.request({ type: "connect" });
    expect(service.snapshot().threadId).toBe(threadId);
    expect(service.snapshot().mode).toBe("windows");
    await send("desktop");
    await approve(true);
    expect(desktop.execute).toHaveBeenCalledTimes(1);
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
    await send("desktop");
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
    await send("desktop");
    await approve(false);
    const first = service.snapshot().threadId!;
    await service.request({ type: "newChat" });
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await send("desktop");
    await approve(false);
    await expect(service.request({ type: "resume", threadId: first })).rejects.toThrow("confirme");
    await service.request({ type: "newChat" });
    await service.request({ type: "preferences", mode: "windows", windowsConsent: true });
    await service.request({ type: "resume", threadId: first });
    await send("desktop");
    await approve(true);
    expect((await store.load()).threads[first].mode).toBe("windows");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { AssistantService } from "../../src/main/service";
import { RpcClient } from "../../src/main/rpc";
import { SettingsStore } from "../../src/main/settings";

let dir: string;
let service: AssistantService;
let rpc: RpcClient;
let store: SettingsStore;
const openExternal = vi.fn(async (_url: string) => {});
const desktop = {
  execute: vi.fn(async () => ({
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
  vi.clearAllMocks();
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
    await send("desktop");
    await complete();
    expect(desktop.execute).not.toHaveBeenCalled();
    expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
  });
});

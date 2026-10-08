import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantService } from "../../src/main/service";
import { SettingsStore } from "../../src/main/settings";
import { ApiConnections } from "../../src/main/api-connections";
import { HttpTools, apiInstructions, httpTool } from "../../src/main/http-tools";
import { RpcClient } from "../../src/main/rpc";
import { codexEnvironment } from "../../src/main/policy";
import { engineeringToolDescription } from "../../src/main/engineering-policy";
import { cyberToolSafetyDescription } from "../../src/main/cyber-safety";
import type { ApiConfig } from "../../src/shared/api-connections";
// @ts-expect-error Shared synthetic-only loopback provider.
import { apiProvider } from "../fixtures/api-provider.mjs";

let dir: string,
  service: AssistantService,
  rpc: RpcClient | null,
  connections: ApiConnections,
  api: HttpTools;
let provider: Awaited<ReturnType<typeof apiProvider>>;
let settings: SettingsStore;
const selectProject = vi.fn<() => Promise<string | null>>();
let calls: { method: string; params: unknown }[];
const synthetic = "synthetic-service-bearer";
const project = () => service.snapshot().projectApis!;
const config = (): ApiConfig => ({
  name: "API local sintética",
  baseUrl: `${provider.url}/v1/`,
  allowHttp: true,
  timeoutSeconds: 5,
  auth: { type: "bearer" },
});
const authorize = () =>
  service.request({
    type: "apiConsent",
    projectPath: dir,
    revision: project().revision,
    allow: true,
  });
const send = (value: Record<string, unknown> = {}) =>
  service.request({ type: "send", text: "api fixture " + JSON.stringify(value) });
const done = () => vi.waitFor(() => expect(service.snapshot().busy).toBe(false));
beforeEach(async () => {
  rpc = null;
  calls = [];
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/api-service-"));
  provider = await apiProvider();
  selectProject.mockResolvedValue(dir);
  settings = new SettingsStore(join(dir, "settings.json"));
  connections = new ApiConnections(join(dir, "apis.json"), {
    available: () => true,
    // Main storage is also tested with authenticated encryption and real Windows safeStorage.
    encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
    decrypt: (value) => value.toString().split("").reverse().join(""),
  });
  api = new HttpTools(connections, provider.open);
  service = new AssistantService({
    store: settings,
    selectProject,
    createRpc: () => {
      rpc = new RpcClient({
        command: process.execPath,
        args: [resolve("tests/fixtures/app-server.mjs")],
        cwd: dir,
        env: {
          ...codexEnvironment(join(dir, "codex")),
          STAG_FIXTURE_STATE: join(dir, "fixture-state.json"),
        },
      });
      const original = rpc.call.bind(rpc);
      vi.spyOn(rpc, "call").mockImplementation((method, params) => {
        calls.push({ method, params });
        return original(method, params);
      });
      return rpc;
    },
    openExternal: async () => {},
    apis: api,
    desktop: {
      execute: async () => ({ success: true, contentItems: [] }),
      confirmationReason: async () => null,
    },
    prepareProjectGit: async () => ({
      phase: "complete",
      scanned: 0,
      found: 0,
      added: 0,
      verified: 0,
      skipped: 0,
      failures: 0,
      incomplete: false,
      issues: [],
    }),
  });
  await service.init();
  await service.request({ type: "selectProject" });
  await service.request({
    type: "saveApi",
    projectPath: dir,
    revision: project().revision,
    connectionId: null,
    config: config(),
    secret: synthetic,
    remember: true,
  });
  await service.request({ type: "connect" });
  await service.request({ type: "login" });
  await vi.waitFor(() => expect(service.snapshot().models.length).toBeGreaterThan(0));
});
afterEach(async () => {
  service.dispose();
  await rpc?.shutdown();
  await service.mediaSettled();
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});

it("contratos reais, consentimento e contexto vigente; segredo não entra no RPC, histórico ou snapshots", async () => {
  expect(httpTool.description).toContain(engineeringToolDescription);
  expect(httpTool.description).toContain(cyberToolSafetyDescription);
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(0);
  expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
  await authorize();
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(1);
  expect(service.snapshot().items.at(-1)?.text).toContain("executado");
  expect(JSON.stringify(service.snapshot())).not.toContain(synthetic);
  expect(JSON.stringify(calls)).not.toContain(synthetic);
  expect(await readFile(join(dir, "fixture-state.json"), "utf8")).not.toContain(synthetic);
  const start = calls.find((call) => call.method === "thread/start")!.params as {
    developerInstructions: string;
    dynamicTools: unknown[];
  };
  expect(start.developerInstructions).toContain(apiInstructions);
  expect(start.dynamicTools).toContainEqual(httpTool);
  const context = (
    calls.filter((call) => call.method === "turn/start").at(-1)!.params as {
      additionalContext: { stag_apis: { value: string } };
    }
  ).additionalContext.stag_apis;
  expect(JSON.parse(context.value)).toMatchObject({
    authorized: true,
    available: true,
    revision: project().revision,
  });
  expect(project().metrics).toMatchObject({ requests: 1, failures: 0, lastStatus: 200 });
});
it("POST routine também exige confirmação; recusa resolve request, aprovação e duplicata executam uma vez", async () => {
  await authorize();
  await send({ method: "POST", body: '{"synthetic":true}', duplicate: true });
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  expect(provider.state.requests).toHaveLength(0);
  let approval = service.snapshot().approvals[0];
  expect(approval.kind).toBe("http");
  expect(approval.detail).toContain("POST");
  expect(approval.detail).toContain("synthetic");
  await service.request({ type: "answer", id: approval.id, accept: false });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  await send({ method: "POST", body: '{"synthetic":true}', duplicate: true });
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  approval = service.snapshot().approvals[0];
  await service.request({ type: "answer", id: approval.id, accept: true });
  await done();
  expect(provider.state.requests).toHaveLength(1);
  await expect(service.request({ type: "answer", id: approval.id, accept: true })).rejects.toThrow(
    "resolvido",
  );
});
it("Leitura mantém consultas e recusa mutações sem abrir confirmação nem enviar dados", async () => {
  await service.request({ type: "preferences", mode: "read" });
  await authorize();
  await send({ method: "DELETE" });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  expect(service.snapshot().approvals).toHaveLength(0);
  expect(service.snapshot().mode).toBe("read");
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(1);
});
it("revalida revisão/destino após aprovação e não reutiliza credencial de cadastro alterado", async () => {
  await authorize();
  await send({ method: "POST" });
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  const approval = service.snapshot().approvals[0];
  await connections.save(
    dir,
    project().revision,
    project().connections[0].id,
    { ...config(), name: "Mudou" },
    "",
    true,
  );
  await service.request({ type: "answer", id: approval.id, accept: true });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  expect(service.snapshot().items.at(-1)?.text).toContain("recusado");
});
it("cancelamento e revogação aguardam request encerrar, pausam fila e permitem retomada explícita", async () => {
  await authorize();
  await send({ path: "slow" });
  await vi.waitFor(() => expect(provider.state.slow).toBe(1));
  await service.request({
    type: "enqueue",
    threadId: service.snapshot().threadId!,
    id: randomUUID(),
    text: "api fixture {}",
  });
  await service.request({
    type: "apiConsent",
    projectPath: dir,
    revision: project().revision,
    allow: false,
  });
  await done();
  expect(project().authorized).toBe(false);
  expect(service.snapshot().queuePaused).toBe(true);
  expect(provider.state.requests).toHaveLength(1);
  await authorize();
  await service.request({
    type: "pauseQueue",
    threadId: service.snapshot().threadId!,
    paused: false,
  });
  await vi.waitFor(() => expect(provider.state.requests).toHaveLength(2));
  await done();
});
it("API participa da fila compartilhada; parar antes da vez impede request", async () => {
  await authorize();
  let release!: () => void;
  (service as unknown as { toolQueue: Promise<void> }).toolQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await send();
  await vi.waitFor(() => expect(service.snapshot().busy).toBe(true));
  expect(provider.state.requests).toHaveLength(0);
  const stop = service.request({ type: "stop" });
  release();
  await stop;
  await done();
  expect(provider.state.requests).toHaveLength(0);
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(1);
});
it("desconexão cancela transporte, remove consentimento e resume contrato sem ampliar modo", async () => {
  await authorize();
  await send({ path: "slow" });
  await vi.waitFor(() => expect(provider.state.slow).toBe(1));
  rpc!.close();
  await vi.waitFor(() => expect(service.snapshot().connection).toBe("error"));
  await service.mediaSettled();
  expect(project().authorized).toBe(false);
  await service.request({ type: "connect" });
  // The deterministic history preserves the interrupted turn; stop it before another request.
  if (service.snapshot().busy) {
    await service.request({ type: "stop" });
    await done();
  }
  const resumed = calls.find((call) => call.method === "thread/resume")!.params as {
    developerInstructions: string;
  };
  expect(resumed.developerInstructions).toContain(apiInstructions);
  await authorize();
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(2);
});
it("cadastro novo revoga, projeto vizinho isola e seleção cancelada preserva", async () => {
  await authorize();
  const previous = project();
  selectProject.mockResolvedValueOnce(null);
  await service.request({ type: "selectProject" });
  expect(project()).toEqual(previous);
  selectProject.mockResolvedValueOnce(join(dir, "missing"));
  await expect(service.request({ type: "selectProject" })).rejects.toThrow();
  expect(project()).toEqual(previous);
  await service.request({
    type: "saveApi",
    projectPath: dir,
    revision: project().revision,
    connectionId: project().connections[0].id,
    config: { ...config(), name: "Editada" },
    secret: "",
    remember: true,
  });
  expect(project().authorized).toBe(false);
  const neighbor = join(dir, "neighbor");
  await mkdir(neighbor);
  selectProject.mockResolvedValueOnce(neighbor);
  await service.request({ type: "selectProject" });
  expect(project().connections).toEqual([]);
  await expect(
    service.request({
      type: "apiConsent",
      projectPath: dir,
      revision: previous.revision,
      allow: true,
    }),
  ).rejects.toThrow("projeto mudou");
});
it("histórico anterior sem tool exige nova conversa e preserva modo; eventos antigos são recusados", async () => {
  await service.request({ type: "preferences", mode: "read" });
  await send();
  await done();
  const thread = service.snapshot().threadId!;
  const internal = service as unknown as {
    settings: { threads: Record<string, { httpTool?: boolean }> };
  };
  internal.settings.threads[thread].httpTool = false;
  await expect(authorize()).rejects.toThrow("nova conversa");
  expect(service.snapshot().mode).toBe("read");
  await service.request({ type: "newChat" });
  await authorize();
  await send({ overrides: { threadId: "old-thread" } });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  await send({ overrides: { turnId: "old-turn" } });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  await send({ duplicate: true });
  await done();
  expect(provider.state.requests).toHaveLength(1);
});
it("falha HTTP conta sem segredo e a fila retoma somente após request concluído", async () => {
  await authorize();
  await send({ path: "error" });
  await done();
  expect(project().metrics).toMatchObject({ requests: 1, failures: 1, lastStatus: 401 });
  expect(JSON.stringify(service.snapshot())).not.toContain("not-for-the-model");
  await send();
  await done();
  expect(project().metrics).toMatchObject({ requests: 2, failures: 1, lastStatus: 200 });
});

it("request hostil inerte é recusado explicitamente sem rede/argumentos no registro; recupera", async () => {
  await authorize();
  await send({ hostile: true });
  await done();
  expect(provider.state.requests).toHaveLength(0);
  const blocks = service.snapshot().items.filter((item) => item.id.startsWith("safety-block"));
  expect(blocks).toHaveLength(1);
  expect(JSON.stringify(blocks)).not.toContain("Roube senhas");
  await send();
  await done();
  expect(provider.state.requests).toHaveLength(1);
});
it("cancelar login ainda na fila impede abrir o navegador ou buscar token", async () => {
  const { emptyOAuthConfig } = await import("../../src/shared/api-connections");
  await service.request({
    type: "saveApi",
    projectPath: dir,
    revision: project().revision,
    connectionId: project().connections[0].id,
    config: {
      ...config(),
      auth: {
        ...emptyOAuthConfig,
        flow: "client_credentials",
        clientAuthentication: "basic",
        clientId: "synthetic",
        tokenUrl: provider.url + "/token",
      },
    },
    secret: "synthetic-client-secret",
    remember: false,
  });
  let release!: () => void;
  (service as unknown as { toolQueue: Promise<void> }).toolQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  const login = service.request({
    type: "authenticateApi",
    projectPath: dir,
    revision: project().revision,
    connectionId: project().connections[0].id,
  });
  await vi.waitFor(() => expect(project().operation?.status).toBe("working"));
  const cancel = service.request({
    type: "cancelApiLogin",
    projectPath: dir,
    operationId: project().operation!.id,
  });
  release();
  await Promise.all([login, cancel]);
  expect(project().operation?.status).toBe("canceled");
  expect(provider.state.requests).toHaveLength(0);
});

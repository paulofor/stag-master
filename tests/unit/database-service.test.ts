import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseConnections } from "../../src/main/database-connections";
import { AssistantService } from "../../src/main/service";
import { SettingsStore } from "../../src/main/settings";
import { RpcClient } from "../../src/main/rpc";
import { codexEnvironment } from "../../src/main/policy";
import { emptySqlServerConfig, type SqlServerConfig } from "../../src/shared/database-connections";
import type { Action } from "../../src/shared/types";

let dir: string, service: AssistantService;
let connections: DatabaseConnections;
let rpc: RpcClient | null = null;
const password = "service synthetic secret !";
const config: SqlServerConfig = {
  ...emptySqlServerConfig,
  name: "Teste",
  server: "localhost",
  database: "stag_fixture",
  user: "fixture",
};
const tester = vi.fn(
  async (_config: SqlServerConfig, _password: string, _signal: AbortSignal) => {},
);
const select = vi.fn<() => Promise<string | null>>();
beforeEach(async () => {
  rpc = null;
  vi.clearAllMocks();
  tester.mockResolvedValue();
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/database-service-"));
  select.mockResolvedValue(dir);
  connections = new DatabaseConnections(join(dir, "connections.json"), {
    available: () => true,
    // The storage mechanism itself is exercised with authenticated encryption and real DPAPI elsewhere.
    encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
    decrypt: (value) => value.toString().split("").reverse().join(""),
  });
  service = new AssistantService({
    createRpc: () =>
      (rpc = new RpcClient({
        command: process.execPath,
        args: [resolve("tests/fixtures/app-server.mjs")],
        cwd: dir,
        env: codexEnvironment(join(dir, "codex")),
      })),
    store: new SettingsStore(join(dir, "settings.json")),
    selectProject: select,
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
    openExternal: async () => {},
    desktop: {
      execute: async () => ({ success: false, contentItems: [] }),
      confirmationReason: async () => "synthetic",
    },
    databases: { connections, test: tester },
  });
  await service.init();
  await service.request({ type: "selectProject" });
});
afterEach(async () => {
  service.dispose();
  // Closing the transport initiates termination; Windows keeps the child's cwd locked
  // until it actually exits. Await the existing shutdown before deleting the fixture.
  await rpc?.shutdown();
  await service.mediaSettled();
  await rm(dir, { recursive: true, force: true });
});
const testAction = (): Extract<Action, { type: "testDatabase" }> => ({
  type: "testDatabase",
  projectPath: dir,
  revision: service.snapshot().projectDatabases!.revision,
  connectionId: null,
  testId: randomUUID(),
  config,
  password,
});
const saveAction = (): Extract<Action, { type: "saveDatabase" }> => ({
  type: "saveDatabase",
  projectPath: dir,
  revision: service.snapshot().projectDatabases!.revision,
  connectionId: null,
  config,
  password,
  rememberPassword: true,
});

it("configura/testa em Leitura sem alterar política, tokens, conversa ou transmitir senha ao RPC", async () => {
  await service.request({ type: "connect" });
  await service.request({ type: "preferences", mode: "read" });
  const snapshots: string[] = [];
  service.on("snapshot", (state) => snapshots.push(JSON.stringify(state)));
  const before = service.snapshot();
  await service.request(saveAction());
  const state = service.snapshot().projectDatabases!;
  const action = { ...testAction(), connectionId: state.connections[0].id, password: "" };
  await service.request(action);
  expect(tester).toHaveBeenCalledWith(config, password, expect.any(AbortSignal));
  const after = service.snapshot();
  expect(after.mode).toBe("read");
  expect(after.items).toEqual(before.items);
  expect(after.metrics.requests).toBe(before.metrics.requests);
  expect(after.metrics.totalTokens).toBe(before.metrics.totalTokens);
  expect(after.projectDatabases?.test).toMatchObject({
    status: "success",
    elapsedMs: expect.any(Number),
  });
  expect(snapshots.join()).not.toContain(password);
  expect(snapshots.join()).not.toContain("encryptedPassword");
  expect(await readFile(join(dir, "settings.json"), "utf8")).not.toContain(password);
});
it("erro do provedor com segredo é sanitizado, conta falha e permite próximo teste", async () => {
  tester.mockRejectedValueOnce(new Error(`raw provider ${password}`));
  await service.request(testAction());
  expect(service.snapshot().projectDatabases?.test).toMatchObject({ status: "error" });
  expect(JSON.stringify(service.snapshot())).not.toContain(password);
  expect(service.snapshot().metrics.failures).toBe(1);
  await service.request(testAction());
  expect(service.snapshot().projectDatabases?.test?.status).toBe("success");
});
it("teste idempotente, revisão e ids antigos não abrem outra sessão", async () => {
  const action = testAction();
  await service.request(action);
  await service.request(action);
  expect(tester).toHaveBeenCalledTimes(1);
  await service.request(saveAction());
  await expect(service.request({ ...action, testId: randomUUID() })).rejects.toThrow("mudaram");
  await expect(service.request({ ...testAction(), connectionId: randomUUID() })).rejects.toThrow(
    "não encontrada",
  );
  expect(tester).toHaveBeenCalledTimes(1);
});
it("cancelamento aguarda limpeza, descarta sucesso tardio e recupera sem sobrepor sessões", async () => {
  let started!: () => void, cleanup!: () => void;
  const handshake = new Promise<void>((resolve) => {
    started = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    cleanup = resolve;
  });
  tester.mockImplementationOnce(async (_config, _password, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await closed;
  });
  const action = testAction();
  const work = service.request(action);
  await handshake;
  expect(service.snapshot().projectDatabases?.test?.status).toBe("testing");
  await expect(service.request({ ...action, testId: randomUUID() })).rejects.toThrow("Aguarde");
  await expect(
    service.request({ type: "cancelDatabaseTest", projectPath: dir, testId: randomUUID() }),
  ).rejects.toThrow("outra solicitação");
  let settled = false;
  const cancel = service
    .request({ type: "cancelDatabaseTest", projectPath: dir, testId: action.testId })
    .then(() => {
      settled = true;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  cleanup();
  await Promise.all([work, cancel]);
  expect(service.snapshot().projectDatabases?.test?.status).toBe("canceled");
  await service.request(testAction());
  expect(service.snapshot().projectDatabases?.test?.status).toBe("success");
});
it("usa a fila compartilhada, parada cancela e fechamento espera a sessão", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  (service as unknown as { toolQueue: Promise<void> }).toolQueue = gate;
  const work = service.request(testAction());
  await Promise.resolve();
  expect(tester).not.toHaveBeenCalled();
  // Stop cancels before the queued probe can reach the driver.
  const stop = service.request({ type: "stop" });
  release();
  await Promise.all([work, stop]);
  expect(tester).not.toHaveBeenCalled();
  let accepted!: () => void;
  const handshake = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  tester.mockImplementationOnce(async (_config, _password, signal) => {
    accepted();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const running = service.request(testAction());
  await handshake;
  service.dispose();
  await service.mediaSettled();
  await running;
  expect(tester).toHaveBeenCalledTimes(1);
});
it("perda da conexão Codex cancela e limpa teste sem deixar resultado em execução; recupera independente da conta", async () => {
  await service.request({ type: "connect" });
  let accepted!: () => void;
  const handshake = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  tester.mockImplementationOnce(async (_config, _password, signal) => {
    accepted();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const work = service.request(testAction());
  await handshake;
  rpc!.close();
  await work;
  expect(service.snapshot().projectDatabases?.test?.status).toBe("canceled");
  await service.request(testAction());
  expect(service.snapshot().projectDatabases?.test?.status).toBe("success");
});
it("projetos isolados, seleção cancelada/inválida preserva, envio antigo é recusado", async () => {
  await service.request(saveAction());
  const before = service.snapshot().projectDatabases;
  select.mockResolvedValueOnce(null);
  await service.request({ type: "selectProject" });
  expect(service.snapshot().projectDatabases).toEqual(before);
  select.mockResolvedValueOnce(join(dir, "missing"));
  await expect(service.request({ type: "selectProject" })).rejects.toThrow();
  expect(service.snapshot().projectDatabases).toEqual(before);
  const neighbor = join(dir, "neighbor");
  await mkdir(neighbor);
  select.mockResolvedValueOnce(neighbor);
  await service.request({ type: "selectProject" });
  expect(service.snapshot().projectDatabases?.connections).toEqual([]);
  await expect(service.request({ ...testAction(), projectPath: dir })).rejects.toThrow(
    "projeto mudou",
  );
  select.mockResolvedValueOnce(dir);
  await service.request({ type: "selectProject" });
  expect(service.snapshot().projectDatabases?.connections).toHaveLength(1);
});
it("falha de persistência e arquivo corrompido preservam outros recursos e não inventam salvamento", async () => {
  await mkdir(join(dir, "connections.json.tmp"));
  await expect(service.request(saveAction())).rejects.toThrow("preservados");
  expect(service.snapshot().projectDatabases?.connections).toEqual([]);
  await rm(join(dir, "connections.json.tmp"), { recursive: true });
  await service.request(saveAction());
  expect(service.snapshot().projectDatabases?.connections).toHaveLength(1);
  await writeFile(join(dir, "connections.json"), "corrupt synthetic");
  // Explicit init failure doesn't publish an empty, writable replacement.
  await service.init();
  expect(service.snapshot().error).toContain("carregar as conexões");
  expect(service.snapshot().projectDatabases).toBeNull();
  await expect(
    service.request({
      type: "saveDatabase",
      projectPath: dir,
      revision: randomUUID(),
      connectionId: null,
      config,
      password,
      rememberPassword: false,
    }),
  ).rejects.toThrow("indisponíveis");
  expect(service.snapshot().project?.path).toBe(dir);
});

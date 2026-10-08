import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantService } from "../../src/main/service";
import { SettingsStore } from "../../src/main/settings";
import { DatabaseConnections } from "../../src/main/database-connections";
import { SqlTools, sqlInstructions, sqlTool, type SqlQueryRunner } from "../../src/main/sql-tools";
import { emptySqlServerConfig } from "../../src/shared/database-connections";
import { RpcClient } from "../../src/main/rpc";
import { codexEnvironment } from "../../src/main/policy";
import { cyberSafetyRefusal } from "../../src/main/cyber-safety";
const password = "synthetic-SQL-service-password";
const config = {
  ...emptySqlServerConfig,
  name: "Base sintética",
  server: "localhost",
  database: "stag_fixture",
  user: "fixture",
};
let dir: string,
  service: AssistantService,
  store: DatabaseConnections,
  settings: SettingsStore,
  rpc: RpcClient | null;
let calls: { method: string; params: unknown }[];
const runner = vi.fn<SqlQueryRunner>();
const select = vi.fn<() => Promise<string | null>>();
const project = () => service.snapshot().projectDatabases!;
const authorize = (allow = true) =>
  service.request({
    type: "databaseConsent",
    projectPath: dir,
    revision: project().revision,
    allow,
  });
const send = (value: Record<string, unknown> = {}) =>
  service.request({ type: "send", text: "sql fixture " + JSON.stringify(value) });
// The reverse response is followed by persisted authoritative turn/completed.
// Give that event the fixture's normal I/O margin, also on busy Windows runners.
const done = () => vi.waitFor(() => expect(service.snapshot().busy).toBe(false), { timeout: 5000 });
beforeEach(async () => {
  rpc = null;
  calls = [];
  runner.mockReset();
  runner.mockResolvedValue({
    columns: ["id", "status"],
    rows: [[10039, "synthetic verified"]],
    affectedRows: 0,
    truncated: false,
  });
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/sql-service-"));
  select.mockResolvedValue(dir);
  settings = new SettingsStore(join(dir, "settings.json"));
  store = new DatabaseConnections(join(dir, "connections.json"), {
    available: () => true,
    encrypt: (value) => Buffer.from(value.split("").reverse().join("")),
    decrypt: (value) => value.toString().split("").reverse().join(""),
  });
  service = new AssistantService({
    store: settings,
    selectProject: select,
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
      const call = rpc.call.bind(rpc);
      vi.spyOn(rpc, "call").mockImplementation((method, params) => {
        calls.push({ method, params });
        return call(method, params);
      });
      return rpc;
    },
    databases: { connections: store, test: async () => {}, tools: new SqlTools(store, runner) },
    desktop: {
      execute: async () => ({ success: true, contentItems: [] }),
      confirmationReason: async () => null,
    },
    openExternal: async () => {},
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
    type: "saveDatabase",
    projectPath: dir,
    revision: project().revision,
    connectionId: null,
    config,
    password,
    rememberPassword: true,
  });
  await service.request({ type: "connect" });
  await service.request({ type: "login" });
  await vi.waitFor(() => expect(service.snapshot().models.length).toBeGreaterThan(0));
});
afterEach(async () => {
  service.dispose();
  await rpc?.shutdown();
  await service.mediaSettled();
  await rm(dir, { recursive: true, force: true });
});

it("registro real, consentimento e contexto vigente em cada turno; não procura JDBC nem transmite senha", async () => {
  await send();
  await done();
  expect(runner).not.toHaveBeenCalled();
  expect(service.snapshot().items.at(-1)?.text).toContain("Autorizar bancos");
  await authorize();
  await send({
    sql: "SELECT id FROM dbo.remessas WHERE id=@id",
    parameters: [{ name: "id", type: "int", value: 10039 }],
  });
  await done();
  expect(runner).toHaveBeenCalledWith(
    config,
    password,
    expect.objectContaining({ operation: "query" }),
    expect.any(AbortSignal),
  );
  expect(service.snapshot().items.at(-1)?.text).toContain("10039");
  const start = calls.find((call) => call.method === "thread/start")!.params as {
    developerInstructions: string;
    dynamicTools: unknown[];
  };
  expect(start.dynamicTools).toContainEqual(sqlTool);
  expect(start.developerInstructions).toContain(sqlInstructions);
  const turn = calls.filter((call) => call.method === "turn/start").at(-1)!.params as {
    additionalContext: { stag_databases: { kind: string; value: string } };
  };
  expect(turn.additionalContext.stag_databases.kind).toBe("untrusted");
  expect(JSON.parse(turn.additionalContext.stag_databases.value)).toMatchObject({
    available: true,
    authorized: true,
    revision: project().revision,
  });
  for (const value of [
    JSON.stringify(service.snapshot()),
    JSON.stringify(calls),
    await readFile(join(dir, "fixture-state.json"), "utf8"),
    await readFile(join(dir, "settings.json"), "utf8"),
  ])
    expect(value).not.toContain(password);
  expect(project().metrics).toMatchObject({ requests: 1, failures: 0, lastRows: 1 });
});
it("INSERT routine pede aprovação concreta; recusa resolve e aprovação/duplicata executam uma vez", async () => {
  await authorize();
  const input = {
    operation: "execute",
    sql: "INSERT INTO dbo.remessas (id) VALUES (@id)",
    parameters: [{ name: "id", type: "int", value: 10039 }],
    duplicate: true,
  };
  await send(input);
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  let approval = service.snapshot().approvals[0];
  expect(approval.kind).toBe("sql");
  expect(approval.detail).toContain("stag_fixture");
  expect(approval.detail).toContain(input.sql);
  expect(approval.detail).toContain("10039");
  expect(approval.detail).not.toContain(password);
  expect(runner).not.toHaveBeenCalled();
  await service.request({ type: "answer", id: approval.id, accept: false });
  await done();
  expect(runner).not.toHaveBeenCalled();
  await send(input);
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  approval = service.snapshot().approvals[0];
  await service.request({ type: "answer", id: approval.id, accept: true });
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  await expect(service.request({ type: "answer", id: approval.id, accept: true })).rejects.toThrow(
    "resolvido",
  );
});
it("Leitura conserva consultas e recusa escrita sem card nem sessão; revisão após aprovação é revalidada", async () => {
  await service.request({ type: "preferences", mode: "read" });
  await authorize();
  await send({ operation: "execute", sql: "DELETE FROM dbo.remessas WHERE id=10039" });
  await done();
  expect(runner).not.toHaveBeenCalled();
  expect(service.snapshot().approvals).toHaveLength(0);
  await send();
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  expect(service.snapshot().mode).toBe("read");
  await service.request({ type: "preferences", mode: "project" });
  await authorize();
  await send({ operation: "execute", sql: "DELETE FROM dbo.remessas WHERE id=10039" });
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  const approval = service.snapshot().approvals[0];
  await store.save(
    dir,
    project().revision,
    project().connections[0].id,
    { ...config, database: "other" },
    "new-synthetic-password",
    true,
  );
  await service.request({ type: "answer", id: approval.id, accept: true });
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  expect(service.snapshot().items.at(-1)?.text).toMatch(/(?:revisão|autorização).*mudou/);
});
it("fila compartilhada aguarda gate; requests repetidos, de namespace/thread/turn antigos e hostis não executam", async () => {
  await authorize();
  let release!: () => void;
  (service as unknown as { toolQueue: Promise<void> }).toolQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await send({ duplicate: true });
  await vi.waitFor(() => expect(service.snapshot().busy).toBe(true));
  expect(runner).not.toHaveBeenCalled();
  release();
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  for (const overrides of [{ threadId: "other" }, { turnId: "other" }, { namespace: "other" }]) {
    await send({ overrides });
    await done();
  }
  await send({ hostile: true });
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  expect(service.snapshot().items.some((item) => item.text.includes(cyberSafetyRefusal))).toBe(
    true,
  );
});
it.each(["revogar", "parar", "desconectar"])(
  "%s cancela consulta e espera limpeza; resultados antigos não entram e recuperação não repete",
  async (action) => {
    await authorize();
    let started!: () => void, closed!: () => void;
    const handshake = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cleanup = new Promise<void>((resolve) => {
      closed = resolve;
    });
    runner.mockImplementationOnce(async (_config, _password, _args, signal) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await cleanup;
      return { columns: ["late"], rows: [["STALE_SQL_RESULT"]], affectedRows: 0, truncated: false };
    });
    await send();
    await handshake;
    await service.request({
      type: "enqueue",
      threadId: service.snapshot().threadId!,
      id: randomUUID(),
      text: "sql fixture {}",
    });
    let settled = false;
    let work: Promise<unknown>;
    if (action === "revogar")
      work = authorize(false).then(() => {
        settled = true;
      });
    else if (action === "parar")
      work = service.request({ type: "stop" }).then(() => {
        settled = true;
      });
    else {
      rpc!.close();
      work = service.mediaSettled().then(() => {
        settled = true;
      });
    }
    await vi.waitFor(() => expect(runner.mock.calls[0][3].aborted).toBe(true));
    expect(settled).toBe(false);
    closed();
    await work;
    await done();
    expect(JSON.stringify(service.snapshot())).not.toContain("STALE_SQL_RESULT");
    expect(service.snapshot().queuePaused).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    if (action === "desconectar") {
      await service.request({ type: "connect" });
      // Transport loss preserves the unfinished turn, without replaying it.
      if (service.snapshot().busy) await service.request({ type: "stop" });
      await done();
    }
    await authorize();
    await service.request({
      type: "pauseQueue",
      threadId: service.snapshot().threadId!,
      paused: false,
    });
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
    await done();
    expect(runner).toHaveBeenCalledTimes(2);
  },
);
it("parar escrita já aprovada também aguarda o driver encerrar", async () => {
  await authorize();
  let started!: () => void, closed!: () => void;
  const handshake = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cleanup = new Promise<void>((resolve) => {
    closed = resolve;
  });
  runner.mockImplementationOnce(async (_config, _password, _args, signal) => {
    started();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    await cleanup;
    return { columns: [], rows: [], affectedRows: 1, truncated: false };
  });
  await send({ operation: "execute", sql: "DELETE FROM dbo.remessas WHERE id=10039" });
  await vi.waitFor(() => expect(service.snapshot().approvals).toHaveLength(1));
  const answer = service.request({
    type: "answer",
    id: service.snapshot().approvals[0].id,
    accept: true,
  });
  await handshake;
  let settled = false;
  const stop = service.request({ type: "stop" }).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(runner.mock.calls[0][3].aborted).toBe(true));
  expect(settled).toBe(false);
  closed();
  await Promise.all([answer, stop]);
  expect(runner).toHaveBeenCalledTimes(1);
});
it("erros sanitizados e falta de senha orientam formulário, contam falha e recuperam sem repetição", async () => {
  await authorize();
  runner.mockRejectedValueOnce(new Error("raw error " + password));
  await send();
  await done();
  expect(project().metrics.failures).toBe(1);
  expect(JSON.stringify(service.snapshot())).not.toContain(password);
  await send();
  await done();
  expect(runner).toHaveBeenCalledTimes(2);
  await service.request({
    type: "saveDatabase",
    projectPath: dir,
    revision: project().revision,
    connectionId: project().connections[0].id,
    config,
    password: "",
    rememberPassword: false,
  });
  expect(project().authorized).toBe(false);
  await authorize();
  await send();
  await done();
  expect(runner).toHaveBeenCalledTimes(2);
  expect(service.snapshot().items.at(-1)?.text).toContain("Senha indisponível");
});
it("cancelar seleção preserva; projeto/conversa/reinício não herdam consentimento e histórico antigo não ganha tool", async () => {
  await authorize();
  await send();
  await done();
  const id = service.snapshot().threadId!;
  select.mockResolvedValueOnce(null);
  await service.request({ type: "selectProject" });
  expect(project().authorized).toBe(true);
  select.mockResolvedValueOnce(join(dir, "missing"));
  await expect(service.request({ type: "selectProject" })).rejects.toThrow();
  expect(project().authorized).toBe(true);
  await service.request({ type: "resume", threadId: id });
  expect(project().authorized).toBe(true);
  expect(JSON.stringify(calls.filter((call) => call.method === "thread/resume"))).toContain(
    sqlInstructions,
  );
  await service.request({ type: "newChat" });
  expect(project().authorized).toBe(false);
  await service.request({ type: "resume", threadId: id });
  await send();
  await done();
  expect(runner).toHaveBeenCalledTimes(1);
  const neighbor = join(dir, "neighbor");
  await mkdir(neighbor);
  select.mockResolvedValueOnce(neighbor);
  await service.request({ type: "selectProject" });
  expect(project().connections).toEqual([]);
  expect(project().authorized).toBe(false);
  select.mockResolvedValueOnce(dir);
  await service.request({ type: "selectProject" });
  await service.request({ type: "resume", threadId: id });
  const data = await settings.load();
  delete data.threads[id].sqlTool;
  await settings.save(data);
  await service.init();
  await expect(authorize()).rejects.toThrow("histórico não possui stag_sql");
  expect(project().authorized).toBe(false);
});

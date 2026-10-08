import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { DatabaseConnections } from "../../src/main/database-connections";
import {
  SqlTools,
  sqlArguments,
  sqlTool,
  sqlInstructions,
  validateSql,
  databaseContext,
  redactSqlValue,
  type SqlArguments,
  type SqlQueryRunner,
} from "../../src/main/sql-tools";
import { runSqlQuery } from "../../src/main/sql-query";
import { emptySqlServerConfig } from "../../src/shared/database-connections";
import { engineeringToolDescription } from "../../src/main/engineering-policy";
import { cyberToolSafetyDescription } from "../../src/main/cyber-safety";
const config = {
  ...emptySqlServerConfig,
  name: "SQL sintético",
  server: "127.0.0.1",
  database: "stag_fixture",
  user: "fixture",
};
const password = "synthetic-SQL-secret-only";
let dir: string, store: DatabaseConnections, sql: SqlTools;
const run = vi.fn<SqlQueryRunner>();
const args = (patch: Partial<SqlArguments> = {}): SqlArguments => ({
  connectionId: store.snapshot(dir).connections[0].id,
  revision: store.snapshot(dir).revision,
  operation: "query",
  sql: "SELECT id FROM dbo.remessas WHERE id = @id",
  parameters: [{ name: "id", type: "int", value: 10039 }],
  risk: "routine",
  intent: "Conferir remessa sintética",
  ...patch,
});
beforeEach(async () => {
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/sql-tools-"));
  store = new DatabaseConnections(join(dir, "connections.json"), {
    available: () => false,
    encrypt: () => {
      throw new Error();
    },
    decrypt: () => {
      throw new Error();
    },
  });
  await store.init();
  await store.save(dir, store.snapshot(dir).revision, null, config, password, false);
  run.mockReset();
  run.mockResolvedValue({ columns: ["id"], rows: [[10039]], affectedRows: 0, truncated: false });
  sql = new SqlTools(store, run);
});
afterEach(async () => {
  sql.cancel();
  vi.useRealTimers();
  await store.settled();
  await rm(dir, { recursive: true, force: true });
});
it("registra schema real e contratos de engenharia/segurança; catálogo não expõe senha/usuário/cifra", () => {
  expect(sqlTool.description).toContain(sqlInstructions);
  expect(sqlTool.description).toContain(engineeringToolDescription);
  expect(sqlTool.description).toContain(cyberToolSafetyDescription);
  const context = databaseContext(store.snapshot(dir), true);
  expect(context.stag_databases.kind).toBe("untrusted");
  expect(JSON.parse(context.stag_databases.value)).toMatchObject({
    available: true,
    authorized: false,
    connections: [{ database: "stag_fixture", credentialAvailable: true }],
  });
  for (const secret of [password, '"user"', "encryptedPassword"])
    expect(context.stag_databases.value).not.toContain(secret);
  for (const patch of [
    { password },
    { server: "other" },
    { connectionId: "jdbc" },
    { maxRows: 501 },
    { parameters: [{ name: "id", type: "int", value: 1.5 }] },
  ])
    expect(sqlArguments.safeParse({ ...args(), ...patch }).success).toBe(false);
});
it.each([
  "SELECT 1",
  "SELECT 'DELETE; USE other' AS [UPDATE]",
  "SELECT [a]]b], 'x'';EXEC' FROM dbo.t",
  "/* outer /* inner */ done */ SELECT 1; -- comment",
  "SELECT 1 UNION ALL SELECT 2",
  "SELECT (SELECT 1) AS x",
  ";WITH c AS (SELECT 1 AS x) SELECT x FROM c",
  "SELECT t.id, t.value FROM dbo.t t WHERE t.id = @id",
])("aceita consulta limitada e literals/comments: %s", (text) => {
  expect(() =>
    validateSql(args({ sql: text, parameters: text.includes("@id") ? args().parameters : [] })),
  ).not.toThrow();
});
it.each([
  "SELECT 1; DELETE FROM dbo.t",
  "SELECT 1 DELETE FROM dbo.t",
  "SELECT 1 SELECT 2",
  "SELECT * INTO dbo.copy FROM dbo.t",
  "WITH c AS (SELECT 1) UPDATE dbo.t SET x=1",
  "SELECT * FROM other.dbo.t",
  "SELECT * FROM [other].[dbo].[t]",
  "SELECT * FROM other..t",
  "SELECT dbo.custom_function()",
  "SELECT * FROM OPENQUERY(remote, 'inert')",
  "EXEC [xp_inert]",
  "SELECT 1 GO",
  "SELECT 1 PRINT 'inert'",
  "SELECT 1 /* unclosed",
  "SELECT 'unclosed",
  "SELECT (1",
  "SELECT 1) UNION SELECT 2",
  "SELECT * FROM [##other]",
])("recusa SQL fora do contrato sem abrir driver: %s", async (text) => {
  const result = await sql.execute(dir, args({ sql: text, parameters: [] }), "project", true);
  expect(result.success).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
it("valida parâmetros exatos, duplicatas/segredos, preserva nulo/string sem interpolar", async () => {
  for (const parameters of [
    [],
    [{ name: "other", type: "int" as const, value: 10039 }],
    [args().parameters![0], args().parameters![0]],
    [{ name: "password", type: "string" as const, value: "inert" }],
  ])
    expect(() => validateSql(args({ parameters }))).toThrow();
  const input = args({
    sql: "SELECT @value AS v",
    parameters: [{ name: "value", type: "string", value: "inert '; SELECT --" }],
  });
  expect((await sql.execute(dir, input, "read")).success).toBe(true);
  expect(run).toHaveBeenCalledWith(config, password, input, expect.any(AbortSignal));
});
it("escrita routine sempre pede confirmação; aprovada executa e Leitura recusa", async () => {
  const input = args({
    operation: "execute",
    sql: "UPDATE dbo.remessas SET status = @value WHERE id = @id",
    parameters: [...args().parameters!, { name: "value", type: "string", value: "synthetic" }],
  });
  expect(sql.confirmation(dir, input, "project")).toBeTruthy();
  expect(sql.approval(dir, input, "project", "confirmar").detail).toContain("stag_fixture");
  expect(sql.approval(dir, input, "project", "confirmar").detail).toContain(input.sql);
  expect((await sql.execute(dir, input, "project")).success).toBe(false);
  expect((await sql.execute(dir, input, "read", true)).success).toBe(false);
  expect(run).not.toHaveBeenCalled();
  expect((await sql.execute(dir, input, "project", true)).success).toBe(true);
  expect(run).toHaveBeenCalledTimes(1);
});
it("aceita INSERT/DELETE confirmados e recusa lotes, OUTPUT/procedimentos também em execute", () => {
  for (const text of [
    "INSERT INTO dbo.t (id) VALUES (1)",
    "INSERT INTO dbo.t SELECT 1",
    "DELETE FROM dbo.t WHERE id = 1",
  ])
    expect(() =>
      validateSql(args({ operation: "execute", sql: text, parameters: [] })),
    ).not.toThrow();
  for (const text of [
    "UPDATE dbo.t SET x=1 UPDATE dbo.t SET x=2",
    "UPDATE dbo.t SET x=1 SELECT 2",
    "INSERT INTO dbo.t VALUES (1) SET NOCOUNT ON",
    "DELETE FROM dbo.t OUTPUT deleted.id",
    "CREATE TABLE dbo.t (id int)",
    "EXEC harmless",
  ])
    expect(() => validateSql(args({ operation: "execute", sql: text, parameters: [] }))).toThrow();
});
it("revalida projeto/revisão antes de senha/driver e após resposta, sem fallback", async () => {
  expect((await sql.execute(dir + "-neighbor", args(), "project")).success).toBe(false);
  expect((await sql.execute(dir, args({ revision: randomUUID() }), "project")).success).toBe(false);
  expect(run).not.toHaveBeenCalled();
  const before = args();
  run.mockImplementationOnce(async () => {
    await store.save(
      dir,
      store.snapshot(dir).revision,
      before.connectionId,
      { ...config, database: "other" },
      "",
      false,
    );
    return { columns: ["id"], rows: [[1]], affectedRows: 0, truncated: false };
  });
  expect((await sql.execute(dir, before, "project")).success).toBe(false);
  expect((await sql.execute(dir, args(), "project")).contentItems[0]).toMatchObject({
    text: expect.stringContaining("Senha indisponível"),
  });
  expect(run).toHaveBeenCalledTimes(1);
});
it("remove campos sensíveis/eco de senha; erros não expõem SQL, dados ou credenciais e recuperam", async () => {
  run.mockResolvedValueOnce({
    columns: ["id", "password", "text"],
    rows: [[1, "synthetic-other-secret", password]],
    affectedRows: 0,
    truncated: false,
  });
  const first = await sql.execute(dir, args(), "project");
  expect(first.success).toBe(true);
  expect(JSON.stringify(first)).not.toContain(password);
  expect(JSON.stringify(first)).not.toContain("synthetic-other-secret");
  run.mockRejectedValueOnce(new Error("raw SQL error " + password));
  const next = await sql.execute(dir, args(), "project");
  expect(next.success).toBe(false);
  expect(JSON.stringify(next)).not.toContain(password);
  expect((await sql.execute(dir, args(), "project")).success).toBe(true);
});
it("remoção de ecos preserva texto decimal/JSON e não corrompe números com senha curta", () => {
  expect(redactSqlValue("0.1000", password)).toBe("0.1000");
  expect(redactSqlValue('{"value": 0.1000}', password)).toBe('{"value": 0.1000}');
  expect(redactSqlValue(10039, "1")).toBe("[credencial removida]0039");
  expect(() => JSON.parse(JSON.stringify({ rows: [[redactSqlValue(10039, "1")]] }))).not.toThrow();
});
it.each(["cancel", "timeout"])(
  "driver real aguarda handshake e encerra na falha %s",
  async (action) => {
    let accepted!: () => void;
    const handshake = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", accepted);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    if (action === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = runSqlQuery(
      { ...config, endpoint: { kind: "port", port: (server.address() as AddressInfo).port } },
      password,
      args(),
      controller.signal,
    );
    const assertion = expect(result).rejects.toThrow(action === "timeout" ? "prazo" : "cancelada");
    try {
      await handshake;
      if (action === "timeout") await vi.advanceTimersByTimeAsync(31000);
      else controller.abort();
      await assertion;
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

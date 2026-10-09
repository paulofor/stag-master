import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { Connection, Request } from "tedious";

// Fixed loopback and synthetic credentials only. This never accepts a server URL or client config.
const port = Number(process.env.STAG_SQLSERVER_TEST_PORT || 15433);
assert.ok(Number.isInteger(port) && [1433, 15433].includes(port));
const password = "Stag-Synthetic-Only!23";
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const database = `stag_fixture_${suffix}`;
const user = `stag_fixture_${suffix}`;
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/sqlserver-real-"));
await build({
  stdin: {
    contents:
      'export * from "./src/main/sqlserver"; export * from "./src/main/sql-query"; export * from "./src/main/sql-tools"; export * from "./src/main/database-connections"; export * from "./src/main/database-import";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  outfile: join(dir, "driver.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["tedious"],
});
const { testSqlServer, runSqlQuery, SqlTools, DatabaseConnections, inspectDatabaseImport } =
  createRequire(import.meta.url)(join(dir, "driver.cjs"));
const config = {
  name: "Synthetic only",
  driver: "sqlserver",
  authentication: "sql",
  server: "127.0.0.1",
  endpoint: { kind: "port", port },
  database: "master",
  user: "sa",
  encrypt: true,
  trustServerCertificate: true,
  certificateHost: "",
  timeoutSeconds: 15,
};
let admin;
async function connectAdmin() {
  const connection = new Connection({
    server: config.server,
    authentication: { type: "default", options: { userName: "sa", password } },
    options: {
      port,
      database: "master",
      encrypt: true,
      trustServerCertificate: true,
      connectTimeout: 15000,
      maxRetriesOnTransientErrors: 0,
    },
  });
  connection.on("error", () => {});
  await new Promise((resolve, reject) => {
    connection.on("connect", (error) => (error ? reject(error) : resolve()));
    connection.connect();
  });
  return connection;
}
async function query(sql) {
  const rows = [];
  await new Promise((resolve, reject) => {
    const request = new Request(sql, (error) => (error ? reject(error) : resolve()));
    request.on("row", (row) => rows.push(row.map((item) => item.value)));
    admin.execSql(request);
  });
  return rows;
}
async function probe(patch = {}, secret = password) {
  return testSqlServer({ ...config, ...patch }, secret, new AbortController().signal);
}
try {
  admin = await connectAdmin();
  assert.match(String((await query("SELECT SERVERPROPERTY('Edition')"))[0][0]), /Developer/);
  await query(`CREATE DATABASE [${database}]`);
  await query(`CREATE LOGIN [${user}] WITH PASSWORD = '${password}', CHECK_POLICY = OFF`);
  await query(
    `USE [${database}]; CREATE USER [${user}] FOR LOGIN [${user}]; CREATE TABLE dbo.sentinel (id int PRIMARY KEY, value nvarchar(50)); INSERT INTO dbo.sentinel VALUES (1, N'synthetic unchanged');`,
  );
  await query(`GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.sentinel TO [${user}]`);
  console.log("SQL Server real sintético: driver de produção, TLS e autenticação.");
  await probe({ database, user });
  await assert.rejects(probe({ database, user }, "synthetic wrong password"), /Login recusado/);
  await assert.rejects(
    probe({ database: `${database}_missing`, user }),
    /banco informado|Login recusado/,
  );
  await assert.rejects(probe({ database, user, trustServerCertificate: false }), /certificado TLS/);
  await probe({ database, user });
  assert.deepEqual(await query("SELECT id, value FROM dbo.sentinel"), [[1, "synthetic unchanged"]]);
  const connections = new DatabaseConnections(join(dir, "connections.json"), {
    available: () => false,
    encrypt: () => {
      throw new Error();
    },
    decrypt: () => {
      throw new Error();
    },
  });
  await connections.init();
  const toolConfig = { ...config, database, user };
  await writeFile(
    join(dir, "application.properties"),
    `spring.datasource.url=jdbc:sqlserver://127.0.0.1:${port};databaseName=${database};encrypt=true;trustServerCertificate=true\nspring.datasource.username=${user}\nspring.datasource.password=${password}\n`,
  );
  const imported = await inspectDatabaseImport(dir, {
    sourcePath: "application.properties",
    name: toolConfig.name,
  });
  assert.deepEqual(imported.config, toolConfig);
  assert.equal(imported.password, password);
  await connections.save(
    dir,
    connections.snapshot(dir).revision,
    null,
    imported.config,
    imported.password,
    false,
  );
  const sql = new SqlTools(connections, runSqlQuery);
  const args = (patch = {}) => ({
    connectionId: connections.snapshot(dir).connections[0].id,
    revision: connections.snapshot(dir).revision,
    operation: "query",
    sql: "SELECT id, value FROM dbo.sentinel WHERE id=@id",
    parameters: [{ name: "id", type: "int", value: 1 }],
    risk: "routine",
    intent: "Consultar sentinela sintética",
    ...patch,
  });
  const execute = (patch = {}, mode = "project", approved = false) =>
    sql.execute(dir, args(patch), mode, approved);
  const parsed = (result) => {
    assert.equal(result.success, true, JSON.stringify(result));
    return JSON.parse(result.contentItems[0].text);
  };
  assert.deepEqual(parsed(await execute({}, "read")).rows, [[1, "synthetic unchanged"]]);
  assert.equal(
    parsed(
      await execute({
        sql: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME=@name",
        parameters: [{ name: "name", type: "string", value: "sentinel" }],
      }),
    ).rows[0][0],
    "sentinel",
  );
  assert.equal(
    (await execute({ sql: "SELECT * FROM dbo.missing", parameters: [] })).success,
    false,
  );
  assert.deepEqual(parsed(await execute()).rows, [[1, "synthetic unchanged"]]);
  const change = {
    operation: "execute",
    sql: "UPDATE dbo.sentinel SET value=@value WHERE id=@id",
    parameters: [
      args().parameters[0],
      { name: "value", type: "string", value: "synthetic changed" },
    ],
  };
  assert.equal((await execute(change)).success, false);
  assert.equal((await execute(change, "read", true)).success, false);
  assert.deepEqual(await query("SELECT id, value FROM dbo.sentinel"), [[1, "synthetic unchanged"]]);
  assert.equal(parsed(await execute(change, "project", true)).affectedRows, 1);
  assert.deepEqual(parsed(await execute()).rows, [[1, "synthetic changed"]]);
  assert.equal(
    parsed(
      await execute({
        sql: "SELECT @value AS text, @id AS id, @flag AS flag, @num AS num",
        parameters: [
          args().parameters[0],
          { name: "value", type: "string", value: "inert '; SELECT --" },
          { name: "flag", type: "boolean", value: true },
          { name: "num", type: "float", value: 2.5 },
        ],
      }),
    ).rows[0][0],
    "inert '; SELECT --",
  );
  const large = parsed(
    await execute({
      sql: "SELECT TOP (200) t.object_id, REPLICATE(CAST(N'x' AS nvarchar(max)), 100000) AS value FROM sys.all_objects t",
      parameters: [],
      maxRows: 10,
    }),
  );
  assert.equal(large.truncated, true);
  assert.ok(large.rows.length <= 10);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 65536);
  const bounded = parsed(
    await execute({
      sql: "SELECT TOP (20) object_id FROM sys.all_objects",
      parameters: [],
      maxRows: 3,
    }),
  );
  assert.equal(bounded.rows.length, 3);
  assert.equal(bounded.truncated, true);
  const redacted = await execute({
    sql: "SELECT @value AS echoed, N'synthetic other secret' AS password",
    parameters: [{ name: "value", type: "string", value: password }],
  });
  assert.equal(redacted.success, true);
  assert.ok(!JSON.stringify(redacted).includes(password));
  assert.ok(!JSON.stringify(redacted).includes("synthetic other secret"));
  assert.equal(
    (await execute({ sql: "SELECT id FROM master.dbo.sentinel", parameters: [] })).success,
    false,
  );
  assert.equal(
    parsed(
      await execute(
        {
          operation: "execute",
          sql: "INSERT INTO dbo.sentinel (id, value) VALUES (@id, @value)",
          parameters: [
            { name: "id", type: "int", value: 10039 },
            { name: "value", type: "string", value: "synthetic remessa" },
          ],
        },
        "project",
        true,
      ),
    ).affectedRows,
    1,
  );
  assert.equal(
    parsed(
      await execute({
        sql: "SELECT id FROM dbo.sentinel WHERE id=@id",
        parameters: [{ name: "id", type: "int", value: 10039 }],
      }),
    ).rows[0][0],
    10039,
  );
  assert.equal(
    parsed(
      await execute(
        {
          operation: "execute",
          sql: "DELETE FROM dbo.sentinel WHERE id=@id",
          parameters: [{ name: "id", type: "int", value: 10039 }],
        },
        "project",
        true,
      ),
    ).affectedRows,
    1,
  );
  for (const operation of ["query", "execute"]) {
    let blocked;
    try {
      await new Promise((resolve, reject) =>
        admin.beginTransaction((error) => (error ? reject(error) : resolve()), "stag_synthetic"),
      );
      await query("UPDATE dbo.sentinel SET value=N'synthetic lock' WHERE id=1");
      blocked = execute(operation === "query" ? {} : change, "project", operation === "execute");
      // The request keeps its normal connection deadline. Cancel only after SQL Server
      // confirms the production request reached the synthetic lock (TDS handshake).
      const until = Date.now() + toolConfig.timeoutSeconds * 1000;
      let waiting = false;
      while (Date.now() < until) {
        waiting =
          (
            await query(
              "SELECT COUNT(*) FROM sys.dm_exec_requests r JOIN sys.dm_exec_sessions s ON r.session_id=s.session_id WHERE s.program_name=N'STAG Plus SQL tool' AND r.wait_type LIKE N'LCK_%'",
            )
          )[0][0] > 0;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(waiting, true, "Cancelamento deve aguardar request real/handshake SQL");
      sql.cancel();
      const result = await blocked;
      assert.equal(result.success, false);
      assert.match(result.contentItems[0].text, /cancelada/);
    } finally {
      sql.cancel();
      if (blocked) await blocked;
      await new Promise((resolve, reject) =>
        admin.rollbackTransaction((error) => (error ? reject(error) : resolve()), "stag_synthetic"),
      );
    }
    assert.deepEqual(parsed(await execute()).rows, [[1, "synthetic changed"]]);
  }
  const sessions = await query(
    "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name IN (N'STAG Plus connection test', N'STAG Plus SQL tool')",
  );
  assert.equal(sessions[0][0], 0, "Probe must close its session before returning");
  console.log(
    "SQL Server real sintético: teste fixo, ferramenta parametrizada, escrita confirmada, Leitura, catálogo, limites, remoção de segredos, recuperação e sessões encerradas aprovados.",
  );
} finally {
  if (admin) {
    try {
      await query(
        `USE master; IF DB_ID(N'${database}') IS NOT NULL DROP DATABASE [${database}]; IF SUSER_ID(N'${user}') IS NOT NULL DROP LOGIN [${user}];`,
      );
    } finally {
      await new Promise((resolve) => {
        admin.on("end", resolve);
        admin.close();
      });
    }
  }
  await rm(dir, { recursive: true, force: true });
}

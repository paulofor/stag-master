import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
  entryPoints: ["src/main/sqlserver.ts"],
  outfile: join(dir, "driver.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["tedious"],
});
const { testSqlServer } = createRequire(import.meta.url)(join(dir, "driver.cjs"));
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
  const sessions = await query(
    "SELECT COUNT(*) FROM sys.dm_exec_sessions WHERE program_name = N'STAG connection test'",
  );
  assert.equal(sessions[0][0], 0, "Probe must close its session before returning");
  console.log(
    "SQL Server real sintético: sucesso, login inválido, banco inacessível, TLS recusado, recuperação, dados intactos e sessões encerradas aprovados.",
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

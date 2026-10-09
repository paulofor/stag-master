import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, symlink, link } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  databaseImportArguments,
  databaseImportDetail,
  readDatabaseImport,
} from "../../src/main/database-import";

let dir: string;
const password = "synthetic-import-only !";
const args = { file: "application.properties", name: "Desenvolvimento" };
const properties = `spring.datasource.url=jdbc:sqlserver://localhost:1433;databaseName=stag_synthetic;encrypt=true\nspring.datasource.username=synthetic\nspring.datasource.password=${password}\n`;
beforeEach(async () => {
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/import-test-"));
  await writeFile(join(dir, args.file), properties);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it("importa properties sem transmitir senha na aprovação; identidade muda quando a fonte muda", async () => {
  const imported = await readDatabaseImport(dir, args);
  expect(imported.config).toMatchObject({
    name: args.name,
    server: "localhost",
    database: "stag_synthetic",
    user: "synthetic",
    encrypt: true,
    trustServerCertificate: false,
  });
  expect(imported.password).toBe(password);
  const detail = databaseImportDetail(args, imported);
  expect(detail).not.toContain(password);
  expect(detail).toContain("somente nesta sessão");
  await writeFile(join(dir, args.file), properties + "# revised\n");
  expect((await readDatabaseImport(dir, args)).fingerprint).not.toBe(imported.fingerprint);
});
it("resolve placeholders somente do envFile indicado e nunca do ambiente do processo", async () => {
  await writeFile(join(dir, args.file), properties.replace(password, "${STAG_SYNTHETIC_PASSWORD}"));
  const previous = process.env.STAG_SYNTHETIC_PASSWORD;
  process.env.STAG_SYNTHETIC_PASSWORD = password;
  try {
    await expect(readDatabaseImport(dir, args)).rejects.toThrow("Falta uma variável local");
    await writeFile(join(dir, ".env.local"), `STAG_SYNTHETIC_PASSWORD='${password}'\n`);
    expect((await readDatabaseImport(dir, { ...args, envFile: ".env.local" })).password).toBe(
      password,
    );
  } finally {
    if (previous === undefined) delete process.env.STAG_SYNTHETIC_PASSWORD;
    else process.env.STAG_SYNTHETIC_PASSWORD = previous;
  }
});
it("importa .env, instância e TLS explícitos; senha com espaços permanece no main", async () => {
  await writeFile(
    join(dir, ".env"),
    `DB_HOST=localhost\nDB_INSTANCE=SQLEXPRESS\nDB_DATABASE=stag_synthetic\nDB_USER=synthetic\nDB_PASSWORD=' ${password} '\nDB_ENCRYPT=false\nDB_TRUST_SERVER_CERTIFICATE=true\n`,
  );
  const imported = await readDatabaseImport(dir, { ...args, file: ".env" });
  expect(imported.config.endpoint).toEqual({ kind: "instance", instance: "SQLEXPRESS" });
  expect(imported.password).toBe(` ${password} `);
  expect(databaseImportDetail(args, imported)).toContain("DESABILITADO");
  expect(databaseImportDetail(args, imported)).toContain("SEM VALIDAÇÃO");
});
it("JDBC entre chaves, unicode properties, continuação e prefix selecionado", async () => {
  await writeFile(
    join(dir, args.file),
    "custom.datasource.url=jdbc:sqlserver://localhost;databaseName=stag_synthetic;\\\n encrypt=true;user=synthetic;password={semi;colon}}value}\ncustom.datasource.username=synthet\\u0069c\n",
  );
  const imported = await readDatabaseImport(dir, { ...args, prefix: "custom.datasource" });
  expect(imported.password).toBe("semi;colon}value");
  expect(imported.config.user).toBe("synthetic");
});
it.each([
  "spring.datasource.url=jdbc:mysql://localhost/fixture",
  properties + "spring.datasource.password=other\n",
  properties + "spring.datasource.user=different\n",
  properties.replace("encrypt=true", "encrypt=yes"),
  properties.replace("databaseName=stag_synthetic", "databaseName=stag_synthetic;database=other"),
  properties.replace("encrypt=true", "integratedSecurity=true"),
  properties.replace("encrypt=true", "trustStorePassword=inert"),
  properties.replace("localhost:1433", "localhost:1433;instanceName=SQLEXPRESS"),
  properties.replace(password, "${MISSING}"),
  properties.replace(password, "$(inert)"),
  properties.replace("databaseName=stag_synthetic", "databaseName="),
])("recusa configuração inválida sem eco de credenciais %#", async (text) => {
  await writeFile(join(dir, args.file), text);
  await expect(readDatabaseImport(dir, args)).rejects.toThrow();
  try {
    await readDatabaseImport(dir, args);
  } catch (error) {
    expect(String(error)).not.toContain(password);
  }
});
it.each([
  "../application.properties",
  "/application.properties",
  "C:\\application.properties",
  ".git/application.properties",
  ".codex/auth.json",
  "application.properties:stream",
  "missing.properties",
])("isola caminho %s", async (file) => {
  await expect(readDatabaseImport(dir, { ...args, file })).rejects.toThrow();
});
it("recusa links/junctions e hard links sem afetar próxima leitura válida", async () => {
  await mkdir(join(dir, "nested"));
  await symlink(join(dir, "nested"), join(dir, "alias"), "junction");
  await writeFile(join(dir, "nested", args.file), properties);
  await expect(readDatabaseImport(join(dir, "alias"), args)).rejects.toThrow("raiz");
  await expect(
    readDatabaseImport(dir, { ...args, file: "alias/application.properties" }),
  ).rejects.toThrow("links");
  await link(join(dir, args.file), join(dir, "hard.properties"));
  await expect(readDatabaseImport(dir, { ...args, file: "hard.properties" })).rejects.toThrow(
    "links",
  );
  await rm(join(dir, "hard.properties"));
  expect((await readDatabaseImport(dir, args)).password).toBe(password);
});
it("limita bytes e rejeita encoding inválido, conteúdo binário e argumentos secretos", async () => {
  for (const value of [
    Buffer.alloc(256 * 1024 + 1, 65),
    Buffer.from([0xff, 0xfe]),
    Buffer.from("binary\0"),
  ]) {
    await writeFile(join(dir, args.file), value);
    await expect(readDatabaseImport(dir, args)).rejects.toThrow();
  }
  expect(databaseImportArguments.safeParse({ ...args, password }).success).toBe(false);
  expect(databaseImportArguments.safeParse({ ...args, command: "inert" }).success).toBe(false);
});

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, link, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { databaseImportArguments, inspectDatabaseImport } from "../../src/main/database-import";

let dir: string;
const secret = "synthetic-Import-Only!";
const properties = `spring.datasource.url=jdbc:sqlserver://127.0.0.1:1433;databaseName=stag_fixture;encrypt=true\nspring.datasource.username=fixture\nspring.datasource.password=${secret}\n`;
beforeEach(async () => {
  await mkdir(".local", { recursive: true });
  dir = await realpath(await mkdtemp(resolve(".local/import-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it.each(["application.properties", "nested/application.properties"])(
  "importa Spring %s com senha privada e TLS",
  async (sourcePath) => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, sourcePath), properties);
    const result = await inspectDatabaseImport(dir, { sourcePath });
    expect(result.config).toMatchObject({
      name: "stag_fixture",
      database: "stag_fixture",
      user: "fixture",
      encrypt: true,
      trustServerCertificate: false,
      endpoint: { kind: "port", port: 1433 },
    });
    expect(result.password).toBe(secret);
    await writeFile(join(dir, sourcePath), properties.replace("1433", "1434"));
    expect((await inspectDatabaseImport(dir, { sourcePath })).fingerprint).not.toBe(
      result.fingerprint,
    );
  },
);
it.each(["yaml", "yml", "json"])(
  "importa %s com variáveis somente do .env selecionado",
  async (format) => {
    const sourcePath = `application.${format}`;
    const value = {
      spring: {
        datasource: { url: "${DB_URL}", username: "${DB_USER}", password: "${DB_PASSWORD}" },
      },
    };
    await writeFile(
      join(dir, sourcePath),
      format === "json"
        ? JSON.stringify(value)
        : 'spring:\n  datasource:\n    url: "${DB_URL}"\n    username: "${DB_USER}"\n    password: "${DB_PASSWORD}"\n',
    );
    await writeFile(
      join(dir, ".env.test"),
      `DB_URL=jdbc:sqlserver://localhost;databaseName=stag_fixture\nDB_USER=fixture\nDB_PASSWORD='${secret}'\n`,
    );
    await expect(inspectDatabaseImport(dir, { sourcePath })).rejects.toThrow("incompleta");
    expect(
      (await inspectDatabaseImport(dir, { sourcePath, environmentPath: ".env.test" })).password,
    ).toBe(secret);
  },
);
it("importa .env e preserva instância, certificado, senha entre chaves e espaços", async () => {
  await writeFile(
    join(dir, ".env"),
    `DB_HOST=localhost\nDB_INSTANCE=SQLEXPRESS\nDB_DATABASE=stag_fixture\nDB_USER=fixture\nDB_PASSWORD=' ${secret} '\nDB_TRUST_SERVER_CERTIFICATE=true`,
  );
  const value = await inspectDatabaseImport(dir, { sourcePath: ".env", name: "Teste" });
  expect(value.config).toMatchObject({
    name: "Teste",
    endpoint: { kind: "instance", instance: "SQLEXPRESS" },
    trustServerCertificate: true,
  });
  expect(value.password).toBe(` ${secret} `);
  await writeFile(
    join(dir, "application.properties"),
    `spring.datasource.url=jdbc:sqlserver://localhost;databaseName=stag_fixture;user=fixture;password={ a;}}b }\n`,
  );
  expect(
    (await inspectDatabaseImport(dir, { sourcePath: "application.properties" })).password,
  ).toBe(" a;}b ");
});
it.each([
  "../outside.properties",
  "/outside.properties",
  "C:\\outside.properties",
  "\\\\host\\file.properties",
  "a/../../file.properties",
  ".codex/auth.json",
  "auth.json",
  ".ssh/.env",
  ".aws/.env",
  ".stag/secrets.json",
  "a/.git/config.properties",
  "file.properties:stream",
  "folder./file.properties",
  "folder /file.properties",
])("recusa caminho %s no schema sem ler arquivos", (sourcePath) =>
  expect(databaseImportArguments.safeParse({ sourcePath }).success).toBe(false),
);
it("não aceita senhas ou configuração bruta nos argumentos", () => {
  expect(databaseImportArguments.safeParse({ sourcePath: ".env", password: secret }).success).toBe(
    false,
  );
});
it.each(['synthetic"quoted', "synthetic\\backslash"])(
  "recusa eco de senha escapável em campos públicos (%#)",
  async (password) => {
    await writeFile(
      join(dir, "application.json"),
      JSON.stringify({
        spring: {
          datasource: {
            url: "jdbc:sqlserver://localhost;databaseName=stag_fixture",
            username: password,
            password,
          },
        },
      }),
    );
    await expect(inspectDatabaseImport(dir, { sourcePath: "application.json" })).rejects.toThrow(
      "não suportada",
    );
    await writeFile(
      join(dir, "application.json"),
      JSON.stringify({
        spring: {
          datasource: {
            url: "jdbc:sqlserver://localhost;databaseName=stag_fixture",
            username: "fixture",
            password,
          },
        },
      }),
    );
    expect((await inspectDatabaseImport(dir, { sourcePath: "application.json" })).password).toBe(
      password,
    );
  },
);
it.each([
  properties.replace("databaseName=stag_fixture;", ""),
  properties.replace("jdbc:sqlserver", "jdbc:postgresql"),
  properties.replace("encrypt=true", "encrypt=invalid"),
  properties.replace("encrypt=true", "integratedSecurity=true"),
  properties + "spring.datasource.driver-class-name=org.postgresql.Driver\n",
  properties + "spring.datasource.hikari.jdbc-url=jdbc:sqlserver://other;databaseName=another\n",
  properties + "secondary.datasource.url=jdbc:sqlserver://other;databaseName=another\n",
  properties.replace("127.0.0.1:1433", "localhost\\\\SQLEXPRESS:1433"),
  properties + "spring.datasource.password=conflict",
  properties.replace(secret, "${NOT_DEFINED}"),
  properties.replace("stag_fixture", secret),
  properties.replace(secret, "#{inertExpression}"),
  "spring.datasource.url=${a}\na=${a}\n",
])("recusa configuração inválida sem ecoar o conteúdo (%#)", async (content) => {
  await writeFile(join(dir, "application.properties"), content);
  const error = await inspectDatabaseImport(dir, { sourcePath: "application.properties" }).catch(
    (e) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain(secret);
});
it("recusa YAML com aliases, duplicatas, tags ou vários documentos sem logs com segredos", async () => {
  for (const content of [
    `a: &a [${secret}]\nb: *a`,
    `a: ${secret}\na: duplicate`,
    `a: !unknown ${secret}`,
    `a: 1\n---\na: ${secret}`,
    `a: [${secret}`,
  ]) {
    await writeFile(join(dir, "application.yaml"), content);
    await expect(inspectDatabaseImport(dir, { sourcePath: "application.yaml" })).rejects.toThrow(
      "não suportada",
    );
  }
});
it("recusa links/hardlinks, diretórios, arquivos grandes e UTF-8 inválido e recupera", async () => {
  await writeFile(join(dir, "real.properties"), properties);
  await symlink(join(dir, "real.properties"), join(dir, "link.properties"));
  await link(join(dir, "real.properties"), join(dir, "hard.properties"));
  await mkdir(join(dir, "directory.properties"));
  await writeFile(join(dir, "large.properties"), Buffer.alloc(256 * 1024 + 1));
  await writeFile(join(dir, "invalid.properties"), Buffer.from([0xff]));
  for (const sourcePath of [
    "link.properties",
    "hard.properties",
    "directory.properties",
    "large.properties",
    "invalid.properties",
    "absent.properties",
  ])
    await expect(inspectDatabaseImport(dir, { sourcePath })).rejects.toThrow(
      "Não foi possível ler",
    );
  await rm(join(dir, "hard.properties"));
  expect((await inspectDatabaseImport(dir, { sourcePath: "real.properties" })).password).toBe(
    secret,
  );
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import {
  DatabaseConnections,
  type DatabaseSecretStorage,
} from "../../src/main/database-connections";
import { emptySqlServerConfig, sqlServerConfigSchema } from "../../src/shared/database-connections";
import { actionSchema } from "../../src/shared/validation";
import {
  sqlServerOptions,
  sqlServerError,
  databaseTestError,
  testSqlServer,
} from "../../src/main/sqlserver";
import { createServer } from "node:net";

export const config = {
  ...emptySqlServerConfig,
  name: "Homologação",
  server: "localhost",
  database: "stag_test",
  user: "fixture-user",
};
let dir: string;
let store: DatabaseConnections;
let secrets: DatabaseSecretStorage;
const password = "synthetic password with spaces !";
beforeEach(async () => {
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/database-test-"));
  const key = randomBytes(32);
  secrets = {
    available: vi.fn(() => true),
    encrypt(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encoded = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encoded]);
    },
    decrypt(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    },
  };
  store = new DatabaseConnections(join(dir, "connections.json"), secrets);
  await store.init();
});
afterEach(async () => {
  await store.settled();
  await rm(dir, { recursive: true, force: true });
});

describe("configuração e credenciais SQL Server", () => {
  it("recupera para outra raiz com vínculo protegido novo, sem alterar origem ou duplicar", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, true);
    const other = join(dir, "recreated");
    const before = store.snapshot(dir).connections;
    const state = store.snapshot(other),
      source = state.recoverySources![0];
    expect(state.connections).toEqual([]);
    expect(JSON.stringify(state)).not.toContain(password);
    await store.recover(other, state.revision, source.id, source.revision);
    let recovered = store.snapshot(other);
    expect(recovered.connections).toHaveLength(1);
    expect(recovered.connections[0].id).not.toBe(before[0].id);
    expect(store.password(other, recovered.revision, recovered.connections[0].id, config, "")).toBe(
      password,
    );
    expect(store.snapshot(dir).connections).toEqual(before);
    await store.recover(other, recovered.revision, source.id, source.revision);
    recovered = store.snapshot(other);
    expect(recovered.connections).toHaveLength(1);
    const restarted = new DatabaseConnections(join(dir, "connections.json"), secrets);
    await restarted.init();
    const stateAfter = restarted.snapshot(other);
    expect(
      restarted.password(other, stateAfter.revision, stateAfter.connections[0].id, config, ""),
    ).toBe(password);
  });
  it("recuperação obsoleta, conflitante ou falha preserva ambos catálogos", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, false);
    const other = join(dir, "other");
    const initial = store.snapshot(other),
      source = initial.recoverySources![0];
    await store.save(other, initial.revision, null, { ...config, database: "another" }, "", false);
    await expect(
      store.recover(other, initial.revision, source.id, source.revision),
    ).rejects.toThrow("mudaram");
    await expect(
      store.recover(other, store.snapshot(other).revision, source.id, source.revision),
    ).rejects.toThrow("outro destino");
    const empty = join(dir, "third");
    await mkdir(join(dir, "connections.json.tmp"));
    await expect(
      store.recover(empty, store.snapshot(empty).revision, source.id, source.revision),
    ).rejects.toThrow("preservados");
    expect(store.snapshot(empty).connections).toEqual([]);
    await rm(join(dir, "connections.json.tmp"), { recursive: true });
    await store.recover(empty, store.snapshot(empty).revision, source.id, source.revision);
    const recovered = store.snapshot(empty);
    expect(store.password(empty, recovered.revision, recovered.connections[0].id, config, "")).toBe(
      password,
    );
    expect(recovered.connections[0].passwordSaved).toBe(false);
  });
  it.each([
    "https://sql.invalid",
    "user:synthetic-secret@host",
    "host:1433",
    "host\\SQLEXPRESS",
    "host\ntext",
    "",
    "-bad",
    "bad..name",
  ])("recusa servidor inválido %s sem credenciais em erros", (server) => {
    const result = sqlServerConfigSchema.safeParse({ ...config, server });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).not.toContain("synthetic-secret");
  });
  it("aceita host/IP/instância separados e recusa injeção, campos extras e limites", () => {
    expect(sqlServerConfigSchema.parse({ ...config, server: " SQL.EXAMPLE.INVALID " }).server).toBe(
      "sql.example.invalid",
    );
    expect(sqlServerConfigSchema.safeParse({ ...config, server: "::1" }).success).toBe(true);
    expect(
      sqlServerConfigSchema.safeParse({
        ...config,
        endpoint: { kind: "instance", instance: "SQLEXPRESS" },
      }).success,
    ).toBe(true);
    for (const patch of [
      { endpoint: { kind: "port", port: 0 } },
      { endpoint: { kind: "port", port: 65536 } },
      { endpoint: { kind: "port", port: 1433, instance: "extra" } },
      { endpoint: { kind: "instance", instance: "name;inert" } },
      { timeoutSeconds: 0 },
      { timeoutSeconds: 61 },
      { database: "" },
      { user: "" },
      { name: "n".repeat(81) },
      { driver: "other" },
      { authentication: "ntlm" },
      { sql: "inert" },
    ])
      expect(sqlServerConfigSchema.safeParse({ ...config, ...patch }).success).toBe(false);
    const action = {
      type: "testDatabase",
      projectPath: dir,
      revision: randomUUID(),
      connectionId: null,
      testId: randomUUID(),
      config,
      password,
    };
    expect(actionSchema.safeParse(action).success).toBe(true);
    for (const patch of [
      { sql: "inert" },
      { command: "inert" },
      { password: "x".repeat(1025) },
      { password: "inert\0" },
      { connectionId: "external" },
    ])
      expect(actionSchema.safeParse({ ...action, ...patch }).success).toBe(false);
  });
  it("salva senha protegida, restaura e nunca devolve senha ou cifra no snapshot", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, true);
    const raw = await readFile(join(dir, "connections.json"), "utf8");
    expect(raw).not.toContain(password);
    expect(raw).toContain("encryptedPassword");
    const next = new DatabaseConnections(join(dir, "connections.json"), secrets);
    await next.init();
    const state = next.snapshot(dir);
    expect(state.connections[0].passwordSaved).toBe(true);
    expect(JSON.stringify(state)).not.toContain(password);
    expect(JSON.stringify(state)).not.toContain("encryptedPassword");
    expect(next.password(dir, state.revision, state.connections[0].id, config, "")).toBe(password);
  });
  it("preserva espaços na senha, permite substituir/remover e salvar configuração sem senha", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, ` ${password} `, true);
    let state = store.snapshot(dir);
    const id = state.connections[0].id;
    expect(store.password(dir, state.revision, id, config, "")).toBe(` ${password} `);
    await store.save(dir, state.revision, id, config, "new synthetic", true);
    state = store.snapshot(dir);
    expect(store.password(dir, state.revision, id, config, "")).toBe("new synthetic");
    await store.save(dir, state.revision, id, config, password, false);
    state = store.snapshot(dir);
    expect(state.connections[0].passwordSaved).toBe(false);
    expect(await readFile(join(dir, "connections.json"), "utf8")).not.toContain(
      "encryptedPassword",
    );
    expect(store.password(dir, state.revision, id, config, "")).toBe(password);
    expect(state.connections[0].passwordAvailable).toBe(true);
    const restarted = new DatabaseConnections(join(dir, "connections.json"), secrets);
    await restarted.init();
    expect(restarted.snapshot(dir).connections[0].passwordAvailable).toBe(false);
    expect(() => restarted.password(dir, restarted.snapshot(dir).revision, id, config, "")).toThrow(
      "Informe a senha",
    );
  });
  it("isola projetos, recusa ids/revisões antigos e impede reutilização de senha após mudar destino", async () => {
    const old = store.snapshot(dir).revision;
    await store.save(dir, old, null, config, password, true);
    const state = store.snapshot(dir);
    const id = state.connections[0].id;
    expect(store.snapshot(dir + "-neighbor").connections).toEqual([]);
    expect(() =>
      store.password(dir + "-neighbor", store.snapshot(dir + "-neighbor").revision, id, config, ""),
    ).toThrow("não encontrada");
    await expect(store.remove(dir, old, id)).rejects.toThrow("mudaram");
    for (const changed of [
      { ...config, server: "other.invalid" },
      { ...config, database: "other" },
      { ...config, user: "other" },
      { ...config, encrypt: false },
    ])
      expect(() => store.password(dir, state.revision, id, changed, "")).toThrow(
        "Digite a senha novamente",
      );
    expect(
      store.password(
        dir,
        state.revision,
        id,
        { ...config, name: "new name", timeoutSeconds: 30 },
        "",
      ),
    ).toBe(password);
    await store.remove(dir, state.revision, id);
    expect(store.snapshot(dir).connections).toEqual([]);
    expect(await readFile(join(dir, "connections.json"), "utf8")).not.toContain(
      "encryptedPassword",
    );
  });
  it("cifra copiada para outro projeto ou metadados alterados falham fechados", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, true);
    const raw = JSON.parse(await readFile(join(dir, "connections.json"), "utf8"));
    raw.projects.neighbor = structuredClone(raw.projects[dir]);
    raw.projects[dir][0].config.server = "changed.invalid";
    await writeFile(join(dir, "connections.json"), JSON.stringify(raw));
    const restored = new DatabaseConnections(join(dir, "connections.json"), secrets);
    await restored.init();
    for (const project of [dir, "neighbor"]) {
      const state = restored.snapshot(project),
        entry = state.connections[0];
      expect(() => restored.password(project, state.revision, entry.id, entry.config, "")).toThrow(
        "desbloquear",
      );
    }
  });
  it("recusa armazenamento indisponível e falha de proteção sem perder configuração; recuperação por substituição", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, false);
    const state = store.snapshot(dir),
      id = state.connections[0].id;
    vi.mocked(secrets.available).mockReturnValue(false);
    await expect(store.save(dir, state.revision, id, config, password, true)).rejects.toThrow(
      "indisponível",
    );
    expect(store.snapshot(dir).revision).toBe(state.revision);
    vi.mocked(secrets.available).mockReturnValue(true);
    const original = secrets.encrypt;
    secrets.encrypt = () => {
      throw new Error(password);
    };
    await expect(store.save(dir, state.revision, id, config, password, true)).rejects.toThrow(
      "proteger",
    );
    secrets.encrypt = original;
    await store.save(dir, state.revision, id, config, password, true);
    const next = store.snapshot(dir);
    secrets.decrypt = () => {
      throw new Error(password);
    };
    expect(() => store.password(dir, next.revision, id, config, "")).toThrow("desbloquear");
    await store.save(dir, next.revision, id, config, "replacement synthetic", true);
  });
  it("falha de escrita mantém arquivo/lista/revisão e a mesma fila recupera", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, password, false);
    const before = await readFile(join(dir, "connections.json"), "utf8");
    const state = store.snapshot(dir);
    await mkdir(join(dir, "connections.json.tmp"));
    await expect(store.remove(dir, state.revision, state.connections[0].id)).rejects.toThrow(
      "preservados",
    );
    expect(await readFile(join(dir, "connections.json"), "utf8")).toBe(before);
    expect(store.snapshot(dir)).toEqual(state);
    await rm(join(dir, "connections.json.tmp"), { recursive: true });
    await store.remove(dir, state.revision, state.connections[0].id);
    expect(store.snapshot(dir).connections).toEqual([]);
  });
  it("limita cadastros e nomes duplicados sem impedir recuperação", async () => {
    await store.save(dir, store.snapshot(dir).revision, null, config, "", false);
    await expect(
      store.save(
        dir,
        store.snapshot(dir).revision,
        null,
        { ...config, name: "HOMOLOGAÇÃO" },
        "",
        false,
      ),
    ).rejects.toThrow("esse nome");
    for (let i = 1; i < 20; i++)
      await store.save(
        dir,
        store.snapshot(dir).revision,
        null,
        { ...config, name: `Connection ${i}` },
        "",
        false,
      );
    await expect(
      store.save(
        dir,
        store.snapshot(dir).revision,
        null,
        { ...config, name: "overflow" },
        "",
        false,
      ),
    ).rejects.toThrow("20 conexões");
  });
  it("configuração corrompida é explícita e não é sobrescrita silenciosamente", async () => {
    await writeFile(join(dir, "connections.json"), "corrupt synthetic");
    await expect(
      new DatabaseConnections(join(dir, "connections.json"), secrets).init(),
    ).rejects.toThrow("carregar");
    expect(await readFile(join(dir, "connections.json"), "utf8")).toBe("corrupt synthetic");
  });
});

describe("driver SQL Server", () => {
  it("timeout usa prazo normal e relógio controlado somente após handshake TCP, fechando a sessão", async () => {
    let accepted!: () => void;
    const handshake = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", accepted);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const result = testSqlServer(
      {
        ...config,
        server: "127.0.0.1",
        endpoint: { kind: "port", port: (server.address() as import("node:net").AddressInfo).port },
      },
      password,
      new AbortController().signal,
    );
    const assertion = expect(result).rejects.toThrow("prazo");
    try {
      await handshake;
      await vi.advanceTimersByTimeAsync(16000);
      await assertion;
    } finally {
      vi.useRealTimers();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("usa destino exato, TLS padrão e nenhuma credencial do ambiente ou fallback de banco", () => {
    const options = sqlServerOptions(config, password);
    expect(options.authentication).toEqual({
      type: "default",
      options: { userName: config.user, password },
    });
    expect(options.options).toMatchObject({
      port: 1433,
      database: "stag_test",
      encrypt: true,
      trustServerCertificate: false,
      fallbackToDefaultDb: false,
      maxRetriesOnTransientErrors: 0,
    });
    const instance = sqlServerOptions(
      {
        ...config,
        endpoint: { kind: "instance", instance: "SQLEXPRESS" },
        certificateHost: "sql.example.invalid",
      },
      password,
    );
    expect(instance.options).not.toHaveProperty("port");
    expect(instance.options).toMatchObject({
      instanceName: "SQLEXPRESS",
      serverName: "sql.example.invalid",
    });
  });
  it("classifica erros de login/TLS/timeout/banco sem copiar payloads, incluindo causas", () => {
    expect(sqlServerError({ code: "ELOGIN", message: password })).toContain("Login recusado");
    expect(sqlServerError({ number: 4060, message: password })).toContain("banco informado");
    expect(
      sqlServerError({
        code: "ESOCKET",
        cause: { errors: [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }] },
      }),
    ).toContain("certificado TLS");
    expect(sqlServerError({ code: "ETIMEOUT" })).toContain("prazo");
    expect(databaseTestError(new Error(password))).not.toContain(password);
  });
  it("cancela sessão real após handshake TCP e aguarda fechamento antes de recuperar", async () => {
    let accepted!: () => void;
    const handshake = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("data", accepted);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    const result = testSqlServer(
      {
        ...config,
        server: "127.0.0.1",
        endpoint: { kind: "port", port: (server.address() as import("node:net").AddressInfo).port },
      },
      password,
      controller.signal,
    );
    try {
      await handshake;
      controller.abort();
      await expect(result).rejects.toThrow("cancelado");
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(testSqlServer(config, password, controller.signal)).rejects.toThrow("cancelado");
  });
});

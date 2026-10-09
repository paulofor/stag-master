import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { dirname, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  databasePasswordSchema,
  maxDatabaseConnections,
  sqlServerConfigSchema,
  type ProjectDatabases,
  type SqlServerConfig,
} from "../shared/database-connections";

export interface DatabaseSecretStorage {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
const recordSchema = z
  .object({
    id: z.uuid(),
    config: sqlServerConfigSchema,
    encryptedPassword: z
      .string()
      .max(16384)
      .regex(/^[a-z\d+/]+=*$/i)
      .optional(),
  })
  .strict();
const storageSchema = z
  .object({
    version: z.literal(1),
    projects: z.record(z.string(), z.array(recordSchema).max(maxDatabaseConnections)),
  })
  .strict();
type Stored = z.infer<typeof storageSchema>;

// Bind credentials to the exact project, profile and destination. Names/timeouts are presentation.
function binding(config: SqlServerConfig): string {
  const { name: _name, timeoutSeconds: _timeout, ...destination } = config;
  return JSON.stringify(destination);
}

export class DatabaseConnections {
  private data: Stored = { version: 1, projects: {} };
  private revisions = new Map<string, string>();
  private projectIds = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();
  private sessionPasswords = new Map<string, { binding: string; password: string }>();
  constructor(
    private file: string,
    private secrets: DatabaseSecretStorage,
    private platform = process.platform,
  ) {}

  private projectKey(path: string): string {
    if (this.platform !== "win32") return path;
    const normalize = (value: string) => win32.normalize(value).replace(/\\+$/, "").toLowerCase();
    const matches = Object.keys(this.data.projects).filter((key) => {
      if (key === path) return true;
      if (normalize(key) !== normalize(path)) return false;
      try {
        const a = statSync(key, { bigint: true }),
          b = statSync(path, { bigint: true });
        // NTFS can enable case sensitivity per directory. Equal text ignoring case
        // is insufficient authority to reuse a different project's credential.
        return a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino;
      } catch {
        return false;
      }
    });
    if (matches.length > 1)
      throw new Error(
        "Há cadastros conflitantes para esta pasta. Preserve os dados antes de continuar.",
      );
    return matches[0] || path;
  }
  private revision(path: string): string {
    if (!this.revisions.has(path)) this.revisions.set(path, randomUUID());
    return this.revisions.get(path)!;
  }

  async init(): Promise<void> {
    this.sessionPasswords.clear();
    try {
      if ((await stat(this.file)).size > 2 * 1024 * 1024) throw new Error();
      this.data = storageSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        "Não foi possível carregar as conexões salvas. Preserve o arquivo e tente novamente.",
      );
    }
  }

  snapshot(path: string): ProjectDatabases {
    path = this.projectKey(path);
    return {
      revision: this.revision(path),
      recoverySources: Object.entries(this.data.projects)
        .filter(([key, list]) => key !== path && list.length > 0)
        .map(([key, list]) => {
          if (!this.projectIds.has(key)) this.projectIds.set(key, randomUUID());
          return {
            id: this.projectIds.get(key)!,
            projectPath: key,
            count: list.length,
            revision: this.revision(key),
          };
        }),
      connections: (this.data.projects[path] || []).map(({ id, config, encryptedPassword }) => ({
        id,
        config: structuredClone(config),
        passwordSaved: !!encryptedPassword,
        passwordAvailable:
          this.sessionPasswords.has(this.key(path, id)) ||
          (!!encryptedPassword && this.secrets.available()),
      })),
      canRememberPassword: this.secrets.available(),
      authorized: false,
      metrics: { requests: 0, failures: 0, elapsedMs: 0, lastRows: null },
      test: null,
    };
  }

  check(path: string, revision: string): void {
    if (this.snapshot(path).revision !== revision)
      throw new Error("As conexões mudaram. Reabra Conexões antes de continuar.");
  }

  private record(path: string, id: string) {
    path = this.projectKey(path);
    const record = this.data.projects[path]?.find((entry) => entry.id === id);
    if (!record) throw new Error("Conexão não encontrada neste projeto. Reabra Conexões.");
    return record;
  }
  private key(path: string, id: string): string {
    return JSON.stringify([path, id]);
  }
  get(path: string, revision: string, id: string): { config: SqlServerConfig } {
    this.check(path, revision);
    return { config: structuredClone(this.record(path, id).config) };
  }

  password(
    path: string,
    revision: string,
    id: string | null,
    config: SqlServerConfig,
    supplied: string,
  ): string {
    path = this.projectKey(path);
    this.check(path, revision);
    const previous = id ? this.record(path, id) : null;
    const password = databasePasswordSchema.parse(supplied);
    if (password) return password;
    if (previous && binding(previous.config) !== binding(config))
      throw new Error("O destino, usuário ou segurança mudou. Digite a senha novamente.");
    const session = id ? this.sessionPasswords.get(this.key(path, id)) : null;
    if (session && session.binding === binding(config)) return session.password;
    if (!previous?.encryptedPassword)
      throw new Error("Informe a senha do usuário na tela Conexões e salve antes de continuar.");
    try {
      if (!this.secrets.available()) throw new Error();
      const secret = JSON.parse(
        this.secrets.decrypt(Buffer.from(previous.encryptedPassword, "base64")),
      );
      if (
        secret.project !== path ||
        secret.id !== id ||
        secret.binding !== binding(config) ||
        !databasePasswordSchema.min(1).safeParse(secret.password).success
      )
        throw new Error();
      return secret.password;
    } catch {
      throw new Error(
        "Não foi possível desbloquear a senha salva. Digite-a novamente para substituir.",
      );
    }
  }

  save(
    path: string,
    revision: string,
    id: string | null,
    raw: SqlServerConfig,
    password: string,
    remember: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      path = this.projectKey(path);
      this.check(path, revision);
      const config = sqlServerConfigSchema.parse(raw);
      databasePasswordSchema.parse(password);
      const list = this.data.projects[path] || [];
      if (id) this.record(path, id);
      if (!id && list.length >= maxDatabaseConnections)
        throw new Error("Cadastre no máximo 20 conexões por projeto.");
      if (
        list.some(
          (entry) =>
            entry.id !== id &&
            entry.config.name.toLocaleLowerCase() === config.name.toLocaleLowerCase(),
        )
      )
        throw new Error("Já existe uma conexão com esse nome neste projeto.");
      const nextId = id || randomUUID();
      let encryptedPassword: string | undefined;
      const previous = id ? this.record(path, id) : null;
      const sameDestination = !!previous && binding(previous.config) === binding(config);
      // Reuse only a session credential bound to this exact destination. Unchecking
      // persistence removes the saved credential; it does not silently decrypt it again.
      const sessionPassword =
        password ||
        (sameDestination ? this.sessionPasswords.get(this.key(path, nextId))?.password : "") ||
        "";
      if (remember) {
        if (!this.secrets.available())
          throw new Error(
            "Armazenamento protegido indisponível. Desmarque Lembrar senha para salvar os demais campos.",
          );
        const plain = this.password(path, revision, id, config, password);
        try {
          encryptedPassword = this.secrets
            .encrypt(
              JSON.stringify({
                project: path,
                id: nextId,
                binding: binding(config),
                password: plain,
              }),
            )
            .toString("base64");
        } catch {
          throw new Error(
            "Não foi possível proteger a senha. O formulário e a conexão anterior foram preservados.",
          );
        }
      }
      const next = { id: nextId, config, ...(encryptedPassword ? { encryptedPassword } : {}) };
      const connections = id
        ? list.map((entry) => (entry.id === id ? next : entry))
        : [...list, next];
      await this.persist(path, connections);
      this.sessionPasswords.delete(this.key(path, nextId));
      if (!remember && sessionPassword)
        this.sessionPasswords.set(this.key(path, nextId), {
          binding: binding(config),
          password: sessionPassword,
        });
    });
  }

  remove(path: string, revision: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      path = this.projectKey(path);
      this.check(path, revision);
      this.record(path, id);
      await this.persist(
        path,
        this.data.projects[path].filter((entry) => entry.id !== id),
      );
      this.sessionPasswords.delete(this.key(path, id));
    });
  }

  restore(path: string, revision: string, sourceId: string, sourceRevision: string): Promise<void> {
    return this.enqueue(async () => {
      path = this.projectKey(path);
      this.check(path, revision);
      const source = [...this.projectIds].find(([, id]) => id === sourceId)?.[0];
      if (!source || source === path)
        throw new Error("Cadastro de origem indisponível. Reabra Conexões.");
      this.check(source, sourceRevision);
      const previous = this.data.projects[path] || [];
      const additions: Stored["projects"][string] = [];
      const sessions: { id: string; config: SqlServerConfig; password: string }[] = [];
      for (const record of this.data.projects[source] || []) {
        const duplicate = previous.find(
          (entry) =>
            entry.config.name.toLocaleLowerCase() === record.config.name.toLocaleLowerCase(),
        );
        if (duplicate) {
          if (JSON.stringify(duplicate.config) === JSON.stringify(record.config)) continue;
          throw new Error(
            "Já existe uma conexão diferente com esse nome. Renomeie-a antes de recuperar.",
          );
        }
        const id = randomUUID(),
          config = structuredClone(record.config);
        let encryptedPassword: string | undefined;
        if (record.encryptedPassword) {
          const password = this.password(source, sourceRevision, record.id, record.config, "");
          try {
            encryptedPassword = this.secrets
              .encrypt(JSON.stringify({ project: path, id, binding: binding(config), password }))
              .toString("base64");
          } catch {
            throw new Error(
              "Não foi possível proteger a senha recuperada. Cadastros anteriores preservados.",
            );
          }
        } else {
          const session = this.sessionPasswords.get(this.key(source, record.id));
          if (session && session.binding === binding(config))
            sessions.push({ id, config, password: session.password });
        }
        additions.push({ id, config, ...(encryptedPassword ? { encryptedPassword } : {}) });
      }
      if (previous.length + additions.length > maxDatabaseConnections)
        throw new Error("A recuperação excede 20 conexões. Os cadastros foram preservados.");
      if (!additions.length) return;
      await this.persist(path, [...previous, ...additions]);
      for (const entry of sessions)
        this.sessionPasswords.set(this.key(path, entry.id), {
          binding: binding(entry.config),
          password: entry.password,
        });
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const execution = this.queue.then(operation);
    this.queue = execution.catch(() => {});
    return execution;
  }
  private async persist(path: string, connections: Stored["projects"][string]): Promise<void> {
    const next: Stored = { version: 1, projects: { ...this.data.projects, [path]: connections } };
    try {
      const content = JSON.stringify(storageSchema.parse(next));
      if (Buffer.byteLength(content, "utf8") > 2 * 1024 * 1024) throw new Error();
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, content, {
        mode: 0o600,
      });
      await rename(`${this.file}.tmp`, this.file);
    } catch {
      throw new Error(
        "Não foi possível salvar as conexões. Os dados anteriores e o formulário foram preservados.",
      );
    }
    this.data = next;
    this.revisions.set(path, randomUUID());
  }
  async settled(): Promise<void> {
    await this.queue;
  }
}

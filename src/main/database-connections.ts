import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private file: string,
    private secrets: DatabaseSecretStorage,
  ) {}

  async init(): Promise<void> {
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
    if (!this.revisions.has(path)) this.revisions.set(path, randomUUID());
    return {
      revision: this.revisions.get(path)!,
      connections: (this.data.projects[path] || []).map(({ id, config, encryptedPassword }) => ({
        id,
        config: structuredClone(config),
        passwordSaved: !!encryptedPassword,
      })),
      canRememberPassword: this.secrets.available(),
      test: null,
    };
  }

  private check(path: string, revision: string): void {
    if (this.snapshot(path).revision !== revision)
      throw new Error("As conexões mudaram. Reabra Conexões antes de continuar.");
  }

  private record(path: string, id: string) {
    const record = this.data.projects[path]?.find((entry) => entry.id === id);
    if (!record) throw new Error("Conexão não encontrada neste projeto. Reabra Conexões.");
    return record;
  }

  password(
    path: string,
    revision: string,
    id: string | null,
    config: SqlServerConfig,
    supplied: string,
  ): string {
    this.check(path, revision);
    const previous = id ? this.record(path, id) : null;
    const password = databasePasswordSchema.parse(supplied);
    if (password) return password;
    if (!previous?.encryptedPassword)
      throw new Error("Informe a senha do usuário para testar ou lembrá-la.");
    if (binding(previous.config) !== binding(config))
      throw new Error("O destino, usuário ou segurança mudou. Digite a senha novamente.");
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
    });
  }

  remove(path: string, revision: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      this.check(path, revision);
      this.record(path, id);
      await this.persist(
        path,
        this.data.projects[path].filter((entry) => entry.id !== id),
      );
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

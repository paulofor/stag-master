import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  apiConfigSchema,
  apiSecretSchema,
  type ApiConfig,
  type ProjectApis,
} from "../shared/api-connections";
import type { DatabaseSecretStorage } from "./database-connections";

export class ApiFailure extends Error {}
export function apiError(error: unknown): string {
  return error instanceof ApiFailure
    ? error.message
    : "Não foi possível concluir a operação da API. Confira a configuração e tente novamente; nenhum pedido é repetido automaticamente.";
}
const secretsSchema = z
  .object({
    credential: apiSecretSchema.default(""),
    accessToken: apiSecretSchema.min(1).optional(),
    refreshToken: apiSecretSchema.min(1).optional(),
    expiresAt: z.number().finite().optional(),
  })
  .strict();
export type ApiSecrets = z.infer<typeof secretsSchema>;
const recordSchema = z
  .object({
    id: z.uuid(),
    config: apiConfigSchema,
    remember: z.boolean(),
    encryptedSecrets: z
      .string()
      .max(131072)
      .regex(/^[a-z\d+/]+=*$/i)
      .optional(),
  })
  .strict();
const storageSchema = z
  .object({ version: z.literal(1), projects: z.record(z.string(), z.array(recordSchema).max(20)) })
  .strict();
type Stored = z.infer<typeof storageSchema>;
export function apiBinding(config: ApiConfig): string {
  const { name: _name, timeoutSeconds: _timeout, ...destination } = config;
  return JSON.stringify(destination);
}

export class ApiConnections {
  private data: Stored = { version: 1, projects: {} };
  private revisions = new Map<string, string>();
  private memory = new Map<string, ApiSecrets>();
  private queue: Promise<void> = Promise.resolve();
  constructor(
    private file: string,
    private protection: DatabaseSecretStorage,
  ) {}
  async init(): Promise<void> {
    try {
      if ((await stat(this.file)).size > 4 * 1024 * 1024) throw new Error();
      this.data = storageSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ApiFailure(
          "Não foi possível carregar as APIs salvas. Preserve o arquivo e reinicie para tentar novamente.",
        );
    }
  }
  private key(project: string, id: string): string {
    return JSON.stringify([project, id]);
  }
  snapshot(project: string): ProjectApis {
    if (!this.revisions.has(project)) this.revisions.set(project, randomUUID());
    return {
      revision: this.revisions.get(project)!,
      connections: (this.data.projects[project] || []).map((entry) => {
        let secret: ApiSecrets | null = null;
        try {
          secret = this.readSecrets(project, entry);
        } catch {
          /* Unavailable keystore is not plaintext fallback. */
        }
        return {
          id: entry.id,
          config: structuredClone(entry.config),
          remember: entry.remember,
          credentialAvailable: !!secret?.credential,
          authenticated:
            entry.config.auth.type === "none" ||
            (entry.config.auth.type === "oauth2" ? !!secret?.accessToken : !!secret?.credential),
        };
      }),
      canRemember: this.protection.available(),
      authorized: false,
      operation: null,
      metrics: { requests: 0, failures: 0, elapsedMs: 0, lastStatus: null },
    };
  }
  check(project: string, revision: string): void {
    if (this.snapshot(project).revision !== revision)
      throw new ApiFailure(
        "As APIs mudaram. Reabra APIs e confira a configuração antes de continuar.",
      );
  }
  get(project: string, revision: string, id: string) {
    this.check(project, revision);
    const entry = this.data.projects[project]?.find((entry) => entry.id === id);
    if (!entry) throw new ApiFailure("API não encontrada neste projeto. Reabra APIs.");
    return structuredClone(entry);
  }
  secrets(project: string, revision: string, id: string): ApiSecrets {
    return this.readSecrets(project, this.get(project, revision, id));
  }
  private readSecrets(project: string, entry: Stored["projects"][string][number]): ApiSecrets {
    const cached = this.memory.get(this.key(project, entry.id));
    if (cached) return { ...cached };
    if (!entry.encryptedSecrets) return { credential: "" };
    try {
      if (!this.protection.available()) throw new Error();
      const data = JSON.parse(
        this.protection.decrypt(Buffer.from(entry.encryptedSecrets, "base64")),
      );
      if (
        data.project !== project ||
        data.id !== entry.id ||
        data.binding !== apiBinding(entry.config)
      )
        throw new Error();
      return secretsSchema.parse(data.secrets);
    } catch {
      throw new ApiFailure(
        "Não foi possível desbloquear as credenciais. Informe-as novamente no cadastro APIs.",
      );
    }
  }
  save(
    project: string,
    revision: string,
    id: string | null,
    raw: ApiConfig,
    secret: string,
    remember: boolean,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.check(project, revision);
      const config = apiConfigSchema.parse(raw);
      apiSecretSchema.parse(secret);
      const list = this.data.projects[project] || [];
      const previous = id ? this.get(project, revision, id) : null;
      if (!id && list.length >= 20) throw new ApiFailure("Cadastre no máximo 20 APIs por projeto.");
      if (
        list.some(
          (entry) =>
            entry.id !== id &&
            entry.config.name.toLocaleLowerCase() === config.name.toLocaleLowerCase(),
        )
      )
        throw new ApiFailure("Já existe uma API com esse nome neste projeto.");
      const unchanged = previous && apiBinding(previous.config) === apiBinding(config);
      let credentials: ApiSecrets = { credential: secret };
      if (!secret && unchanged) credentials = this.readSecrets(project, previous);
      const requiresCredential =
        ["basic", "bearer"].includes(config.auth.type) ||
        (config.auth.type === "oauth2" && config.auth.clientAuthentication !== "none");
      if (requiresCredential && !credentials.credential)
        throw new ApiFailure(
          "Informe a senha, token ou segredo do cliente. Alterar destino, usuário ou segurança exige nova credencial.",
        );
      if (config.auth.type === "none") credentials = { credential: "" };
      if (config.auth.type === "bearer" && /\s/.test(credentials.credential))
        throw new ApiFailure("Informe somente o token, sem o prefixo Bearer e sem espaços.");
      const entry = { id: id || randomUUID(), config, remember };
      const stored = this.protect(project, entry, credentials);
      await this.persist(
        project,
        id ? list.map((old) => (old.id === id ? stored : old)) : [...list, stored],
      );
      this.memory.set(this.key(project, entry.id), credentials);
      this.revisions.set(project, randomUUID());
    });
  }
  setSecrets(project: string, revision: string, id: string, value: ApiSecrets): Promise<void> {
    return this.enqueue(async () => {
      const entry = this.get(project, revision, id);
      const secrets = secretsSchema.parse(value);
      const stored = this.protect(project, entry, secrets);
      if (entry.remember)
        await this.persist(
          project,
          this.data.projects[project].map((old) => (old.id === id ? stored : old)),
        );
      this.memory.set(this.key(project, id), secrets);
    });
  }
  remove(project: string, revision: string, id: string): Promise<void> {
    return this.enqueue(async () => {
      this.get(project, revision, id);
      await this.persist(
        project,
        this.data.projects[project].filter((entry) => entry.id !== id),
      );
      this.memory.delete(this.key(project, id));
      this.revisions.set(project, randomUUID());
    });
  }
  private protect(
    project: string,
    entry: Omit<Stored["projects"][string][number], "encryptedSecrets">,
    secrets: ApiSecrets,
  ) {
    const { id, config, remember } = entry;
    if (!remember) return { id, config, remember };
    try {
      if (!this.protection.available()) throw new Error();
      return {
        id,
        config,
        remember,
        encryptedSecrets: this.protection
          .encrypt(JSON.stringify({ project, id, binding: apiBinding(config), secrets }))
          .toString("base64"),
      };
    } catch {
      throw new ApiFailure(
        "Armazenamento protegido indisponível. Desmarque Lembrar credenciais para usar somente nesta sessão. O cadastro anterior foi preservado.",
      );
    }
  }
  private async persist(project: string, records: Stored["projects"][string]): Promise<void> {
    const next: Stored = { version: 1, projects: { ...this.data.projects, [project]: records } };
    try {
      const content = JSON.stringify(storageSchema.parse(next));
      if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw new Error();
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, content, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    } catch {
      throw new ApiFailure(
        "Não foi possível salvar as APIs. O cadastro anterior e o formulário foram preservados.",
      );
    }
    this.data = next;
  }
  private enqueue(operation: () => Promise<void>) {
    const task = this.queue.then(operation);
    this.queue = task.catch(() => {});
    return task;
  }
  async settled(): Promise<void> {
    await this.queue;
  }
}

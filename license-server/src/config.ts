import { readFile, lstat } from "node:fs/promises";
import { privateSigner, validPasswordHash } from "./security.js";

export function publicOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("PUBLIC_URL deve ser uma origem HTTPS, ou HTTP somente em loopback.");
  return url;
}
async function secret(path: string | undefined): Promise<string> {
  if (!path) throw new Error("Arquivo de segredo obrigatório ausente.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || stat.size < 1)
    throw new Error("Arquivo de segredo inválido.");
  return (await readFile(path, "utf8")).trim();
}
export async function loadConfig(env = process.env) {
  const origin = publicOrigin(env.PUBLIC_URL || "http://127.0.0.1:8080");
  const adminUsername = env.ADMIN_USERNAME || "admin";
  if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(adminUsername)) throw new Error("ADMIN_USERNAME inválido.");
  const adminPasswordHash = await secret(env.ADMIN_PASSWORD_HASH_FILE);
  if (!validPasswordHash(adminPasswordHash)) throw new Error("Hash de senha inicial inválido.");
  const dbPassword = await secret(env.PGPASSWORD_FILE);
  const signer = privateSigner(await secret(env.SIGNING_KEY_FILE));
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT inválida.");
  const offlineHours = Number(env.OFFLINE_HOURS || 48);
  if (!Number.isInteger(offlineHours) || offlineHours < 1 || offlineHours > 48)
    throw new Error("OFFLINE_HOURS deve ficar entre 1 e 48.");
  return {
    origin: origin.origin,
    secure: origin.protocol === "https:",
    port,
    adminUsername,
    adminPasswordHash,
    signer,
    offlineHours,
    database: {
      host: env.PGHOST || "postgres",
      port: Number(env.PGPORT || 5432),
      database: env.PGDATABASE || "stag_licenses",
      user: env.PGUSER || "stag_license_app",
      password: dbPassword,
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 5000,
      query_timeout: 6000,
    },
  };
}
export type Config = Awaited<ReturnType<typeof loadConfig>>;

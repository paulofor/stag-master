import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function createEnvironment({
  url = "http://localhost:3000",
  email = "admin@example.invalid",
} = {}) {
  const parsed = new URL(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    !(parsed.protocol === "https:" || (local && parsed.protocol === "http:"))
  ) {
    throw new Error(
      "Use uma origem HTTPS sem credenciais, caminho ou query; HTTP somente em loopback.",
    );
  }
  if (!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email)) {
    throw new Error("Informe um email valido.");
  }
  const secret = () => randomBytes(32).toString("hex");
  return {
    NEXTAUTH_URL: parsed.origin,
    STAG_TRACE_PORT: local ? parsed.port || (parsed.protocol === "https:" ? "443" : "80") : "3000",
    STAG_TRACE_DOMAIN: local ? "" : parsed.host,
    LANGFUSE_ADMIN_EMAIL: email,
    POSTGRES_PASSWORD: secret(),
    CLICKHOUSE_PASSWORD: secret(),
    REDIS_AUTH: secret(),
    MINIO_ROOT_PASSWORD: secret(),
    NEXTAUTH_SECRET: secret(),
    SALT: secret(),
    ENCRYPTION_KEY: secret(),
    LANGFUSE_ADMIN_PASSWORD: secret(),
    LANGFUSE_PUBLIC_KEY: `pk-lf-${secret()}`,
    LANGFUSE_SECRET_KEY: `sk-lf-${secret()}`,
  };
}

export async function writeEnvironment(path, values) {
  await writeFile(
    path,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(""),
    {
      mode: 0o600,
      flag: "wx",
    },
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        output: { type: "string", default: "server/.env" },
        url: { type: "string", default: "http://localhost:3000" },
        email: { type: "string", default: "admin@example.invalid" },
      },
    });
    await writeEnvironment(values.output, createEnvironment(values));
    console.log(
      "Ambiente criado com permissoes restritas. Guarde os segredos; arquivo existente nunca e sobrescrito.",
    );
  } catch {
    console.error(
      "Nao foi possivel criar o ambiente. Confira origem HTTPS (ou loopback), email e arquivo de destino inexistente.",
    );
    process.exitCode = 1;
  }
}

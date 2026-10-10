import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile, chmod, rm, lstat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, randomSecret } from "../dist/security.js";
import { publicOrigin } from "../dist/config.js";

export async function initialize({
  directory,
  envFile,
  url = "http://127.0.0.1:8080",
  username = "admin",
}) {
  const origin = publicOrigin(url);
  if (origin.protocol === "https:" && origin.port)
    throw new Error("O perfil HTTPS do Compose usa a porta padrão 443.");
  if (!/^[a-zA-Z0-9._@-]{3,80}$/.test(username)) throw new Error("Usuário inicial inválido.");
  directory = resolve(directory);
  envFile = resolve(envFile);
  // Existing files/directories are never reused or overwritten, including symlinks.
  for (const path of [directory, envFile]) {
    try {
      await lstat(path);
      throw new Error("O destino já existe; preserve os segredos e use a configuração atual.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(dirname(envFile), { recursive: true });
  await mkdir(directory, { mode: 0o700 });
  let wroteEnv = false;
  try {
    const password = randomSecret();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const values = {
      "postgres-password.txt": randomSecret(),
      "postgres-admin-password.txt": randomSecret(),
      "admin-password-hash.txt": await hashPassword(password),
      "signing-key.pem": privateKey.export({ type: "pkcs8", format: "pem" }),
      "public-key.pem": publicKey.export({ type: "spki", format: "pem" }),
      "initial-admin-password.txt": password,
    };
    for (const [name, value] of Object.entries(values)) {
      const path = join(directory, name);
      await writeFile(path, value, { flag: "wx", mode: 0o600 });
      // Compose bind-mount secrets retain source permissions. Parent 0700 protects host access;
      // mounted files are read-only in only the services that explicitly receive them.
      if (name !== "initial-admin-password.txt") await chmod(path, 0o444);
    }
    await writeFile(
      envFile,
      `PUBLIC_URL=${origin.origin}\nADMIN_USERNAME=${username}\nOFFLINE_HOURS=48\nLICENSE_PORT=${origin.port || (origin.protocol === "https:" ? 8080 : 80)}\nLICENSE_DOMAIN=${origin.protocol === "https:" ? origin.hostname : ""}\n`,
      { flag: "wx", mode: 0o600 },
    );
    wroteEnv = true;
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    if (wroteEnv) await rm(envFile, { force: true });
    throw e;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const values = {};
    if (args.length % 2) throw new Error("Argumentos inválidos.");
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i];
      if (!["--directory", "--output-env", "--url", "--username"].includes(key) || key in values)
        throw new Error("Argumentos inválidos.");
      values[key] = args[i + 1];
    }
    const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    await initialize({
      directory: values["--directory"] || join(base, ".secrets"),
      envFile: values["--output-env"] || join(base, ".env"),
      url: values["--url"],
      username: values["--username"],
    });
    console.log(
      "Configuração criada. Consulte initial-admin-password.txt no diretório privado de segredos e altere a senha pelo painel. Nenhuma credencial foi impressa.",
    );
  } catch {
    console.error(
      "Não foi possível preparar a configuração. Confira os argumentos e use destinos novos; arquivos existentes foram preservados.",
    );
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createEnvironment, writeEnvironment } from "../scripts/init-env.mjs";
import { testImageOverlay } from "./images.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const project =
  process.env.STAG_TEST_COMPOSE_PROJECT || `stag-traces-test-${randomBytes(6).toString("hex")}`;
assert.match(project, /^(stag-traces-test-|aihub-)[a-z0-9-]+$/, "namespace de teste obrigatorio");
await mkdir(join(root, ".local"), { recursive: true });
const dir = await mkdtemp(join(root, ".local/server-test-"));
const values = {
  ...createEnvironment(),
  STAG_TRACE_DOMAIN: "traces.example.invalid",
  TEST_PUBLIC_KEY_B: `pk-lf-${randomBytes(32).toString("hex")}`,
  TEST_SECRET_KEY_B: `sk-lf-${randomBytes(32).toString("hex")}`,
};
const envFile = join(dir, ".env");
await writeEnvironment(envFile, values);
const env = {
  ...process.env,
  ...values,
  COMPOSE_ANSI: "never",
  COMPOSE_PROGRESS: "quiet",
  COMPOSE_IGNORE_ORPHANS: "false",
};
const base = [
  "compose",
  "-p",
  project,
  "--env-file",
  envFile,
  "-f",
  join(root, "server/compose.yaml"),
];
const https = [...base, "-f", join(root, "server/compose.https.yaml")];
const mirrorFile = join(dir, "mirrors.json");
const compose = [...https, "-f", join(root, "server/test/compose.yaml"), "-f", mirrorFile];
let ownsStack = false;
let interrupted = false;
let activeChild;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    interrupted = true;
    activeChild?.kill("SIGTERM");
  });
}

function redact(text) {
  const secrets = Object.entries(values)
    .filter(([key]) => /PASSWORD|KEY|SECRET|AUTH$|SALT/.test(key))
    .map(([, value]) => value);
  secrets.push(
    Buffer.from(`${values.LANGFUSE_PUBLIC_KEY}:${values.LANGFUSE_SECRET_KEY}`).toString("base64"),
  );
  secrets.push(
    Buffer.from(`${values.TEST_PUBLIC_KEY_B}:${values.TEST_SECRET_KEY_B}`).toString("base64"),
  );
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.slice(-2000);
}

function command(binary, args, options = {}) {
  if (interrupted && !options.allowFailure)
    throw new Error("Teste interrompido; iniciando limpeza.");
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
    activeChild = child;
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-2_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.on("error", () => reject(new Error(`${binary} indisponivel`)));
    child.on("close", (code) => {
      if (activeChild === child) activeChild = undefined;
      if (code === 0 || options.allowFailure) resolveCommand({ code, output, stderr });
      else
        reject(
          new Error(
            `${binary}: etapa ${options.label || args.at(-1)} falhou (codigo ${code})\n${redact(stderr)}`,
          ),
        );
    });
  });
}
const docker = (args, options) => command("docker", args, options);
const run = (args, options) => docker([...compose, ...args], options);

try {
  console.log("Servidor: validando configuracao, segredos obrigatorios e isolamento de rede.");
  const normal = JSON.parse((await docker([...base, "config", "--format", "json"])).output);
  await writeFile(
    mirrorFile,
    JSON.stringify(
      testImageOverlay(
        normal.services,
        await readFile(join(root, "server/Dockerfile.proxy"), "utf8"),
        await readFile(join(root, "server/test/Dockerfile"), "utf8"),
      ),
    ),
    { mode: 0o600 },
  );
  for (const [name, service] of Object.entries(normal.services)) {
    assert.ok(service.image.includes("@sha256:"), "imagem fixada");
    assert.notEqual(service.network_mode, "host");
    assert.ok(!service.privileged);
    assert.ok(service.volumes?.every((volume) => volume.type === "volume") ?? true);
    if (name === "langfuse-web") {
      assert.equal(service.ports.length, 1);
      assert.equal(service.ports[0].host_ip, "127.0.0.1");
      assert.equal(service.environment.AUTH_DISABLE_SIGNUP, "true");
    } else assert.equal(service.ports?.length || 0, 0, "dependencias privadas");
    if (name.startsWith("langfuse-")) {
      assert.equal(service.environment.HOSTNAME, "0.0.0.0", "healthcheck em loopback");
      assert.equal(service.environment.TELEMETRY_ENABLED, "false");
      assert.equal(service.environment.LANGFUSE_IN_APP_AGENT_ENABLED, "false");
      assert.ok(
        !Object.keys(service.environment).some((key) => key.startsWith("AWS_")),
        "sem credenciais externas herdadas",
      );
    }
  }
  assert.equal(
    normal.services["langfuse-worker"].depends_on["langfuse-web"].condition,
    "service_healthy",
  );
  const version = (service) => service.image.split(":").at(-2).split("@")[0];
  assert.equal(
    version(normal.services["langfuse-web"]),
    version(normal.services["langfuse-worker"]),
    "web e worker na mesma versao",
  );
  const missing = await docker([...base, "config", "--quiet"], { allowFailure: true });
  assert.equal(missing.code, 0);
  const saved = env.ENCRYPTION_KEY;
  env.ENCRYPTION_KEY = "";
  const denied = await docker([...base, "config", "--quiet"], { allowFailure: true });
  env.ENCRYPTION_KEY = saved;
  assert.notEqual(denied.code, 0, "segredo ausente impede inicializacao");
  const minioScript = join(dir, "minio-start.sh");
  await writeFile(minioScript, `#!/bin/sh\n${normal.services.minio.command[0]}\n`);
  await command("bash", ["-n", minioScript]);
  await command("shellcheck", [minioScript]);
  await run(["config", "--quiet"]);
  const previous = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  assert.equal(previous.output.trim(), "", "namespace ja em uso; nada sera removido");
  const previousVolumes = await docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  assert.equal(previousVolumes.output.trim(), "", "volumes preexistentes; nada sera removido");
  ownsStack = true;
  console.log("Servidor: construindo imagens versionadas do proxy e do probe.");
  await run(["build", "proxy", "probe"]);
  await docker(
    [
      ...https,
      "run",
      "--rm",
      "--no-deps",
      "proxy",
      "caddy",
      "validate",
      "--config",
      "/etc/caddy/Caddyfile",
    ],
    { label: "configuracao HTTPS" },
  );
  console.log("Servidor: iniciando Langfuse e dependencias com dados sinteticos.");
  await run(["up", "-d", "--wait", "--wait-timeout", "360"], { label: "inicializacao" });
  console.log("Servidor: testando proxy, autenticacao, ingestao, duplicatas e projetos A/B.");
  await run(["run", "--rm", "--no-deps", "probe", "ingest"], { label: "ingestao" });
  console.log("Servidor: interrompendo API e verificando falha observavel.");
  await run(["stop", "langfuse-web"]);
  await run(["run", "--rm", "--no-deps", "probe", "down"], { label: "indisponibilidade" });
  console.log("Servidor: recriando containers e preservando volumes para verificar recuperacao.");
  await run(["down", "--remove-orphans"]);
  await run(["up", "-d", "--wait", "--wait-timeout", "360"], { label: "recuperacao" });
  await run(["run", "--rm", "--no-deps", "probe", "persisted"], { label: "persistencia" });
  await run(["run", "--rm", "--no-deps", "probe", "ingest"], {
    label: "nova ingestao apos recuperacao",
  });
  console.log("Servidor: todos os cenarios aprovados.");
} catch (error) {
  // Nunca imprimir config expandida, payloads ou segredos; diagnosticos sao limitados/redigidos.
  console.error(
    error instanceof assert.AssertionError ? error.message.split("\n")[0] : error.message,
  );
  if (ownsStack) {
    const status = await run(["ps", "--all", "--format", "json"], { allowFailure: true });
    try {
      for (const line of status.output.trim().split("\n").filter(Boolean)) {
        const service = JSON.parse(line);
        console.error(
          `${service.Service}: ${service.State}, saude=${service.Health || "n/a"}, saida=${service.ExitCode}`,
        );
      }
    } catch {
      console.error("Status de containers indisponivel.");
    }
    const logs = await run(["logs", "--no-color", "--tail", "12"], { allowFailure: true });
    const failures = logs.output
      .split("\n")
      .filter((line) => /error|fatal|denied|no space|unable/i.test(line));
    if (failures.length) console.error(redact(failures.join("\n")));
  }
  process.exitCode = 1;
} finally {
  let cleaned = true;
  if (ownsStack) {
    console.log("Servidor: removendo containers, redes e volumes de teste.");
    const cleanup = await run(["down", "--volumes", "--remove-orphans"], {
      allowFailure: true,
    }).catch(() => ({ code: 1 }));
    if (cleanup.code !== 0) {
      cleaned = false;
      console.error(
        "Limpeza da topologia falhou; repita down --volumes --remove-orphans no projeto de teste.",
      );
      console.error(`Ambiente restrito preservado para limpeza: ${envFile}`);
      process.exitCode = 1;
    }
  }
  if (cleaned) await rm(dir, { recursive: true, force: true });
}

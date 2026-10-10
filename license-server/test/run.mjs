import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initialize } from "../scripts/init.mjs";
import { testImage } from "../../server/test/images.mjs";
import { apiContracts } from "./contracts.mjs";
import { browserContracts } from "./browser.mjs";
import { randomSecret } from "../dist/security.js";
import { createDevice, deviceRequest } from "../client/client.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const project =
  process.env.STAG_TEST_COMPOSE_PROJECT || `stag-license-test-${randomBytes(6).toString("hex")}`;
assert.match(
  project,
  /^(stag-license-test-|aihub-)[a-z0-9-]+$/,
  "namespace exclusivo de teste obrigatório",
);
await mkdir(join(root, ".local"), { recursive: true });
const directory = await mkdtemp(join(root, ".local/license-test-"));
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolvePort(value));
  });
});
const origin = `http://127.0.0.1:${port}`;
const secretDir = join(directory, "secrets");
const envFile = join(directory, "config.env");
await initialize({ directory: secretDir, envFile, url: origin });
const password = await readFile(join(secretDir, "initial-admin-password.txt"), "utf8");
const publicKey = await readFile(join(secretDir, "public-key.pem"), "utf8");
const secretValues = await Promise.all(
  [
    "postgres-password.txt",
    "admin-password-hash.txt",
    "signing-key.pem",
    "initial-admin-password.txt",
    "postgres-admin-password.txt",
  ].map((n) => readFile(join(secretDir, n), "utf8")),
);
const env = {
  ...process.env,
  PUBLIC_URL: origin,
  LICENSE_PORT: String(port),
  LICENSE_SECRETS_DIR: secretDir,
  LICENSE_DOMAIN: "licenses.synthetic.invalid",
  COMPOSE_ANSI: "never",
  COMPOSE_PROGRESS: "quiet",
  COMPOSE_IGNORE_ORPHANS: "false",
  LOCAL_UID: String(process.getuid?.() || 0),
  LOCAL_GID: String(process.getgid?.() || 0),
  LICENSE_SETUP_DIR: join(directory, "setup-check"),
};
const base = [
  "compose",
  "-p",
  project,
  "--env-file",
  envFile,
  "-f",
  join(root, "license-server/compose.yaml"),
];
const mirror = join(directory, "mirror.json");
const compose = [...base, "-f", mirror];
let owned = false;
let relay;
let interrupted = false;
const children = new Set();
function redact(value) {
  for (const secret of secretValues) value = value.replaceAll(secret, "[redacted]");
  return value.slice(-3000);
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    interrupted = true;
    for (const child of children) child.kill("SIGTERM");
  });
function command(binary, args, { allowFailure = false, label = "comando", input } = {}) {
  if (interrupted && !allowFailure) throw new Error("Homologação interrompida; iniciando limpeza.");
  return new Promise((resolveCommand, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let output = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      output = (output + chunk).slice(-4_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-20_000);
    });
    child.once("error", () => reject(new Error(`${label}: ferramenta indisponível.`)));
    child.once("close", (code) => {
      children.delete(child);
      if (code === 0 || allowFailure) resolveCommand({ code, output, stderr });
      else reject(new Error(`${label} falhou (código ${code}).\n${redact(stderr)}`));
    });
    child.stdin.end(input);
  });
}
const docker = (args, options) => command("docker", args, options);
const run = (args, options) => docker([...compose, ...args], options);
const sql = async (statement) => {
  await run(
    [
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "stag_licenses",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { label: "SQL sintético" },
  );
};
try {
  const existing = await docker([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const volumes = await docker([
    "volume",
    "ls",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  assert.equal(existing.output.trim(), "", "namespace já em uso; nada será removido");
  assert.equal(volumes.output.trim(), "", "volumes preexistentes; nada será removido");
  const production = JSON.parse((await docker([...base, "config", "--format", "json"])).output);
  assert.equal(production.services["license-server"].ports[0].host_ip, "127.0.0.1");
  assert.equal(production.services.postgres.ports?.length || 0, 0);
  assert.equal(production.services["license-server"].read_only, true);
  assert.equal(production.networks.data.internal, true);
  assert.ok(
    !Object.keys(production.services["license-server"].environment).some((n) =>
      /AWS|CODEX|BRAVE|TOKEN/.test(n),
    ),
  );
  const nodeImage = (await readFile(join(root, "license-server/Dockerfile"), "utf8")).match(
    /^ARG NODE_IMAGE=(\S+)$/m,
  )[1];
  const proxyImage = (await readFile(join(root, "license-server/Dockerfile.proxy"), "utf8")).match(
    /^ARG CADDY_IMAGE=(\S+)$/m,
  )[1];
  const postgresImage = (
    await readFile(join(root, "license-server/Dockerfile.postgres"), "utf8")
  ).match(/^ARG POSTGRES_IMAGE=(\S+)$/m)[1];
  const overlay = {
    services: {
      "license-server": { build: { args: { NODE_IMAGE: testImage(nodeImage) } } },
      setup: { build: { args: { NODE_IMAGE: testImage(nodeImage) } } },
      postgres: { build: { args: { POSTGRES_IMAGE: testImage(postgresImage) } } },
    },
  };
  const stdinSecrets = process.env.STAG_TEST_SECRETS_VIA_STDIN === "1";
  if (stdinSecrets) {
    overlay.services["license-server"].ports = [];
    overlay.services["license-server"].secrets = [];
    overlay.services["license-server"].volumes = [
      { type: "volume", source: "test-api-secrets", target: "/run/secrets", read_only: true },
    ];
    overlay.services.postgres.secrets = [];
    overlay.services.postgres.volumes = [
      { type: "volume", source: "test-db-secrets", target: "/run/secrets", read_only: true },
    ];
    overlay.volumes = { "test-api-secrets": {}, "test-db-secrets": {}, "test-setup": {} };
    overlay.services.setup.volumes = ["test-setup:/setup"];
    overlay.services["secret-init"] = {
      profiles: ["test"],
      build: {
        ...production.services["license-server"].build,
        args: { NODE_IMAGE: testImage(nodeImage) },
      },
      user: "0:0",
      entrypoint: [
        "node",
        "--input-type=module",
        "-e",
        await readFile(join(root, "license-server/test/secrets-stdin.mjs"), "utf8"),
      ],
      volumes: ["test-api-secrets:/api-secrets", "test-db-secrets:/db-secrets"],
      network_mode: "none",
      security_opt: ["no-new-privileges:true"],
      cap_drop: ["ALL"],
    };
  }
  // Compose merges sequences. !reset removes the production secret mounts only in this test overlay.
  const { stringify } = await import("yaml");
  let overlayYaml = stringify(overlay);
  if (stdinSecrets) overlayYaml = overlayYaml.replaceAll("secrets: []", "secrets: !reset []");
  if (stdinSecrets) overlayYaml = overlayYaml.replaceAll("ports: []", "ports: !reset []");
  await writeFile(mirror, overlayYaml, { mode: 0o600 });
  await command("bash", ["-n", join(root, "license-server/scripts/backup.sh")], {
    label: "Sintaxe do backup",
  });
  await command("shellcheck", [join(root, "license-server/scripts/backup.sh")], {
    label: "ShellCheck do backup",
  });
  await command("bash", ["-n", join(root, "license-server/postgres/init-app.sh")], {
    label: "Sintaxe do bootstrap PostgreSQL",
  });
  await command("shellcheck", [join(root, "license-server/postgres/init-app.sh")], {
    label: "ShellCheck do bootstrap PostgreSQL",
  });
  console.log(
    "Licenças: construindo aplicação pelo Dockerfile e PostgreSQL fixado; dados exclusivos.",
  );
  owned = true;
  await run(["build", "license-server", "postgres", "setup"], { label: "Build Docker" });
  await mkdir(env.LICENSE_SETUP_DIR, { mode: 0o700 });
  await run(["--profile", "setup", "run", "--rm", "--no-deps", "setup"], {
    label: "Bootstrap Docker de produção",
  });
  const setupSource = await readFile(join(root, "license-server/test/setup-check.mjs"), "utf8");
  const setupCheck = JSON.parse(
    (
      await run(
        [
          "--profile",
          "setup",
          "run",
          "--rm",
          "--no-deps",
          "--entrypoint",
          "node",
          "setup",
          "--input-type=module",
          "-e",
          setupSource,
        ],
        { label: "Verificação do bootstrap Docker" },
      )
    ).output,
  );
  assert.deepEqual(setupCheck, {
    privateDirectory: true,
    privatePassword: true,
    validPassword: true,
    validKey: true,
    publicConfig: true,
  });
  console.log("Licenças: bootstrap pela CLI empacotada em Docker aprovado, sem Node no host.");
  if (stdinSecrets) {
    const input = JSON.stringify({
      postgres_password: secretValues[0],
      admin_password_hash: secretValues[1],
      signing_key: secretValues[2],
      postgres_admin_password: secretValues[4],
    });
    await run(["--profile", "test", "run", "--rm", "--no-deps", "-T", "secret-init"], {
      label: "Secrets sintéticos por stdin",
      input,
    });
  }
  await run(["up", "-d", "--wait", "--wait-timeout", "120", "license-server"], {
    label: "Inicialização Docker",
  });
  // Caddy is validated without starting public listeners or issuing public certificates.
  const proxyOverlay = join(directory, "proxy-mirror.json");
  await writeFile(
    proxyOverlay,
    JSON.stringify({
      services: { proxy: { build: { args: { CADDY_IMAGE: testImage(proxyImage) } } } },
    }),
    { mode: 0o600 },
  );
  const https = [
    ...compose,
    "-f",
    join(root, "license-server/compose.https.yaml"),
    "-f",
    proxyOverlay,
  ];
  await docker([...https, "build", "proxy"], { label: "Build Caddy" });
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
    { label: "Validação Caddy" },
  );
  if (stdinSecrets) {
    const transport = await readFile(join(root, "license-server/test/http-stdio.mjs"), "utf8");
    relay = createHttpServer(async (req, res) => {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32 * 1024) throw new Error("Limite do relay sintético.");
          chunks.push(chunk);
        }
        const headers = { host: new URL(origin).host };
        for (const name of ["content-type", "origin", "cookie", "x-csrf-token", "x-forwarded-for"])
          if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
        const input = JSON.stringify({
          method: req.method,
          path: req.url,
          headers,
          body: Buffer.concat(chunks).toString("base64"),
        });
        const response = JSON.parse(
          (
            await run(
              ["exec", "-T", "license-server", "node", "--input-type=module", "-e", transport],
              { input, label: "Transporte HTTP sintético" },
            )
          ).output,
        );
        res.writeHead(response.status, response.headers);
        res.end(Buffer.from(response.body, "base64"));
      } catch {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: {
              code: "test_transport_unavailable",
              message: "Transporte sintético indisponível.",
            },
          }),
        );
      }
    });
    await new Promise((resolveRelay, reject) => {
      relay.once("error", reject);
      relay.listen(port, "127.0.0.1", resolveRelay);
    });
  }
  const scenario = await apiContracts(origin, password, publicKey, sql);
  const roles = (
    await run([
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      "postgres",
      "-d",
      "stag_licenses",
      "-tAc",
      "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication FROM pg_roles WHERE rolname='stag_license_app'",
    ])
  ).output.trim();
  assert.equal(roles, "f", "usuário do aplicativo não pode administrar o cluster");
  secretValues.push(...scenario.api.sensitive);
  const user = (await run(["exec", "-T", "license-server", "id", "-u"])).output.trim();
  assert.notEqual(user, "0", "serviço não executa como root");
  await browserContracts({ origin, password, api: scenario.api, directory });
  secretValues.push(...scenario.api.sensitive);

  console.log("Licenças: testando backup, restauração, banco indisponível e reinício.");
  const backup = join(directory, "licenses.dump");
  env.LICENSE_COMPOSE_PROJECT = project;
  env.LICENSE_COMPOSE_ENV = envFile;
  await command("bash", [join(root, "license-server/scripts/backup.sh"), "backup", backup], {
    label: "Backup real",
  });
  await sql(`UPDATE licenses SET label='Changed after backup' WHERE id='${scenario.firstId}'`);
  await command(
    "bash",
    [join(root, "license-server/scripts/backup.sh"), "restore", backup, "--confirm-replace"],
    { label: "Restauração real" },
  );
  const restored = (await scenario.api.request(`/api/admin/licenses/${scenario.firstId}`)).value;
  assert.equal(restored.license.label, "Synthetic beta A");
  await run(["stop", "postgres"], { label: "Parada do banco de teste" });
  await scenario.api.request("/health/ready", "GET", undefined, 503);
  // A structurally valid proof is needed to reach the unavailable database.
  const res = await fetch(origin + "/api/v1/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deviceRequest("activate", randomSecret(), createDevice())),
  });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "service_unavailable");
  await run(["up", "-d", "--wait", "--wait-timeout", "120", "postgres"], {
    label: "Recuperação do banco",
  });
  await scenario.api.request("/health/ready");
  const newPassword = randomSecret();
  secretValues.push(newPassword);
  await scenario.api.request("/api/admin/password", "POST", {
    currentPassword: password,
    newPassword,
  });
  await scenario.api.request("/api/admin/licenses", "GET", undefined, 401);
  await scenario.api.login(newPassword);
  await run(["restart", "license-server"], { label: "Reinício do serviço" });
  await run(["up", "-d", "--wait", "--wait-timeout", "120", "license-server"], {
    label: "Saúde após reinício",
  });
  await scenario.api.request("/api/admin/login", "POST", { username: "admin", password }, 401);
  await scenario.api.login(newPassword);
  assert.ok(
    (await scenario.api.request(`/api/admin/licenses/${scenario.firstId}`)).value.license.id ===
      scenario.firstId,
  );
  const key = (await scenario.api.request("/api/v1/public-key")).value.publicKey;
  assert.ok(key === publicKey, "chave de emissão deve permanecer estável no reinício");
  // Rate limit uses the socket peer; untrusted forwarded headers cannot create a fresh bucket.
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(origin + "/api/admin/login", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": `198.51.100.${i + 1}`,
      },
      body: JSON.stringify({ username: "admin", password: "wrong-synthetic" }),
    });
    if (r.status === 429) {
      limited = true;
      break;
    }
    assert.equal(r.status, 401);
  }
  assert.ok(limited, "limite de login deve ser efetivo");
  const secureSource = await readFile(join(root, "license-server/test/secure-cookie.mjs"), "utf8");
  const secureCookie = JSON.parse(
    (
      await run(
        ["exec", "-T", "license-server", "node", "--input-type=module", "-e", secureSource],
        { input: JSON.stringify({ password: newPassword }), label: "Cookie HTTPS real" },
      )
    ).output,
  );
  assert.deepEqual(secureCookie, {
    status: 200,
    secure: true,
    hostPrefix: true,
    httpOnly: true,
    sameSite: true,
  });
  secretValues.push(...scenario.api.sensitive);
  const audit = (await scenario.api.request("/api/admin/audit")).value;
  for (const secret of secretValues)
    assert.ok(!JSON.stringify(audit).includes(secret), "auditoria deve omitir segredos");
  const logs = (await run(["logs", "--no-color", "license-server"], { label: "Inspeção de logs" }))
    .output;
  for (const secret of secretValues)
    assert.ok(!logs.includes(secret), "logs não podem conter segredo sintético");
  assert.ok(!logs.includes("PRIVATE KEY"));
  assert.ok(!logs.includes("credential"));
  assert.match(logs, /durationMs/);
  assert.match(logs, /requestId/);
  console.log(
    "Licenças: recuperação, backup/restauração, senha, limitação e privacidade dos logs aprovados.",
  );
  await writeFile(
    join(root, ".local/license-validation.json"),
    JSON.stringify(
      {
        status: "passed",
        serviceVersion: "0.1.0",
        date: new Date().toISOString(),
        browsers: ["Chromium desktop", "Chromium Pixel 7"],
        screenshots: directory,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(redact(e.stack || e.message));
  process.exitCode = 1;
} finally {
  if (relay)
    await new Promise((resolveRelay) => {
      relay.close(resolveRelay);
      relay.closeAllConnections();
    });
  if (owned) {
    const cleanup = await docker(
      [
        ...compose,
        "-f",
        join(root, "license-server/compose.https.yaml"),
        "--profile",
        "*",
        "down",
        "--volumes",
        "--remove-orphans",
      ],
      {
        allowFailure: true,
        label: "Limpeza Docker",
      },
    );
    if (cleanup.code !== 0) {
      console.error("Não foi possível concluir a limpeza Docker.");
      process.exitCode = 1;
    }
  }
  // Keep only screenshots for local review; secrets, dumps and temporary configuration are removed.
  await rm(secretDir, { recursive: true, force: true });
  await rm(env.LICENSE_SETUP_DIR, { recursive: true, force: true });
  for (const name of ["config.env", "mirror.json", "proxy-mirror.json", "licenses.dump"])
    await rm(join(directory, name), { force: true });
  console.log(
    owned
      ? "Licenças: limpeza de containers, volumes e credenciais aguardada."
      : "Licenças: namespace preexistente preservado; arquivos temporários descartados.",
  );
}

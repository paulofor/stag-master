import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, lstat, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { publicOrigin, loadConfig } from "../dist/config.js";
import {
  hashPassword,
  checkPassword,
  privateSigner,
  issueLease,
  verifyLease,
  RateLimiter,
  randomSecret,
  object,
  integer,
  uuid,
  validateDeviceRequest,
} from "../dist/security.js";
import { createDevice, deviceRequest, validateAuthorization } from "../client/client.mjs";
import { initialize } from "../scripts/init.mjs";

test("URLs de serviço aceitam HTTPS e loopback, recusam credenciais/protocolos/caminhos", () => {
  for (const value of [
    "https://licenses.example.invalid",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://[::1]:8080",
  ])
    assert.ok(publicOrigin(value));
  for (const value of [
    "http://example.invalid",
    "https://user:secret@example.invalid",
    "file:///tmp/server",
    "https://example.invalid/api",
    "https://example.invalid?a=1",
    "https://example.invalid/#hash",
  ])
    assert.throws(() => publicOrigin(value));
});
test("Validação recusa campos desconhecidos, números e IDs inválidos", () => {
  assert.throws(() => object({ password: "synthetic" }, ["label"]));
  assert.throws(() => object([], []));
  for (const v of [-1, 101, 1.5, "1", NaN]) assert.throws(() => integer(v, 1, 100));
  assert.throws(() => uuid("../path"));
  assert.equal(integer(1, 1, 100), 1);
});
test("Senha usa derivação salgada e comparação, sem aceitação de hash inválido", async () => {
  const password = randomSecret();
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.notEqual(first, second);
  assert.ok(await checkPassword(password, first));
  assert.equal(await checkPassword("another-synthetic", first), false);
  assert.equal(await checkPassword(password, "broken"), false);
  await assert.rejects(hashPassword("short"));
});
const signer = generateKeyPairSync("ed25519").privateKey;
const publicKey = createPublicKey(signer).export({ type: "spki", format: "pem" });
const device = createDevice();
const now = Date.now();
const valid = {
  v: 1,
  aud: "stag-plus",
  licenseId: "test",
  activationId: "test",
  deviceHash: device.deviceHash,
  issuedAt: now,
  expiresAt: now + 48 * 3600_000,
  licenseExpiresAt: now + 60 * 3600_000,
};
test("Cliente real confere assinatura, prazo, audiência e identidade", () => {
  const lease = issueLease(signer, valid);
  assert.equal(validateAuthorization(lease, publicKey, device, now).deviceHash, device.deviceHash);
  assert.throws(() => validateAuthorization(lease, publicKey, createDevice(), now));
  const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => validateAuthorization(lease, wrongKey, device, now));
  assert.throws(() =>
    validateAuthorization(
      { ...lease, payload: lease.payload.slice(0, -3) + "aaa" },
      publicKey,
      device,
      now,
    ),
  );
  assert.throws(() => validateAuthorization(lease, publicKey, device, valid.expiresAt));
});
for (const [name, changes] of Object.entries({
  "offline acima de 48h": { expiresAt: now + 49 * 3600_000 },
  "além do vencimento": { licenseExpiresAt: now + 1 },
  "emissão futura": { issuedAt: now + 61_000 },
  "audiência diferente": { aud: "other" },
  "prazo não numérico": { expiresAt: "tomorrow" },
  "prazo invertido": { expiresAt: now - 1 },
}))
  test(`Verificador recusa ${name}`, () =>
    assert.throws(() =>
      verifyLease(issueLease(signer, { ...valid, ...changes }), publicKey, device.deviceHash, now),
    ));
test("Chave de emissão recusa outros algoritmos", () => {
  const rsa = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  assert.throws(() => privateSigner(rsa));
});
test("Prova do dispositivo vincula ação, credencial, identidade e nome", () => {
  const credential = randomSecret();
  const request = deviceRequest("activate", credential, device, "Synthetic", now);
  assert.equal(validateDeviceRequest("activate", request, now).deviceHash, device.deviceHash);
  for (const [field, value] of [
    ["credential", randomSecret()],
    ["deviceName", "Another"],
    ["publicKey", createDevice().publicKey],
    ["issuedAt", now - 6 * 60_000],
    ["signature", "a".repeat(86)],
    ["nonce", "../not-id"],
  ])
    assert.throws(() => validateDeviceRequest("activate", { ...request, [field]: value }, now));
  assert.throws(() => validateDeviceRequest("refresh", request, now));
  assert.throws(() => validateDeviceRequest("activate", { ...request, extra: "value" }, now));
});
test("Rate limit bloqueia excesso e recupera após a janela", () => {
  const limiter = new RateLimiter();
  limiter.check("one", 1, 1000, 100);
  assert.throws(() => limiter.check("one", 1, 1000, 101));
  limiter.check("two", 1, 1000, 101);
  limiter.check("one", 1, 1000, 1100);
});
test("Inicialização preserva destinos existentes, segredos restritos e configurações públicas", async () => {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/license-unit-"));
  try {
    const secrets = join(dir, "secrets");
    const env = join(dir, "config.env");
    await initialize({ directory: secrets, envFile: env });
    const password = await readFile(join(secrets, "initial-admin-password.txt"), "utf8");
    assert.ok(
      await checkPassword(
        password,
        await readFile(join(secrets, "admin-password-hash.txt"), "utf8"),
      ),
    );
    assert.equal((await lstat(secrets)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(secrets, "initial-admin-password.txt"))).mode & 0o777, 0o600);
    const publicConfig = await readFile(env, "utf8");
    assert.ok(!publicConfig.includes(password));
    assert.ok(!publicConfig.includes("PRIVATE KEY"));
    const snapshot = await readFile(join(secrets, "signing-key.pem"), "utf8");
    await assert.rejects(initialize({ directory: secrets, envFile: env }));
    assert.ok(snapshot === (await readFile(join(secrets, "signing-key.pem"), "utf8")));
    const config = await loadConfig({
      PUBLIC_URL: "http://127.0.0.1:8080",
      PGPASSWORD_FILE: join(secrets, "postgres-password.txt"),
      ADMIN_PASSWORD_HASH_FILE: join(secrets, "admin-password-hash.txt"),
      SIGNING_KEY_FILE: join(secrets, "signing-key.pem"),
    });
    assert.equal(config.offlineHours, 48);
    assert.equal(
      (
        await loadConfig({
          PUBLIC_URL: "https://licenses.example.invalid",
          PGPASSWORD_FILE: join(secrets, "postgres-password.txt"),
          ADMIN_PASSWORD_HASH_FILE: join(secrets, "admin-password-hash.txt"),
          SIGNING_KEY_FILE: join(secrets, "signing-key.pem"),
        })
      ).secure,
      true,
    );
    await assert.rejects(loadConfig({ ...process.env, PUBLIC_URL: "http://example.invalid" }));
    await assert.rejects(
      initialize({
        directory: join(dir, "invalid"),
        envFile: join(dir, "invalid.env"),
        url: "http://external.invalid",
      }),
    );
    await symlink(secrets, join(dir, "linked"));
    await assert.rejects(
      initialize({ directory: join(dir, "linked"), envFile: join(dir, "linked.env") }),
    );
    await writeFile(join(dir, "existing.env"), "preserve");
    await assert.rejects(
      initialize({ directory: join(dir, "new-secrets"), envFile: join(dir, "existing.env") }),
    );
    assert.equal(await readFile(join(dir, "existing.env"), "utf8"), "preserve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("CLI real usa argumento próprio para gravar configuração sem acionar --env-file do Node", async () => {
  await mkdir(".local", { recursive: true });
  const directory = await mkdtemp(resolve(".local/license-cli-"));
  try {
    const output = join(directory, "config.env");
    const secrets = join(directory, "secrets");
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("../scripts/init.mjs", import.meta.url)),
        "--directory",
        secrets,
        "--output-env",
        output,
      ],
      { maxBuffer: 16384 },
    );
    const password = await readFile(join(secrets, "initial-admin-password.txt"), "utf8");
    assert.equal(stderr, "");
    assert.ok(stdout.includes("Configuração criada."));
    assert.ok(!stdout.includes(password));
    assert.ok(!stdout.includes("PRIVATE KEY"));
    assert.match(await readFile(output, "utf8"), /^PUBLIC_URL=http:\/\/127\.0\.0\.1:8080/m);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

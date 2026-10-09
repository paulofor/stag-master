import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvironment, writeEnvironment } from "../scripts/init-env.mjs";
import { testImage, testImageOverlay } from "./images.mjs";

test("espelho do harness preserva digests e registros externos sem duplicar versoes", async () => {
  const digest = `@sha256:${"a".repeat(64)}`;
  for (const [source, target] of [
    ["node:22-alpine", "mirror.gcr.io/library/node:22-alpine"],
    ["docker.io/library/caddy:2-alpine", "mirror.gcr.io/library/caddy:2-alpine"],
    ["clickhouse/clickhouse-server:25.12", "mirror.gcr.io/clickhouse/clickhouse-server:25.12"],
    [
      "docker.langfuse.com/langfuse/langfuse:4.50.0",
      "docker.langfuse.com/langfuse/langfuse:4.50.0",
    ],
    ["cgr.dev/chainguard/minio", "cgr.dev/chainguard/minio"],
  ])
    assert.equal(testImage(source + digest), target + digest);
  for (const value of ["node:latest", "node@sha256:abc", "node:22\nmalformed" + digest])
    assert.throws(() => testImage(value));
  const proxy = await readFile(new URL("../Dockerfile.proxy", import.meta.url), "utf8");
  const probe = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
  const overlay = testImageOverlay(
    { postgres: { image: "postgres:17-alpine" + digest } },
    proxy,
    probe,
  );
  assert.equal(
    overlay.services.postgres.image,
    "mirror.gcr.io/library/postgres:17-alpine" + digest,
  );
  for (const [name, source, key] of [
    ["proxy", proxy, "CADDY_IMAGE"],
    ["probe", probe, "NODE_IMAGE"],
  ]) {
    const original = source.match(new RegExp(`^ARG ${key}=(\\S+)$`, "m"))[1];
    assert.equal(overlay.services[name].build.args[key].split("@")[1], original.split("@")[1]);
    assert.ok(source.includes(`FROM \${${key}}`));
  }
  assert.throws(() => testImageOverlay({}, "FROM caddy:latest", probe));
});

test("ambiente isolado, segredos aleatorios e URL de producao HTTPS", () => {
  const first = createEnvironment();
  const second = createEnvironment({
    url: "https://traces.example.invalid",
    email: "ops@example.invalid",
  });
  assert.equal(first.NEXTAUTH_URL, "http://localhost:3000");
  assert.equal(second.STAG_TRACE_DOMAIN, "traces.example.invalid");
  assert.equal(second.STAG_TRACE_PORT, "3000");
  for (const key of [
    "POSTGRES_PASSWORD",
    "CLICKHOUSE_PASSWORD",
    "REDIS_AUTH",
    "MINIO_ROOT_PASSWORD",
    "SALT",
    "ENCRYPTION_KEY",
    "NEXTAUTH_SECRET",
    "LANGFUSE_ADMIN_PASSWORD",
  ]) {
    assert.match(first[key], /^[a-f0-9]{64}$/);
    assert.notEqual(first[key], second[key]);
  }
});

test("origens inseguras e injecao de ambiente sao recusadas", () => {
  for (const url of [
    "http://remote.invalid",
    "https://user:password@example.invalid",
    "file:///tmp/test",
    "https://example.invalid/path",
    "https://example.invalid/?token=synthetic",
    "https://example.invalid/#secret",
  ]) {
    assert.throws(() => createEnvironment({ url }));
  }
  assert.throws(() => createEnvironment({ email: "admin@example.invalid\nSALT=injetado" }));
});

test("gravacao restrita preserva arquivo existente e recusa links", async () => {
  const dir = await mkdtemp(join(tmpdir(), "stag-traces-env-"));
  try {
    const file = join(dir, ".env");
    await writeEnvironment(file, createEnvironment());
    const before = await readFile(file, "utf8");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(writeEnvironment(file, createEnvironment()), { code: "EEXIST" });
    assert.equal(await readFile(file, "utf8"), before);
    if (process.platform !== "win32") {
      const link = join(dir, "link");
      await symlink(file, link);
      await assert.rejects(writeEnvironment(link, createEnvironment()), { code: "EEXIST" });
      assert.equal(await readFile(file, "utf8"), before);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

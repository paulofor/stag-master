import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createEnvironment, writeEnvironment } from "../scripts/init-env.mjs";

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

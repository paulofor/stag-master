import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/codex-smoke-"));
let rpc;
try {
  await mkdir(join(dir, "home"), { recursive: true });
  await build({
    entryPoints: ["src/main/rpc.ts"],
    outfile: join(dir, "rpc.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { RpcClient } = await import(pathToFileURL(join(dir, "rpc.mjs")).href);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)/i.test(key) &&
        !["NODE_OPTIONS", "CODEX_HOME", "ELECTRON_RUN_AS_NODE"].includes(key),
    ),
  );
  rpc = new RpcClient({
    command: resolve(".local/codex/bin", process.platform === "win32" ? "codex.exe" : "codex"),
    args: ["app-server", "--listen", "stdio://"],
    env: { ...env, CODEX_HOME: join(dir, "home") },
  });
  await rpc.start();
  const account = await rpc.call("account/read", { refreshToken: false });
  assert.equal(account.account, null);
  const models = await rpc.call("model/list", { limit: 20, includeHidden: false });
  assert.ok(Array.isArray(models.data));
  assert.ok(models.data.length > 0);
  // Verify experimental desktop-tool schema against the bundled binary without a turn/LLM call.
  const started = await rpc.call("thread/start", {
    cwd: dir,
    ephemeral: true,
    approvalPolicy: "on-request",
    sandbox: "read-only",
    dynamicTools: [
      {
        type: "function",
        name: "windows_desktop",
        description: "Contract smoke only; never executed.",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string" } },
          required: ["action"],
          additionalProperties: false,
        },
      },
    ],
  });
  assert.ok(started.thread.id);
  console.log(
    `Codex real: handshake, conta isolada, ${models.data.length} modelos e contrato de ferramenta OK. Nenhum turno/LLM executado.`,
  );
} finally {
  await rpc?.shutdown();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

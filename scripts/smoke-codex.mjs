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
    entryPoints: [
      "src/main/rpc.ts",
      "src/main/desktop-tools.ts",
      "src/main/browser-tools.ts",
      "src/main/policy.ts",
    ],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { RpcClient } = await import(pathToFileURL(join(dir, "rpc.mjs")).href);
  const { desktopTool } = await import(pathToFileURL(join(dir, "desktop-tools.mjs")).href);
  const { browserTool } = await import(pathToFileURL(join(dir, "browser-tools.mjs")).href);
  const { assistantInstructions, threadPolicy, codexEnvironment } = await import(
    pathToFileURL(join(dir, "policy.mjs")).href
  );
  rpc = new RpcClient({
    command: resolve(".local/codex/bin", process.platform === "win32" ? "codex.exe" : "codex"),
    args: ["app-server", "--listen", "stdio://"],
    env: codexEnvironment(join(dir, "home")),
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
    ephemeral: false,
    ...threadPolicy("read"),
    developerInstructions: assistantInstructions("read", process.platform, false, true),
    dynamicTools: [desktopTool, browserTool],
  });
  assert.ok(started.thread.id);
  // Materialize synthetic history without starting inference; empty threads have no rollout.
  await rpc.call("thread/inject_items", {
    threadId: started.thread.id,
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Histórico sintético para validar a retomada." }],
      },
    ],
  });
  const resumed = await rpc.call("thread/resume", {
    threadId: started.thread.id,
    cwd: dir,
    ...threadPolicy("read"),
    developerInstructions: assistantInstructions("read", process.platform, true, true),
  });
  assert.equal(resumed.thread.id, started.thread.id);
  console.log(
    `Codex real: handshake, conta isolada, ${models.data.length} modelos, schemas de produção de desktop/browser e instruções start/resume OK. Nenhum turno/LLM executado.`,
  );
} finally {
  await rpc?.shutdown();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

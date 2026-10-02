import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, mkdir, cp, writeFile, readFile, symlink } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/codex-smoke-"));
const project = join(dir, "projeto com espaço-ação");
const neighbor = join(dir, "projeto-vizinho");
let rpc;
try {
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(project);
  await mkdir(neighbor);
  const runner = join(dir, "workspace-files.mjs");
  await cp("tests/fixtures/workspace-files.mjs", runner);
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
  const { assistantInstructions, threadPolicy, turnPolicy, codexEnvironment } = await import(
    pathToFileURL(join(dir, "policy.mjs")).href
  );
  rpc = new RpcClient({
    command: resolve(".local/codex/bin", process.platform === "win32" ? "codex.exe" : "codex"),
    args: [
      "app-server",
      "--listen",
      "stdio://",
      ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
    ],
    cwd: project,
    env: codexEnvironment(join(dir, "home")),
  });
  await rpc.start();
  const account = await rpc.call("account/read", { refreshToken: false });
  assert.equal(account.account, null);
  const models = await rpc.call("model/list", { limit: 20, includeHidden: false });
  assert.ok(Array.isArray(models.data));
  assert.ok(models.data.length > 0);
  if (process.platform === "win32") {
    let listener;
    let timer;
    const ready = new Promise((resolve, reject) => {
      listener = (message) => {
        if (message.method !== "windowsSandbox/setupCompleted") return;
        if (message.params.success) resolve();
        else reject(new Error(message.params.error || "Falha no sandbox Windows de teste."));
      };
      timer = setTimeout(() => {
        reject(new Error("O sandbox Windows não concluiu a preparação após o handshake."));
      }, 60000);
      rpc.on("notification", listener);
    });
    try {
      await Promise.all([ready, rpc.call("windowsSandbox/setupStart", { mode: "unelevated" })]);
    } finally {
      clearTimeout(timer);
      rpc.off("notification", listener);
    }
  }
  // Verify experimental desktop-tool schema against the bundled binary without a turn/LLM call.
  const started = await rpc.call("thread/start", {
    cwd: project,
    ephemeral: false,
    ...threadPolicy("project", project),
    developerInstructions: assistantInstructions("project", process.platform, false, true, project),
    dynamicTools: [desktopTool, browserTool],
  });
  assert.ok(started.thread.id);
  assert.equal(started.sandbox.type, "workspaceWrite");
  assert.equal(started.sandbox.networkAccess, true);
  assert.deepEqual(started.runtimeWorkspaceRoots, [project]);
  // The server reports cwd/runtime roots separately from additional configured roots.
  assert.deepEqual(started.sandbox.writableRoots, []);
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
    cwd: project,
    ...threadPolicy("project", project),
    developerInstructions: assistantInstructions("project", process.platform, true, true, project),
  });
  assert.equal(resumed.thread.id, started.thread.id);
  assert.deepEqual(resumed.sandbox, started.sandbox);
  assert.deepEqual(resumed.runtimeWorkspaceRoots, [project]);
  const command = (operation, target, policy) =>
    rpc.call("command/exec", {
      command: [process.execPath, runner, operation, target],
      cwd: project,
      sandboxPolicy: policy,
      timeoutMs: 15000,
    });
  const writePolicy = turnPolicy("project", project).sandboxPolicy;
  const readPolicy = turnPolicy("read", project).sandboxPolicy;
  const file = join(project, "subpasta", "mais-fundo", "sintético.txt");
  const probe = await command("create", file, writePolicy);
  const kernelUnavailable =
    process.platform === "linux" &&
    probe.exitCode === 1 &&
    /^bwrap: (No permissions to create a new namespace|setting up uid map: Permission denied)/.test(
      probe.stderr,
    );
  if (kernelUnavailable) {
    console.log(
      "Limitação Linux: o kernel desta sandbox bloqueia namespaces do bwrap. Operações nativas de arquivo não homologadas aqui; Windows exige execução completa, sem este desvio, no job Windows installer.",
    );
  } else {
    assert.equal(probe.exitCode, 0, probe.stderr);
    assert.equal(JSON.parse(probe.stdout).content, "arquivo sintético");
    for (const operation of ["edit", "read"]) {
      const result = await command(operation, file, writePolicy);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).content, "arquivo sintético · editado");
    }
    const external = join(neighbor, "preservar.txt");
    await writeFile(external, "arquivo externo preservado");
    const link = join(project, "link-externo");
    await symlink(neighbor, link, process.platform === "win32" ? "junction" : "dir");
    // First prove the runner can start and read under Leitura; startup failure is not denial evidence.
    const read = await command("read", file, readPolicy);
    assert.equal(read.exitCode, 0, read.stderr);
    for (const [target, policy] of [
      [external, writePolicy],
      [`${project}${sep}..${sep}projeto-vizinho${sep}preservar.txt`, writePolicy],
      [join(link, "preservar.txt"), writePolicy],
      [file, readPolicy],
    ]) {
      const result = await command("edit", target, policy);
      assert.equal(result.exitCode, 1, `Escrita indevida no sandbox: ${target}`);
      assert.match(JSON.parse(result.stderr).code, /^(EACCES|EPERM|EROFS)$/);
    }
    assert.equal(await readFile(external, "utf8"), "arquivo externo preservado");
    assert.equal(await readFile(file, "utf8"), "arquivo sintético · editado");
    console.log(
      "Sandbox real: criação/leitura/edição em subpastas OK; escrita externa, travessia, links e Leitura bloqueados.",
    );
  }
  console.log(
    `Codex real: handshake, conta isolada, ${models.data.length} modelos, schemas desktop/browser, instruções e raízes explícitas de start/resume OK. Nenhum turno/LLM executado.`,
  );
} finally {
  await rpc?.shutdown();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

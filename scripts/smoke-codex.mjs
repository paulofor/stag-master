import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, mkdir, cp, writeFile, readFile, symlink } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import imageFixture from "../tests/fixtures/request-image.json" with { type: "json" };
import { startImageProvider } from "../tests/fixtures/image-provider.mjs";
import { gitFixture } from "../tests/fixtures/project-git.mjs";
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/codex-smoke-"));
const project = join(dir, "projeto com espaço-ação");
const neighbor = join(dir, "projeto-vizinho");
let rpc;
let provider;
try {
  await mkdir(join(dir, "home"), { recursive: true });
  await mkdir(project);
  await mkdir(neighbor);
  const runner = join(dir, "workspace-files.mjs");
  await cp("tests/fixtures/workspace-files.mjs", runner);
  const gitStatus = join(dir, "git-status.mjs");
  await cp("tests/fixtures/git-status.mjs", gitStatus);
  await build({
    entryPoints: [
      "src/main/rpc.ts",
      "src/main/desktop-tools.ts",
      "src/main/browser-tools.ts",
      "src/main/policy.ts",
      "src/main/project-git.ts",
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
  const binary = resolve(".local/codex/bin", process.platform === "win32" ? "codex.exe" : "codex");
  const { prepareProjectGit, createGitRunner, projectGitInstructions } = await import(
    pathToFileURL(join(dir, "project-git.mjs")).href
  );
  const gitTest = await gitFixture(dir);
  const nestedRepository = join(project, "frontend");
  for (const repository of [project, nestedRepository, neighbor]) await gitTest.init(repository);
  const gitReport = await prepareProjectGit(project, { run: createGitRunner(gitTest.env) });
  assert.equal(gitReport.verified, 2);
  assert.equal(gitReport.failures, 0);
  const smokeEnvironment = codexEnvironment(join(dir, "home"), gitTest.env);
  const schemas = join(dir, "protocol");
  await promisify(execFile)(
    binary,
    ["app-server", "generate-json-schema", "--experimental", "--out", schemas],
    {
      cwd: project,
      env: smokeEnvironment,
      timeout: 30000,
    },
  );
  const turnSchema = JSON.parse(await readFile(join(schemas, "v2/TurnStartParams.json"), "utf8"));
  const imageShape = turnSchema.definitions.UserInput.oneOf.find((entry) =>
    entry.properties?.type?.enum?.includes("image"),
  );
  assert.ok(
    imageShape?.anyOf?.some(
      (entry) => entry.required?.includes("url") && entry.properties?.url?.type === "string",
    ),
    "O binário fixado deve aceitar input image/url.",
  );
  provider = await startImageProvider();
  rpc = new RpcClient({
    command: binary,
    args: [
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'model_provider="stag_image_fixture"',
      "-c",
      'model_providers.stag_image_fixture.name="STAG synthetic images"',
      "-c",
      `model_providers.stag_image_fixture.base_url=${JSON.stringify(provider.url)}`,
      "-c",
      'model_providers.stag_image_fixture.wire_api="responses"',
      "-c",
      "model_providers.stag_image_fixture.requires_openai_auth=false",
      "-c",
      "model_providers.stag_image_fixture.supports_websockets=false",
      ...(process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : []),
    ],
    cwd: project,
    env: smokeEnvironment,
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
    model: (models.data.find((model) => model.isDefault) || models.data[0]).model,
    ephemeral: false,
    ...threadPolicy("project", project),
    developerInstructions:
      assistantInstructions("project", process.platform, false, true, project) +
      "\n" +
      projectGitInstructions(gitReport),
    dynamicTools: [desktopTool, browserTool],
  });
  assert.ok(started.thread.id);
  assert.equal(started.sandbox.type, "workspaceWrite");
  assert.equal(started.sandbox.networkAccess, true);
  assert.deepEqual(started.runtimeWorkspaceRoots, [project]);
  // The server reports cwd/runtime roots separately from additional configured roots.
  assert.deepEqual(started.sandbox.writableRoots, []);
  // A real user turn is required for UI history; raw injected Responses items aren't UI turns.
  let timer;
  let listener;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Turno sintético de imagem não concluiu.")), 30000);
    listener = (message) => {
      if (message.method === "turn/completed" && message.params.threadId === started.thread.id)
        resolve(message.params.turn);
    };
    rpc.on("notification", listener);
  });
  try {
    await rpc.call("turn/start", {
      threadId: started.thread.id,
      cwd: project,
      input: [
        { type: "text", text: "Analise a imagem sintética do sistema." },
        { type: "image", url: imageFixture.dataUrl },
      ],
      ...turnPolicy("project", project),
    });
    assert.equal((await completed).status, "completed");
  } finally {
    clearTimeout(timer);
    rpc.off("notification", listener);
  }
  const providerImage = provider.inputs
    .flat()
    .flatMap((item) => item.content || [])
    .find((item) => item.type === "input_image");
  assert.equal(
    providerImage?.image_url,
    imageFixture.dataUrl,
    "Pixels precisam chegar ao provedor local pelo Codex real.",
  );
  const resumed = await rpc.call("thread/resume", {
    threadId: started.thread.id,
    cwd: project,
    ...threadPolicy("project", project),
    developerInstructions:
      assistantInstructions("project", process.platform, true, true, project) +
      "\n" +
      projectGitInstructions(gitReport),
  });
  assert.equal(resumed.thread.id, started.thread.id);
  const resumedImage = resumed.thread.turns
    .flatMap((turn) => turn.items)
    .filter((item) => item.type === "userMessage")
    .flatMap((item) => item.content)
    .find((item) => item.type === "image");
  assert.equal(
    resumedImage?.url,
    imageFixture.dataUrl,
    "Retomada real deve preservar os pixels sintéticos.",
  );
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
  const file = join(project, ".stag", "subpasta-sintética", "negocio.md");
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
    for (const repository of [project, nestedRepository, neighbor]) {
      const result = await rpc.call("command/exec", {
        command: [process.execPath, gitStatus, repository, gitTest.executable],
        cwd: project,
        sandboxPolicy: writePolicy,
        timeoutMs: 15000,
      });
      assert.equal(result.exitCode, 0, "O probe Git deve iniciar no sandbox.");
      const status = JSON.parse(result.stdout);
      assert.equal(
        status.launchError,
        null,
        `Falha ao iniciar Git no sandbox: ${status.launchError}`,
      );
      const code = status.code;
      if (repository === neighbor)
        assert.equal(
          status.dubiousOwnership,
          true,
          "Vizinho deve continuar bloqueado por propriedade, não por falha de inicialização.",
        );
      else assert.equal(code, 0, "O sandbox deve reconhecer a confiança cadastrada pelo main.");
    }
    console.log(
      "Git no sandbox real: raiz e subpasta autorizadas; vizinho continua bloqueado por propriedade.",
    );
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
    assert.equal(JSON.parse(read.stdout).content, "arquivo sintético · editado");
    const readOnlyNew = join(project, ".stag", "nao-criar", "sistema.md");
    const createInRead = await command("create", readOnlyNew, readPolicy);
    assert.equal(createInRead.exitCode, 1, "Leitura criou memória indevidamente");
    assert.match(JSON.parse(createInRead.stderr).code, /^(EACCES|EPERM|EROFS)$/);
    await assert.rejects(readFile(readOnlyNew), { code: "ENOENT" });
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
      "Sandbox real: memória .stag em subpastas criada, lida e editada; escrita externa, travessia, links, criação e edição em Leitura bloqueados.",
    );
  }
  console.log(
    `Codex real: handshake, conta isolada, ${models.data.length} modelos, schemas desktop/browser/imagem, pixels no provedor local e histórico, instruções e raízes explícitas de start/resume OK. Resposta determinística em loopback; nenhum LLM real/inferência paga.`,
  );
} finally {
  await rpc?.shutdown();
  await provider?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

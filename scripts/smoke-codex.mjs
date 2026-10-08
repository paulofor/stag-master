import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, rm, mkdir, cp, writeFile, readFile, symlink } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import imageFixture from "../tests/fixtures/request-image.json" with { type: "json" };
import engineeringCorpus from "../tests/fixtures/engineering-scenarios.json" with { type: "json" };
import { startImageProvider } from "../tests/fixtures/image-provider.mjs";
import { gitFixture, verifySandboxGit } from "../tests/fixtures/project-git.mjs";
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
  await build({
    entryPoints: [
      "src/main/rpc.ts",
      "src/main/desktop-tools.ts",
      "src/main/browser-tools.ts",
      "src/main/http-tools.ts",
      "src/main/sql-tools.ts",
      "src/main/database-connections.ts",
      "src/main/policy.ts",
      "src/main/project-git.ts",
      "src/main/project-branches.ts",
      "src/main/project-sources.ts",
      "src/main/request-video.ts",
      "src/main/model-traffic.ts",
    ],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { RpcClient } = await import(pathToFileURL(join(dir, "rpc.mjs")).href);
  const { desktopTool } = await import(pathToFileURL(join(dir, "desktop-tools.mjs")).href);
  const { httpTool } = await import(pathToFileURL(join(dir, "http-tools.mjs")).href);
  const { sqlTool, SqlTools, databaseContext } = await import(
    pathToFileURL(join(dir, "sql-tools.mjs")).href
  );
  const { DatabaseConnections } = await import(
    pathToFileURL(join(dir, "database-connections.mjs")).href
  );
  const { browserTool, browserArguments, browserTabsInstructions } = await import(
    pathToFileURL(join(dir, "browser-tools.mjs")).href
  );
  const { projectSourcesContext } = await import(
    pathToFileURL(join(dir, "project-sources.mjs")).href
  );
  const { videoContext, videoMessage, videoImages } = await import(
    pathToFileURL(join(dir, "request-video.mjs")).href
  );
  const { assistantInstructions, threadPolicy, turnPolicy, codexEnvironment } = await import(
    pathToFileURL(join(dir, "policy.mjs")).href
  );
  const { modelTrafficArguments } = await import(
    pathToFileURL(join(dir, "model-traffic.mjs")).href
  );
  const binary = resolve(".local/codex/bin", process.platform === "win32" ? "codex.exe" : "codex");
  const { prepareProjectGit, createGitRunner, projectGitInstructions } = await import(
    pathToFileURL(join(dir, "project-git.mjs")).href
  );
  const { ProjectBranchManager, projectBranchesInstructions, projectBranchesContext } =
    await import(pathToFileURL(join(dir, "project-branches.mjs")).href);
  const gitTest = await gitFixture(dir);
  const nestedRepository = join(project, "frontend");
  for (const repository of [project, nestedRepository, neighbor]) await gitTest.init(repository);
  const gitReport = await prepareProjectGit(project, { run: createGitRunner(gitTest.env) });
  assert.equal(gitReport.verified, 2);
  assert.equal(gitReport.failures, 0);
  const projectBranches = await new ProjectBranchManager(createGitRunner(gitTest.env)).list(
    project,
  );
  assert.equal(projectBranches.repositories.length, 2);
  assert.ok(
    projectBranches.repositories.every(
      (repository) => repository.current === "main" && !repository.error,
    ),
  );
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
  assert.ok(
    turnSchema.properties.additionalContext,
    "O binário fixado deve aceitar contexto por turno.",
  );
  assert.deepEqual(turnSchema.definitions.AdditionalContextKind.enum, ["untrusted", "application"]);
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
      ...modelTrafficArguments,
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
  const trafficSettings = (await rpc.call("config/read", { includeLayers: false })).config;
  assert.equal(trafficSettings.analytics.enabled, false);
  assert.equal(trafficSettings.feedback.enabled, false);
  for (const key of ["exporter", "trace_exporter", "metrics_exporter"])
    assert.equal(trafficSettings.otel[key], "none");
  assert.equal(trafficSettings.otel.log_user_prompt, false);
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
  const sources = [{ name: "Documentação sintética inicial", url: `${provider.url}/docs-initial` }];
  const started = await rpc.call("thread/start", {
    cwd: project,
    model: (models.data.find((model) => model.isDefault) || models.data[0]).model,
    ephemeral: false,
    ...threadPolicy("project", project),
    developerInstructions:
      assistantInstructions("project", process.platform, false, true, project, sources) +
      "\n" +
      projectGitInstructions(gitReport) +
      "\n" +
      projectBranchesInstructions,
    dynamicTools: [desktopTool, browserTool, httpTool, sqlTool],
  });
  assert.ok(started.thread.id);
  assert.equal(started.sandbox.type, "workspaceWrite");
  assert.equal(started.sandbox.networkAccess, true);
  assert.deepEqual(started.runtimeWorkspaceRoots, [project]);
  // The server reports cwd/runtime roots separately from additional configured roots.
  assert.deepEqual(started.sandbox.writableRoots, []);
  // A real user turn is required for UI history; raw injected Responses items aren't UI turns.
  async function syntheticTurn(input, sourceList = sources, authorized = false, extraContext = {}) {
    let timer;
    let listener;
    const completed = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Turno sintético não concluiu.")), 30000);
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
        input,
        additionalContext: {
          ...projectBranchesContext(projectBranches),
          ...projectSourcesContext(project, sourceList, authorized, true),
          ...extraContext,
        },
        ...turnPolicy("project", project),
      });
      assert.equal((await completed).status, "completed");
    } finally {
      clearTimeout(timer);
      rpc.off("notification", listener);
    }
  }
  await syntheticTurn([
    { type: "text", text: "Analise a imagem sintética do sistema." },
    { type: "image", url: imageFixture.dataUrl },
  ]);
  const sqlSecret = "synthetic-smoke-sql-password";
  const connections = new DatabaseConnections(join(dir, "sql-connections.json"), {
    available: () => false,
    encrypt: () => {
      throw new Error();
    },
    decrypt: () => {
      throw new Error();
    },
  });
  await connections.init();
  await connections.save(
    project,
    connections.snapshot(project).revision,
    null,
    {
      name: "SQL sintético",
      driver: "sqlserver",
      authentication: "sql",
      server: "127.0.0.1",
      endpoint: { kind: "port", port: 1433 },
      database: "stag_synthetic",
      user: "synthetic",
      encrypt: true,
      trustServerCertificate: false,
      certificateHost: "",
      timeoutSeconds: 15,
    },
    sqlSecret,
    false,
  );
  let sqlCalls = 0;
  const sql = new SqlTools(connections, async (_config, password, args) => {
    assert.equal(password, sqlSecret);
    assert.equal(args.parameters[0].value, 10039);
    sqlCalls++;
    return { columns: ["id"], rows: [[10039]], affectedRows: 0, truncated: false };
  });
  const sqlData = { ...connections.snapshot(project), authorized: true };
  const requested = {
    connectionId: sqlData.connections[0].id,
    revision: sqlData.revision,
    operation: "query",
    sql: "SELECT @id AS id",
    parameters: [{ name: "id", type: "int", value: 10039 }],
    risk: "routine",
    intent: "Consultar remessa sintética autorizada",
  };
  const sqlRequest = async (message) => {
    if (message.method !== "item/tool/call" || message.params.tool !== "stag_sql") {
      rpc.rejectRequest(message.id, "Somente a ferramenta SQL sintética está ativa nesta sonda.");
      return;
    }
    const result = await sql.execute(project, message.params.arguments, "project");
    rpc.respond(message.id, result);
  };
  rpc.on("request", sqlRequest);
  try {
    provider.queueToolCall({ name: "stag_sql", arguments: requested });
    await syntheticTurn(
      [{ type: "text", text: "Consulte a remessa sintética usando stag_sql." }],
      sources,
      false,
      databaseContext(sqlData, true),
    );
    assert.equal(
      sqlCalls,
      1,
      "O Codex real deve despachar o schema de produção e receber o resultado SQL.",
    );
    assert.ok(JSON.stringify(provider.inputs.at(-1)).includes("10039"));
    assert.ok(
      !JSON.stringify({ inputs: provider.inputs, instructions: provider.instructions }).includes(
        sqlSecret,
      ),
    );
    console.log(
      "Codex real/provedor loopback: stag_sql parametrizado, contexto vigente e resultado sem senha aprovados.",
    );
  } finally {
    rpc.off("request", sqlRequest);
  }
  const browserRequests = [];
  const browserRequest = async (message) => {
    if (message.method !== "item/tool/call" || message.params.tool !== "stag_browser") {
      rpc.rejectRequest(message.id, "Somente navegador sintético nesta sonda.");
      return;
    }
    const args = browserArguments.parse(message.params.arguments);
    browserRequests.push(args);
    rpc.respond(message.id, {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            tab: args.tab,
            pageId: `synthetic-${args.tab}`,
            text: "Página sintética, sem rede externa.",
          }),
        },
      ],
    });
  };
  rpc.on("request", browserRequest);
  try {
    assert.ok(
      assistantInstructions("project", process.platform, false, true, project, sources).includes(
        browserTabsInstructions,
      ),
    );
    for (const tab of ["documentation", "system"]) {
      provider.queueToolCall({ name: "stag_browser", arguments: { action: "snapshot", tab } });
      await syntheticTurn([{ type: "text", text: `Leia a aba ${tab} sintética.` }], sources, true);
      assert.equal(browserRequests.at(-1).tab, tab);
      assert.ok(JSON.stringify(provider.inputs.at(-1)).includes(`synthetic-${tab}`));
    }
    assert.equal(browserRequests.length, 2);
    console.log(
      "Codex real/provedor loopback: schema de produção com duas abas, despacho e respostas identificadas aprovados.",
    );
  } finally {
    rpc.off("request", browserRequest);
  }
  function verifyTrafficSettings() {
    const traffic = provider.traffic.at(-1);
    assert.ok(traffic.bytes > 0);
    assert.ok(!traffic.reasoning?.summary || traffic.reasoning.summary === "none");
    // Some models do not support a verbosity override; the selected model still comes from model/list.
    if (traffic.text?.verbosity) assert.equal(traffic.text.verbosity, "low");
  }
  verifyTrafficSettings();
  assert.ok(
    JSON.stringify({ inputs: provider.inputs, instructions: provider.instructions }).includes(
      sources[0].url,
    ),
    "Fontes de start devem chegar ao provedor pelo Codex real.",
  );
  function verifyEngineeringContract() {
    const delivered = JSON.stringify({
      input: provider.inputs.at(-1),
      instructions: provider.instructions.at(-1),
    });
    for (const fragment of engineeringCorpus.requiredInstructions)
      assert.ok(
        delivered.includes(fragment),
        `Contrato de engenharia/desenvolvimento local não chegou ao provedor: ${fragment}`,
      );
  }
  verifyEngineeringContract();
  function verifyBranchesContract() {
    const delivered = JSON.stringify({
      input: provider.inputs.at(-1),
      instructions: provider.instructions.at(-1),
    });
    assert.ok(
      delivered.includes(projectBranches.observedAt),
      "Observação das branches deve chegar ao provedor pelo Codex real.",
    );
    assert.ok(
      delivered.includes("Mudanças externas podem tornar a observação obsoleta"),
      "O contrato de branches deve acompanhar retomadas e contexto por turno.",
    );
  }
  verifyBranchesContract();
  const syntheticVideo = {
    summary: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "video-sintetico.mp4",
      seconds: 10,
      frames: 3,
      audio: "transcribed",
    },
    frames: [0, 5, 9].map((seconds) => ({ seconds, image: { dataUrl: imageFixture.dataUrl } })),
    transcript: [{ start: 0, end: 5, text: "Regra sintética: pedidos requerem aprovação." }],
  };
  await syntheticTurn(
    [
      { type: "text", text: videoMessage(syntheticVideo) },
      ...videoImages(syntheticVideo).images.map((image) => ({ type: "image", url: image.dataUrl })),
    ],
    sources,
    false,
    { stag_video: videoContext(syntheticVideo) },
  );
  const videoDelivered = JSON.stringify({
    input: provider.inputs.at(-1),
    instructions: provider.instructions.at(-1),
  });
  assert.ok(videoDelivered.includes(syntheticVideo.transcript[0].text));
  assert.ok(videoDelivered.includes("Só afirme memorização após gravar e reler"));
  assert.ok(videoDelivered.includes(syntheticVideo.summary.id));
  const latestImages = provider.inputs
    .at(-1)
    .filter((item) => item.role === "user")
    .at(-1)
    .content.filter((item) => item.type === "input_image");
  assert.equal(latestImages.length, 1, "Codex real recebe um único quadro idêntico por envio");
  verifyTrafficSettings();
  syntheticVideo.summary.seconds = 601;
  syntheticVideo.summary.segment = { index: 1, total: 3, start: 300, end: 600 };
  syntheticVideo.frames.forEach((frame) => {
    frame.seconds += 300;
  });
  syntheticVideo.transcript[0].start = 300;
  syntheticVideo.transcript[0].end = 305;
  await syntheticTurn(
    [
      { type: "text", text: videoMessage(syntheticVideo) },
      ...videoImages(syntheticVideo).images.map((image) => ({ type: "image", url: image.dataUrl })),
    ],
    sources,
    false,
    { stag_video: videoContext(syntheticVideo) },
  );
  const longDelivered = JSON.stringify({
    input: provider.inputs.at(-1),
    instructions: provider.instructions.at(-1),
  });
  assert.ok(longDelivered.includes("trecho 2/3"));
  assert.ok(longDelivered.includes("identificador estável"));
  const readForRecovery = await rpc.call("thread/read", {
    threadId: started.thread.id,
    includeTurns: true,
  });
  assert.equal(readForRecovery.thread.turns.at(-1).status, "completed");
  assert.ok(
    readForRecovery.thread.turns
      .at(-1)
      .items.some(
        (item) =>
          item.type === "userMessage" &&
          JSON.stringify(item).includes(`Análise STAG ${syntheticVideo.summary.id}`),
      ),
  );
  const paginatedResume = await rpc.call("thread/resume", {
    threadId: started.thread.id,
    excludeTurns: true,
    cwd: project,
    ...threadPolicy("project", project),
    developerInstructions: assistantInstructions(
      "project",
      process.platform,
      false,
      true,
      project,
      sources,
    ),
  });
  assert.deepEqual(paginatedResume.thread.turns, []);
  const pageForRecovery = await rpc.call("thread/turns/list", {
    threadId: started.thread.id,
    limit: 1,
    sortDirection: "desc",
    itemsView: "full",
  });
  assert.equal(pageForRecovery.data.length, 1);
  assert.equal(pageForRecovery.data[0].status, "completed");
  assert.ok(pageForRecovery.nextCursor);
  assert.ok(
    pageForRecovery.data[0].items.some(
      (item) =>
        item.type === "userMessage" &&
        JSON.stringify(item).includes(`Análise STAG ${syntheticVideo.summary.id}`),
    ),
  );
  const providerImage = provider.inputs
    .flat()
    .flatMap((item) => item.content || [])
    .find((item) => item.type === "input_image");
  assert.equal(
    providerImage?.image_url,
    imageFixture.dataUrl,
    "Pixels precisam chegar ao provedor local pelo Codex real.",
  );
  const updatedSources = [
    { name: "Documentação sintética atualizada", url: `${provider.url}/docs-updated` },
  ];
  const resumed = await rpc.call("thread/resume", {
    threadId: started.thread.id,
    cwd: project,
    ...threadPolicy("project", project),
    developerInstructions:
      assistantInstructions("project", process.platform, true, true, project, updatedSources) +
      "\n" +
      projectGitInstructions(gitReport) +
      "\n" +
      projectBranchesInstructions,
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
  await syntheticTurn(
    [{ type: "text", text: "Explique a documentação sintética do projeto." }],
    updatedSources,
    true,
  );
  verifyTrafficSettings();
  assert.ok(
    JSON.stringify({
      input: provider.inputs.at(-1),
      instructions: provider.instructions.at(-1),
    }).includes(updatedSources[0].url),
    "Fontes atualizadas em resume devem chegar ao provedor no próximo turno.",
  );
  verifyEngineeringContract();
  verifyBranchesContract();
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
    await verifySandboxGit(
      rpc,
      gitTest.executable,
      project,
      nestedRepository,
      neighbor,
      writePolicy,
    );
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
    `Codex real: handshake, conta isolada, ${models.data.length} modelos, schemas desktop/browser/imagem/contexto, pixels no provedor local e histórico, fontes vigentes por turno, instruções e raízes explícitas de start/resume OK. Resposta determinística em loopback; nenhum LLM real/inferência paga.`,
  );
} finally {
  await rpc?.shutdown();
  await provider?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { expect } from "@playwright/test";

export async function buildTaskbarHarness(dir) {
  await build({
    entryPoints: [
      "src/main/taskbar-attention.ts",
      "src/main/waiting-sound.ts",
      "src/main/service.ts",
      "src/main/settings.ts",
      "src/main/rpc.ts",
    ],
    outdir: dir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
}

export async function validateWaitingAudio(dir) {
  const { waitingWave } = createRequire(import.meta.url)(join(dir, "waiting-sound.cjs"));
  const path = join(dir, "synthetic-waiting.wav");
  const execute = promisify(execFile);
  const media = join(process.cwd(), ".local/media");
  const suffix = process.platform === "win32" ? ".exe" : "";
  try {
    await writeFile(path, waitingWave());
    const { stdout } = await execute(
      join(media, `ffprobe${suffix}`),
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_name,sample_rate,channels",
        "-of",
        "json",
        path,
      ],
      { timeout: 30000 },
    );
    const info = JSON.parse(stdout);
    assert.equal(Number(info.format.duration), 5);
    assert.deepEqual(info.streams, [
      { codec_name: "pcm_s16le", sample_rate: "22050", channels: 1 },
    ]);
    await execute(join(media, `ffmpeg${suffix}`), ["-v", "error", "-i", path, "-f", "null", "-"], {
      timeout: 30000,
    });
    console.log(
      "Som: PCM sintético de 5 s, mono, decodificado pelos FFprobe/FFmpeg fixados; sem mídia do cliente.",
    );
  } finally {
    await rm(path, { force: true });
  }
}

// Observe and forward the actual native APIs, installed only in the isolated test boot.
export function installTaskbarProbe(BrowserWindow, ChildProcess) {
  global.taskbarCalls = [];
  global.attentionSounds = 0;
  const spawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function (options) {
    if (
      options.file === "powershell.exe" &&
      options.args.some((arg) => /[/\\]waiting-sound\.ps1$/.test(arg))
    )
      global.attentionSounds++;
    return spawn.call(this, options);
  };
  for (const method of ["flashFrame", "setOverlayIcon"]) {
    const original = BrowserWindow.prototype[method];
    if (!original) continue;
    BrowserWindow.prototype[method] = function (...args) {
      global.taskbarCalls.push({
        id: this.id,
        method,
        value: method === "flashFrame" ? args[0] : args[0] !== null,
        description: method === "setOverlayIcon" ? args[1] : "",
      });
      return original.apply(this, args);
    };
  }
}

// This fixture runs on both platforms: the Windows UI smoke intentionally has no account.
// Use the same service-to-controller binding and the actual player, with a separate profile.
export async function validateCompletionPlayer(application, page, options) {
  const before = await page.evaluate(() => window.stag.getSnapshot());
  const result = await application.evaluate(async ({ BrowserWindow }, options) => {
    const { AssistantService, RpcClient, SettingsStore, WaitingSound, path, files } =
      global.CompletionPlayerHarness;
    const { join } = path;
    const { mkdtemp, realpath, rm } = files;
    const folder = await mkdtemp(join(options.directory, "completion-player-"));
    const { TaskbarAttention } = global.TaskbarHarness;
    const target = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let rpc;
    const service = new AssistantService({
      createRpc: () =>
        (rpc = new RpcClient({
          command: options.node,
          args: [options.fixture],
          cwd: folder,
          env: {
            ...process.env,
            CODEX_HOME: join(folder, "home"),
            STAG_FIXTURE_STATE: join(folder, "state.json"),
          },
        })),
      store: new SettingsStore(join(folder, "settings.json")),
      selectProject: async () => realpath(options.project),
      openExternal: async () => {},
      desktop: {
        execute: async () => ({ success: false, contentItems: [] }),
        confirmationReason: async () => null,
      },
    });
    const player = new WaitingSound(options.script);
    const controller = new TaskbarAttention(target, process.platform, player);
    controller.bind(service);
    let completed = 0;
    service.on("workCompleted", () => completed++);
    const waitFor = async (condition) => {
      const deadline = Date.now() + 30000;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error("Aviso de conclusão sintético não chegou.");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    try {
      await service.init();
      await service.request({ type: "connect" });
      await service.request({ type: "login" });
      await waitFor(() => service.snapshot().models.length > 0);
      await service.request({ type: "selectProject" });
      const initialSounds = global.attentionSounds;
      await service.request({ type: "send", text: "conclusão sintética rápida" });
      await waitFor(() => completed === 1);
      await controller.settled();
      const finishedSounds = global.attentionSounds;
      const threadId = service.snapshot().threadId;
      await service.request({ type: "resume", threadId });
      await service.request({ type: "stop" });
      await controller.settled();
      const replayedSounds = global.attentionSounds;
      await service.request({ type: "send", text: "execução sintética lenta lento" });
      await service.request({ type: "stop" });
      await waitFor(() => !service.snapshot().busy);
      await controller.settled();
      const interruptedSounds = global.attentionSounds;
      await service.request({ type: "send", text: "conclusão sintética recuperada rápida" });
      await waitFor(() => completed === 2);
      await controller.settled();
      return {
        initialSounds,
        finishedSounds,
        replayedSounds,
        interruptedSounds,
        finalSounds: global.attentionSounds,
        completed,
        hidden: !target.isVisible(),
      };
    } finally {
      controller.dispose();
      service.dispose();
      await controller.settled();
      await service.mediaSettled();
      await rpc?.shutdown();
      target.destroy();
      await rm(folder, { recursive: true, force: true });
    }
  }, options);
  const plays = process.platform === "win32" ? 1 : 0;
  assert.equal(result.finishedSounds - result.initialSounds, plays);
  assert.equal(result.replayedSounds, result.finishedSounds);
  assert.equal(result.interruptedSounds, result.finishedSounds);
  assert.equal(result.finalSounds - result.initialSounds, plays * 2);
  assert.equal(result.completed, 2);
  assert.equal(result.hidden, true);
  assert.deepEqual(await page.evaluate(() => window.stag.getSnapshot()), before);
  console.log(
    "Conclusão e player de produção: serviço/RPC/vínculo reais, janela oculta, duas conclusões, histórico sem repetição, interrupção e recuperação aprovados.",
  );
}

export async function validateTaskbarAttention(application, page) {
  const before = await page.evaluate(() => window.stag.getSnapshot());
  const result = await application.evaluate(async ({ BrowserWindow }, before) => {
    const { TaskbarAttention, attentionIcon, waitingTitle } = global.TaskbarHarness;
    const icon = attentionIcon();
    const pixels = icon.toBitmap();
    const pixel = (x, y) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    const host = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith("stag://app/"),
    );
    const focusedBefore = host.isFocused();
    const target = new BrowserWindow({
      show: false,
      title: "STAG Plus synthetic attention",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    let soundPlays = 0;
    let soundStops = 0;
    const attention = new TaskbarAttention(target, process.platform, {
      play: () => soundPlays++,
      stop: () => soundStops++,
      settled: async () => {},
    });
    const state = {
      ...before,
      connection: "ready",
      threadId: "synthetic",
      busy: true,
      queuedMessages: [],
      queuePaused: false,
      videoAnalysis: null,
      approvals: [{ id: "q", kind: "questions" }],
    };
    try {
      await target.loadURL("data:text/html,<title>Synthetic page</title><p>Synthetic question</p>");
      attention.update(state);
      const title = target.getTitle();
      const hidden = !target.isVisible();
      attention.update(state);
      attention.update({ ...state, approvals: [{ id: "second", kind: "command" }] });
      const started = global.taskbarCalls.filter((call) => call.id === target.id);
      const soundsStarted = soundPlays;
      attention.update({ ...state, approvals: [] });
      const cleared = target.getTitle();
      attention.update(state);
      const focusedPreserved = host.isFocused() === focusedBefore;
      let nativeFocus = null;
      if (process.platform === "win32") {
        const waitFor = async (condition) => {
          const deadline = Date.now() + 30000;
          while (!condition()) {
            if (Date.now() >= deadline)
              throw new Error("Janela sintética não concluiu foco/minimização.");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
        // These actions simulate the user; the controller never shows/restores/focuses windows.
        target.show();
        target.focus();
        await waitFor(() => target.isFocused());
        target.minimize();
        await waitFor(() => target.isMinimized());
        attention.update(state);
        const minimized = target.isMinimized();
        const minimizedCalls = global.taskbarCalls.filter(
          (call) => call.id === target.id && call.method === "flashFrame",
        );
        target.restore();
        target.focus();
        await waitFor(
          () =>
            target.isFocused() &&
            !target.isMinimized() &&
            global.taskbarCalls
              .filter((call) => call.id === target.id && call.method === "flashFrame")
              .at(-1)?.value === false,
        );
        const focusedCalls = global.taskbarCalls.filter(
          (call) => call.id === target.id && call.method === "flashFrame",
        );
        nativeFocus = {
          minimized,
          flashingMinimized: minimizedCalls.at(-1).value,
          flashingFocused: focusedCalls.at(-1).value,
          title: target.getTitle(),
        };
      }
      const idle = { ...state, busy: false, approvals: [] };
      attention.update(idle);
      attention.completed(state.threadId);
      const soundsCompleted = soundPlays;
      attention.update(idle);
      attention.completed("old-thread");
      const completionTitle = target.getTitle();
      attention.stopSound();
      attention.dispose();
      await attention.settled();
      const calls = global.taskbarCalls.filter((call) => call.id === target.id);
      return {
        size: icon.getSize(),
        corner: pixel(0, 0),
        amber: pixel(3, 8),
        mark: pixel(7, 5),
        title,
        waitingTitle,
        hidden,
        cleared,
        started,
        calls,
        focusedPreserved,
        nativeFocus,
        soundsStarted,
        soundPlays,
        soundStops,
        soundsCompleted,
        completionTitle,
      };
    } finally {
      attention.dispose();
      target.destroy();
    }
  }, before);
  assert.deepEqual(result.size, { width: 16, height: 16 });
  assert.equal(result.corner[3], 0);
  assert.deepEqual(result.amber, [6, 119, 217, 255]);
  assert.deepEqual(result.mark, [255, 255, 255, 255]);
  assert.equal(result.title, result.waitingTitle);
  assert.equal(result.cleared, "STAG Plus");
  assert.ok(result.hidden && result.focusedPreserved, "O aviso não mostra a janela nem toma foco.");
  assert.equal(
    result.started.filter((call) => call.method === "flashFrame" && call.value).length,
    1,
  );
  assert.equal(result.calls.at(-1).value, false);
  if (process.platform === "win32") {
    assert.equal(result.soundsStarted, 1, "Snapshots e várias pendências não repetem áudio.");
    assert.equal(
      result.soundsCompleted,
      3,
      "A conclusão toca o mesmo áudio após os dois períodos de espera.",
    );
    assert.equal(result.soundPlays, 3, "Atualizações e conclusão antiga não repetem áudio.");
    assert.ok(result.soundStops >= 4, "Foco, resolução e encerramento interrompem o áudio.");
    assert.deepEqual(result.nativeFocus, {
      minimized: true,
      flashingMinimized: true,
      flashingFocused: false,
      title: result.waitingTitle,
    });
    assert.equal(
      result.started.filter((call) => call.method === "setOverlayIcon" && call.value).length,
      1,
    );
    assert.equal(result.calls.at(-1).method, "setOverlayIcon");
    assert.equal(result.calls.at(-1).description, "");
  } else assert.equal(result.soundPlays, 0);
  assert.equal(result.completionTitle, "STAG Plus", "Conclusão não indica pergunta pendente.");
  assert.deepEqual(await page.evaluate(() => window.stag.getSnapshot()), before);
  console.log(
    "Barra de tarefas: NativeImage real, APIs de produção, ausência de foco/ativação, espera, som por período, deduplicação, resolução e descarte conferidos.",
  );
}

export async function validateTaskbarService(application, page) {
  const title = () =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().startsWith("stag://app/"))
        .getTitle(),
    );
  const request = (action) => page.evaluate((action) => window.stag.request(action), action);
  await request({ type: "newChat" });
  await request({ type: "send", text: "perguntar sobre stack do projeto sintético" });
  await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
  let snapshot = await page.evaluate(() => window.stag.getSnapshot());
  assert.equal(snapshot.approvals[0].kind, "questions");
  await page.reload();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toBeVisible();
  await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
  await request({ type: "answer", id: snapshot.approvals[0].id, answers: { stack: "TypeScript" } });
  await expect.poll(title).toBe("STAG Plus");
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  await request({ type: "send", text: "perguntar pasta sintética novamente" });
  await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
  snapshot = await page.evaluate(() => window.stag.getSnapshot());
  const threadId = snapshot.threadId;
  const questionId = snapshot.approvals[0].id;
  const card = page.getByRole("region", { name: "Solicitação do assistente" });
  await expect(card).toContainText("Selecione novamente a pasta sintética");
  await page.getByRole("button", { name: "Selecionar pasta do projeto", exact: true }).click();
  snapshot = await page.evaluate(() => window.stag.getSnapshot());
  assert.equal(snapshot.threadId, threadId);
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.approvals[0].id, questionId);
  await page.locator(".project-button").click();
  snapshot = await page.evaluate(() => window.stag.getSnapshot());
  assert.equal(snapshot.threadId, threadId);
  assert.equal(snapshot.approvals[0].id, questionId);
  await page.reload();
  await expect(card).toBeVisible();
  await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
  await card
    .getByLabel("Selecione novamente a pasta sintética no STAG Plus. Avise quando terminar.", {
      exact: true,
    })
    .selectOption("Pasta selecionada novamente");
  await card.getByRole("button", { name: "Responder", exact: true }).click();
  await expect.poll(title).toBe("STAG Plus");
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  for (const accept of [false, true]) {
    await request({ type: "send", text: "aprovar validação sintética do projeto" });
    await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
    snapshot = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(snapshot.approvals[0].kind, "command");
    await request({ type: "answer", id: snapshot.approvals[0].id, accept });
    await expect.poll(title).toBe("STAG Plus");
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
  }
  await request({ type: "send", text: "perguntar sobre stack para parar" });
  await expect.poll(title).toBe("STAG Plus — Aguardando sua resposta");
  await request({ type: "stop" });
  await expect.poll(title).toBe("STAG Plus");
  // The interruption RPC clears the waiting signal before turn/completed arrives.
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  await request({ type: "newChat" });
  await expect.poll(title).toBe("STAG Plus");
  const sounds = () => application.evaluate(() => global.attentionSounds);
  // A barrier lets any cancelled player close before counting the next work period.
  await application.evaluate(() => new Promise((resolve) => setImmediate(resolve)));
  const initialSounds = await sounds();
  await request({ type: "send", text: "trabalho sintético rápido" });
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  if (process.platform === "win32") await expect.poll(sounds).toBe(initialSounds + 1);
  else assert.equal(await sounds(), initialSounds);
  const completedSounds = await sounds();
  const completedThread = (await page.evaluate(() => window.stag.getSnapshot())).threadId;
  await page.reload();
  await request({ type: "resume", threadId: completedThread });
  await request({ type: "stop" });
  assert.equal(
    await sounds(),
    completedSounds,
    "Reload, histórico e parada ociosa não repetem o som.",
  );
  await request({ type: "send", text: "trabalho sintético lento" });
  assert.equal((await page.evaluate(() => window.stag.getSnapshot())).busy, true);
  assert.equal(
    await sounds(),
    completedSounds,
    "Trabalho em andamento não toca aviso de conclusão.",
  );
  await request({ type: "stop" });
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  assert.equal(await sounds(), completedSounds, "Interrupção não anuncia conclusão.");
  await request({ type: "send", text: "trabalho sintético recuperado rápido" });
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  if (process.platform === "win32") await expect.poll(sounds).toBe(completedSounds + 1);
  await request({ type: "newChat" });
  console.log(
    "Avisos ponta a ponta: pergunta, conclusão ociosa, reload, histórico, aprovação, recusa, parada e recuperação com fixture bidirecional OK.",
  );
}

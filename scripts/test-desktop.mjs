import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { _electron, expect } from "@playwright/test";
import { buildBrowserHarness, validateBrowser } from "./test-browser.mjs";
import { validateSavedSession } from "./test-browser-sessions.mjs";
import { startBrowserSite } from "../tests/fixtures/browser-site.mjs";
import engineeringCorpus from "../tests/fixtures/engineering-scenarios.json" with { type: "json" };
import memoryCorpus from "../tests/fixtures/memory-scenarios.json" with { type: "json" };
import sourceCorpus from "../tests/fixtures/source-scenarios.json" with { type: "json" };
import imageFixture from "../tests/fixtures/request-image.json" with { type: "json" };
import appMetadata from "../package.json" with { type: "json" };
import { gitFixture } from "../tests/fixtures/project-git.mjs";
import { validateProjectBranches } from "./test-project-branches.mjs";
import { validateResponseCopy } from "./test-copy.mjs";
import { validateApiConnections } from "./test-apis.mjs";
import { validateDatabaseConnections } from "./test-databases.mjs";
import {
  buildTaskbarHarness,
  validateWaitingAudio,
  installTaskbarProbe,
  validateTaskbarAttention,
  validateTaskbarService,
} from "./test-taskbar-attention.mjs";
import {
  buildDesktopIndicatorHarness,
  validateDesktopIndicator,
} from "./test-desktop-indicator.mjs";

await mkdir(".local/screenshots", { recursive: true });
const dir = await mkdtemp(resolve(".local/desktop-test-"));
const project = join(dir, "projeto-fixture");
const data = join(dir, "data");
let application;
let site;
let backgroundSaved;
let savedDatabases;
let savedApis;
async function stagWindow(application) {
  // Playwright also reports WebContentsView pages as windows. During profile restore,
  // the initial temporary page is replaced; firstWindow() can return that closing page.
  let page;
  await expect
    .poll(
      () => {
        page = application.windows().find((candidate) => candidate.url().startsWith("stag://app/"));
        return !!page;
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await page.waitForLoadState("domcontentloaded");
  return page;
}
try {
  site = await startBrowserSite();
  await buildBrowserHarness(dir);
  await buildDesktopIndicatorHarness(dir);
  await buildTaskbarHarness(dir);
  await validateWaitingAudio(dir);
  const gitTest = await gitFixture(dir);
  const nestedRepository = join(project, "equipe", "frontend ação");
  await gitTest.init(project);
  await gitTest.init(nestedRepository);
  await mkdir(data);
  await cp("dist", join(dir, "dist"), { recursive: true });
  await cp("native", join(dir, "native"), { recursive: true });
  await mkdir(join(dir, ".local"), { recursive: true });
  if (process.platform === "win32")
    await cp(".local/media", join(dir, ".local/media"), { recursive: true });
  else await symlink(resolve(".local/media"), join(dir, ".local/media"), "dir");
  const videoFixture = join(dir, "projeto-sintetico.mp4");
  await promisify(execFile)(
    resolve(".local/media", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=320x180:r=2",
      "-t",
      "2",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      videoFixture,
    ],
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "stag-desktop-test", type: "module", main: "boot.cjs" }),
  );
  await writeFile(
    join(dir, "boot.cjs"),
    `const {app,dialog,BrowserWindow} = require('electron'); global.BrowserHarnessDriver = require('./browser-panel.cjs').BrowserPanel; global.DesktopIndicatorHarness = require('./desktop-indicator.cjs'); global.DesktopDriverHarness = require('./desktop-tools.cjs'); global.TaskbarHarness = require('./taskbar-attention.cjs'); (${installTaskbarProbe.toString()})(BrowserWindow); dialog.showErrorBox = (title,message) => console.error(title + ': ' + message); app.setPath('userData', ${JSON.stringify(data)}); require('./dist/main/index.cjs');`,
  );
  if (process.platform === "win32") {
    // Native Windows validates renderer/preload/IPC and actual server startup, without OAuth.
    await cp(".local/codex", join(dir, ".local/codex"), { recursive: true, dereference: true });
  } else {
    // Exercise the full desktop flow with a process double, outside product code.
    await mkdir(join(dir, ".local/codex/bin"), { recursive: true });
    await cp(
      "tests/fixtures/engineering-scenarios.json",
      join(dir, ".local/codex/bin/engineering-scenarios.json"),
    );
    await cp(
      "tests/fixtures/memory-scenarios.json",
      join(dir, ".local/codex/bin/memory-scenarios.json"),
    );
    await cp(
      "tests/fixtures/source-scenarios.json",
      join(dir, ".local/codex/bin/source-scenarios.json"),
    );
    await writeFile(
      join(dir, ".local/codex/bin/codex"),
      `#!/usr/bin/env node\n${await readFile("tests/fixtures/app-server.mjs", "utf8")}`,
      { mode: 0o755 },
    );
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)|^GIT_/i.test(key) &&
        !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "STAG_DEV_URL"].includes(key),
    ),
  );
  Object.assign(env, {
    HOME: gitTest.home,
    USERPROFILE: gitTest.home,
    XDG_CONFIG_HOME: gitTest.env.XDG_CONFIG_HOME,
  });
  // Reuse the fixture's isolated persistence so reconnect exercises a surviving thread.
  if (process.platform !== "win32") {
    env.STAG_FIXTURE_STATE = join(dir, "app-server-state.json");
    env.STAG_FIXTURE_VIDEO_MODE = "holdAfterFirst";
  }
  application = await _electron.launch({
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
  });
  application.process().on("exit", (code, signal) => {
    console.log(`Electron harness: processo encerrado (código=${code}, sinal=${signal}).`);
  });
  const page = await stagWindow(application);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "Entrar com ChatGPT" })).toBeVisible();
  // ready marks the handshake; Windows still issues account/read after sandbox setup.
  // With this fresh, unauthenticated home: account/read, plus setupStart on Windows.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const state = await window.stag.getSnapshot();
        return { connection: state.connection, requests: state.metrics.requests };
      }),
    )
    .toEqual({ connection: "ready", requests: process.platform === "win32" ? 2 : 1 });
  assert.deepEqual((await page.evaluate(async () => window.stag.getSnapshot())).mouseMovement, {
    enabled: false,
    moves: 0,
    skipped: 0,
    status: "Desligado",
  });
  await expect(
    page.getByRole("button", { name: "Mover mouse a cada 5 min", exact: true }),
  ).toHaveCount(0);
  const movementRejected = await page.evaluate(async () => {
    try {
      await window.stag.request({
        type: "mouseMovement",
        threadId: "synthetic-unavailable",
        enabled: true,
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(movementRejected, true);
  assert.equal(
    (await page.evaluate(async () => window.stag.getSnapshot())).mouseMovement.enabled,
    false,
  );
  const beforeAbout = await page.evaluate(async () => window.stag.getSnapshot());
  const accountMenu = page.getByRole("button", { name: "Conta e conexão", exact: true });
  await accountMenu.click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  const about = page.getByRole("dialog", { name: "Sobre o STAG", exact: true });
  await expect(about).toContainText("Desenvolvido por: Paulo Forestieri");
  await expect(about).toContainText(`Versão ${appMetadata.version}`);
  const closeAbout = about.getByRole("button", { name: "Fechar", exact: true });
  await expect(closeAbout).toBeFocused();
  await closeAbout.press("Tab");
  await expect(closeAbout).toBeFocused();
  await closeAbout.press("Escape");
  await expect(about).toHaveCount(0);
  await expect(accountMenu).toBeFocused();
  assert.deepEqual(await page.evaluate(async () => window.stag.getSnapshot()), beforeAbout);
  await accountMenu.click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  await closeAbout.click();
  await expect(about).toHaveCount(0);
  await application.evaluate(({ dialog, shell }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    global.externalUrls = [];
    shell.openExternal = async (url) => {
      global.externalUrls.push(url);
    };
  }, project);
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByRole("button", { name: "Selecionar projeto", exact: true }).click();
  await expect(page.getByRole("button", { name: "projeto-fixture", exact: true })).toBeVisible();
  await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("project");
  await expect(page.getByLabel("Acesso", { exact: true }).locator("option:checked")).toHaveText(
    "Projeto · leitura e escrita",
  );
  await expect(page.getByRole("region", { name: "Preparação Git", exact: true })).toContainText(
    "Git pronto: 2 repositório(s) verificado(s).",
  );
  const firstGit = await page.evaluate(async () => (await window.stag.getSnapshot()).project.git);
  assert.equal(firstGit.added, 2);
  await page.getByRole("button", { name: "projeto-fixture", exact: true }).click();
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).project.git))
    .toMatchObject({ phase: "complete", added: 0, verified: 2 });
  const repeatedGit = await page.evaluate(
    async () => (await window.stag.getSnapshot()).project.git,
  );
  assert.equal(repeatedGit.added, 0);
  assert.equal(repeatedGit.verified, 2);
  await validateProjectBranches(application, page, project, nestedRepository, gitTest);
  savedDatabases = await validateDatabaseConnections(application, page, project, data, site.url);
  savedApis = await validateApiConnections(application, page, project, data);
  // Real main/preload persistence works without an account or browser consent on both platforms.
  const source = { name: "Documentação sintética", url: site.url };
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  const sourcesDialog = page.getByRole("dialog", { name: "Fontes do projeto", exact: true });
  await sourcesDialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await sourcesDialog.getByLabel("Nome da fonte 1", { exact: true }).fill(source.name);
  await sourcesDialog.getByLabel("URL da fonte 1", { exact: true }).fill(source.url);
  await sourcesDialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(sourcesDialog).toHaveCount(0);
  const savedSources = JSON.parse(await readFile(join(data, "settings.json"), "utf8"));
  assert.deepEqual(savedSources.projectSources[project], [source]);
  assert.equal(
    await page.evaluate(async () => (await window.stag.getSnapshot()).browser.authorized),
    false,
  );
  await page.reload();
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toContainText(
    "1",
  );
  const invalidSource = await page.evaluate(async (projectPath) => {
    try {
      await window.stag.request({
        type: "projectSources",
        projectPath,
        sources: [{ name: "Inerte", url: "file:///C:/docs" }],
      });
      return false;
    } catch {
      return true;
    }
  }, project);
  assert.equal(invalidSource, true);
  for (const repository of [project, nestedRepository])
    assert.equal(
      (
        await gitTest.git(["-C", repository, "status", "--short", "--branch"], {
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "1",
        })
      ).code,
      0,
    );
  const rejected = await page.evaluate(async () => {
    try {
      await window.stag.request({ type: "openLink", url: "javascript:alert(1)" });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true);
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, videoFixture);
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  await expect(page.getByRole("region", { name: "Vídeo da solicitação" })).toContainText(
    "sem fala reconhecida",
    { timeout: 30000 },
  );
  const pendingVideo = await page.evaluate(
    async () => (await window.stag.getSnapshot()).pendingVideo,
  );
  assert.equal(pendingVideo.status, "ready");
  await page.reload();
  await expect(page.getByRole("region", { name: "Vídeo da solicitação" })).toContainText(
    "projeto-sintetico.mp4",
  );
  await page.getByRole("button", { name: "Remover vídeo", exact: true }).click();
  await expect(page.getByRole("region", { name: "Vídeo da solicitação" })).toHaveCount(0);
  const staleVideo = await page.evaluate(async (id) => {
    try {
      await window.stag.request({ type: "send", text: "", videoId: id });
      return false;
    } catch {
      return true;
    }
  }, pendingVideo.summary.id);
  assert.equal(staleVideo, true);
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, project);
  console.log(
    "Vídeo no Electron: seleção nativa, decoder real, reload, remoção e referência antiga recusada OK.",
  );
  await validateResponseCopy(application, page);
  await validateDesktopIndicator(application, page);
  await validateTaskbarAttention(application, page);
  const imageInput = page.getByLabel("Mensagem para o assistente");
  await application.evaluate(async ({ clipboard }) =>
    clipboard.writeText("Tarefa sintética colada"),
  );
  await imageInput.focus();
  await imageInput.press("Control+v");
  await expect(imageInput).toHaveValue("Tarefa sintética colada");
  await expect(page.locator(".composer img")).toHaveCount(0);
  const beforeEditing = await page.evaluate(async () => window.stag.getSnapshot());
  await expect(page.locator(".footer-hint")).toContainText("Enter para nova linha");
  await imageInput.fill("Primeira linha");
  await imageInput.press("Enter");
  await imageInput.pressSequentially("Segunda linha");
  await imageInput.press("Shift+Enter");
  await imageInput.pressSequentially("Terceira linha");
  await expect(imageInput).toHaveValue("Primeira linha\nSegunda linha\nTerceira linha");
  await expect(page.locator(".user-message")).toHaveCount(0);
  const afterEditing = await page.evaluate(async () => window.stag.getSnapshot());
  assert.equal(afterEditing.threadId, beforeEditing.threadId);
  assert.equal(afterEditing.metrics.requests, beforeEditing.metrics.requests);
  assert.equal(afterEditing.busy, false);
  await imageInput.fill("");
  await imageInput.press("Enter");
  await expect(imageInput).toHaveValue("\n");
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  await imageInput.fill("");
  // The real OS clipboard event reaches the sandboxed renderer; no clipboard API is exposed.
  await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, dataUrl) => {
    await clipboard.write([
      new ClipboardItem({
        "image/png": new Blob([nativeImage.createFromDataURL(dataUrl).toPNG()], {
          type: "image/png",
        }),
      }),
    ]);
  }, imageFixture.dataUrl);
  await imageInput.focus();
  await imageInput.press("Control+v");
  await expect(page.locator(".composer img")).toHaveCount(1);
  assert.equal(await page.locator(".composer img").evaluate((img) => img.naturalWidth), 2);
  await imageInput.press("Enter");
  await expect(imageInput).toHaveValue("\n");
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toHaveCount(0);
  await page.getByRole("button", { name: "Remover imagem 1" }).click();
  await expect(page.locator(".composer img")).toHaveCount(0);
  await imageInput.fill("");
  const invalidPixelsRejected = await page.evaluate(async (dataUrl) => {
    const bytes = Uint8Array.from(atob(dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
    // Valid PNG header/dimensions but no IDAT/IEND: the production native decoder must reject it.
    const truncated = `data:image/png;base64,${btoa(String.fromCharCode(...bytes.slice(0, 33)))}`;
    try {
      await window.stag.request({
        type: "send",
        text: "Analise o sistema",
        images: [{ dataUrl: truncated }],
      });
      return false;
    } catch (error) {
      return /Imagem inválida/.test(error.message);
    }
  }, imageFixture.dataUrl);
  assert.equal(invalidPixelsRejected, true);
  // JPEG is checked by both shared validation and the native decoder, before account checks.
  const jpeg = await application.evaluate(
    ({ nativeImage }, dataUrl) =>
      `data:image/jpeg;base64,${nativeImage.createFromDataURL(dataUrl).toJPEG(80).toString("base64")}`,
    imageFixture.dataUrl,
  );
  const jpegValidated = await page.evaluate(async (dataUrl) => {
    try {
      await window.stag.request({ type: "send", text: "Analise o sistema", images: [{ dataUrl }] });
      return false;
    } catch (error) {
      return /Entre com sua conta/.test(error.message);
    }
  }, jpeg);
  assert.equal(jpegValidated, true);
  if (process.platform !== "win32") {
    await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
    await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("fixture-model");
    console.log("Fila real: preload/IPC, aprovação, reload, ordem, pausa e descarte.");
    const queue = page.getByRole("region", { name: "Fila de solicitações" });
    await imageInput.fill("perguntar stack");
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByRole("button", { name: "Responder", exact: true })).toBeVisible();
    await expect(imageInput).toBeFocused();
    await imageInput.fill("primeiro texto rápido");
    await imageInput.press("Enter");
    await imageInput.pressSequentially("continuação da solicitação");
    const firstQueuedText = "primeiro texto rápido\ncontinuação da solicitação";
    await expect(imageInput).toHaveValue(firstQueuedText);
    await expect(queue).toHaveCount(0);
    await expect(page.locator(".user-message")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Responder", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
    await imageInput.fill("segundo texto lento");
    await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
    await expect(queue.locator("li")).toHaveCount(2);
    await page.reload();
    await expect(queue.locator("li")).toHaveCount(2);
    await expect(page.locator(".user-message")).toHaveCount(1);
    await page.getByLabel("Qual stack deseja?", { exact: true }).selectOption("TypeScript");
    await page.getByRole("button", { name: "Responder", exact: true }).click();
    await expect(page.locator(".user-message")).toHaveText([
      "perguntar stack",
      firstQueuedText,
      "segundo texto lento",
    ]);
    assert.deepEqual(
      await page.evaluate(async () =>
        (await window.stag.getSnapshot()).items
          .filter((item) => item.kind === "user")
          .map((item) => item.text),
      ),
      ["perguntar stack", firstQueuedText, "segundo texto lento"],
    );
    await expect(queue).toHaveCount(0);
    await imageInput.fill("descartar esta pendência");
    await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
    await page.getByRole("button", { name: "Parar execução" }).click();
    await expect(queue).toContainText("pausada");
    const queueSettings = await readFile(join(data, "settings.json"), "utf8");
    assert.ok(!queueSettings.includes("descartar esta pendência"));
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await expect(queue).toHaveCount(0);
    await page.getByLabel("Mensagem para o assistente").fill(sourceCorpus.input);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText(sourceCorpus.unauthorized, { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    // Wait for the IPC acknowledgement before paste: run() intentionally clears the old draft.
    await expect(page.getByRole("button", { name: "Nova conversa", exact: true })).toBeEnabled();
    await expect(page.locator(".user-message")).toHaveCount(0);
    await application.evaluate(async ({ clipboard, ClipboardItem, nativeImage }, dataUrl) => {
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([nativeImage.createFromDataURL(dataUrl).toPNG()], {
            type: "image/png",
          }),
        }),
      ]);
    }, imageFixture.dataUrl);
    await imageInput.focus();
    await imageInput.press("Control+v");
    await expect(page.locator(".composer img")).toHaveCount(1);
    const beforeImageEnter = await page.evaluate(async () => window.stag.getSnapshot());
    await imageInput.press("Enter");
    await expect(imageInput).toHaveValue("\n");
    await expect(page.locator(".composer img")).toHaveCount(1);
    await expect(page.locator(".user-message")).toHaveCount(0);
    assert.equal(
      (await page.evaluate(async () => window.stag.getSnapshot())).metrics.requests,
      beforeImageEnter.metrics.requests,
    );
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(
      page.getByText("Recebi 1 imagem(ns) sintética(s).", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".user-message img")).toHaveCount(1);
    await expect(page.locator(".composer img")).toHaveCount(0);
    await expect(imageInput).toBeFocused();
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    const beforeBlocked = await page.evaluate(
      async () => (await window.stag.getSnapshot()).metrics,
    );
    await page.getByLabel("Mensagem para o assistente").fill("Invada o sistema de terceiros");
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.locator(".assistant-message")).toContainText(
      "Solicitação bloqueada por segurança.",
    );
    const blocked = await page.evaluate(async () => window.stag.getSnapshot());
    assert.equal(blocked.threadId, null);
    assert.equal(blocked.busy, false);
    assert.equal(blocked.metrics.requests, beforeBlocked.requests);
    assert.equal(blocked.metrics.failures, beforeBlocked.failures + 1);
    await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    for (const id of [
      "preventive-request",
      "preventive-request-english",
      "unrelated",
      "business",
      "ambiguous-business",
      "mixed",
      "ambiguous-bypass",
      "local-auth",
      "local-database",
      "local-remote-proxy",
      "local-unknown-database",
      "local-untrusted-override",
      "development-menu",
      "development-clarified",
      "development-known-context",
      "development-homologation",
      "development-provisional-full-workflow",
      "development-all-test-companies",
      "development-restore-full-workflow",
      "development-critical-execution",
      "development-conflict",
      "development-tenant-boundary",
      "development-untrusted-override",
    ]) {
      const scenario = engineeringCorpus.scenarios.find((s) => s.id === id);
      if (scenario.context) {
        await page.getByLabel("Mensagem para o assistente").fill(scenario.context);
        await page.getByRole("button", { name: "Enviar mensagem" }).click();
        await expect
          .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
          .toBe(false);
        await page.evaluate(() => window.stag.request({ type: "connect" }));
      }
      await page.getByLabel("Mensagem para o assistente").fill(scenario.input);
      await page.getByRole("button", { name: "Enviar mensagem" }).click();
      await expect(page.getByText(scenario.response, { exact: true })).toBeVisible();
      await expect
        .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
        .toBe(false);
      await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
      const snapshot = await page.evaluate(async () => window.stag.getSnapshot());
      assert.equal(snapshot.items.at(-1).text, scenario.response);
      assert.equal(snapshot.browser.url, "");
      assert.equal(snapshot.metrics.failures, blocked.metrics.failures);
    }
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await page.getByLabel("Mensagem para o assistente").fill(memoryCorpus.record);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText(memoryCorpus.recorded, { exact: true })).toBeVisible();
    assert.match(await readFile(join(project, ".stag/negocio.md"), "utf8"), /15 minutos/);
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await page.getByLabel("Mensagem para o assistente").fill(memoryCorpus.recall);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText(memoryCorpus.initialRecall, { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await page.getByLabel("Acesso", { exact: true }).selectOption("read");
    await page.getByLabel("Mensagem para o assistente").fill(memoryCorpus.correct);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText(memoryCorpus.readOnly, { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    assert.match(await readFile(join(project, ".stag/negocio.md"), "utf8"), /15 minutos/);
    await page.getByLabel("Acesso", { exact: true }).selectOption("project");
    await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
    await page.getByLabel("Mensagem para o assistente").fill("aprovar comando");
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Permitir este comando?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Permitir esta ação" }).click();
    await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    assert.equal(await page.evaluate(() => typeof window.require), "undefined");
    await mkdir(".local/screenshots", { recursive: true });
    await page.screenshot({ path: ".local/screenshots/electron-conversation.png" });
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
    assert.equal(
      await page.evaluate(async () => (await window.stag.getSnapshot()).browser.authorized),
      false,
    );
    await page.getByLabel("Mensagem para o assistente").fill(`abrir aplicação local ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(
      page.getByText("Clique em Autorizar navegador no painel do STAG.", { exact: true }),
    ).toBeVisible();
    assert.equal(
      await page.evaluate(async () => (await window.stag.getSnapshot()).browser.url),
      "",
    );
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
    await page.getByLabel("Mensagem para o assistente").fill(`abrir aplicação local ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(
      page.getByText("Navegador: aplicação local conferida no STAG.", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Endereço do navegador")).toHaveValue(site.url);
    assert.deepEqual(await application.evaluate(() => global.externalUrls), [
      "https://auth.openai.com/fixture-login",
    ]);
    await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await page.getByLabel("Mensagem para o assistente").fill(`navegador fluxo real ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(
      page.getByText("Navegador: campo preenchido pelo modelo.", { exact: true }),
    ).toBeVisible();
    // Final text can arrive before turn/completed and its history refresh. Snapshot comparisons
    // must start after both, otherwise a valid completion looks like a dialog side effect.
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await window.stag.getSnapshot();
          return state.threads.find((entry) => entry.id === state.threadId)?.title;
        }),
      )
      .toBe(`navegador fluxo real ${site.url}`);
    const contentsResult = await application.evaluate(async ({ BrowserWindow }) => {
      const parent = BrowserWindow.getAllWindows()[0];
      const view = parent.contentView.children.find(
        (view) => view.webContents && view.webContents !== parent.webContents,
      );
      return {
        value: await view.webContents.executeJavaScript("document.querySelector('#local').value"),
        visible: view.getVisible(),
        bounds: view.getBounds(),
        screenshot: (await view.webContents.capturePage()).toDataURL(),
      };
    });
    assert.equal(contentsResult.value, "feito pelo modelo");
    assert.equal(contentsResult.visible, true);
    const beforeBrowserAbout = await page.evaluate(async () => window.stag.getSnapshot());
    await page.getByLabel("Mensagem para o assistente").fill("Rascunho sintético\npara depois");
    await accountMenu.click();
    await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
    await expect(about).toBeVisible();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows()[0];
          return parent.contentView.children
            .find((view) => view.webContents && view.webContents !== parent.webContents)
            ?.getVisible();
        }),
      )
      .toBe(false);
    await closeAbout.press("Control+n");
    await closeAbout.click();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows()[0];
          return parent.contentView.children
            .find((view) => view.webContents && view.webContents !== parent.webContents)
            ?.getVisible();
        }),
      )
      .toBe(true);
    assert.deepEqual(
      await page.evaluate(async () => window.stag.getSnapshot()),
      beforeBrowserAbout,
    );
    await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue(
      "Rascunho sintético\npara depois",
    );
    await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
    await expect(sourcesDialog).toBeVisible();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows()[0];
          return parent.contentView.children
            .find((view) => view.webContents && view.webContents !== parent.webContents)
            ?.getVisible();
        }),
      )
      .toBe(false);
    await sourcesDialog.getByRole("button", { name: "Cancelar", exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }) => {
          const parent = BrowserWindow.getAllWindows()[0];
          return parent.contentView.children
            .find((view) => view.webContents && view.webContents !== parent.webContents)
            ?.getVisible();
        }),
      )
      .toBe(true);
    assert.equal(
      await page.evaluate(async () => (await window.stag.getSnapshot()).browser.authorized),
      true,
    );
    const viewport = await page.locator(".browser-viewport").boundingBox();
    assert.ok(Math.abs(contentsResult.bounds.x - viewport.x) <= 1);
    assert.ok(Math.abs(contentsResult.bounds.width - viewport.width) <= 1);
    await writeFile(
      ".local/screenshots/electron-browser-content.png",
      Buffer.from(contentsResult.screenshot.split(",")[1], "base64"),
    );
    await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
    await page.screenshot({ path: ".local/screenshots/electron-browser-panel.png" });
    const input = page.getByLabel("Mensagem para o assistente");
    await input.fill(sourceCorpus.input);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText(sourceCorpus.complete, { exact: true })).toBeVisible();
    await expect(page.getByLabel("Endereço do navegador")).toHaveValue(source.url);
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    const sourceSnapshot = await page.evaluate(async () => window.stag.getSnapshot());
    assert.ok(
      sourceSnapshot.items.filter(
        (item) => item.text === "stag_browser" && item.status === "completed",
      ).length >= 2,
    );
    // Exercise selection through IPC, App Server requests and the production browser driver.
    const comboDom = (code) =>
      application.evaluate(async ({ BrowserWindow }, expression) => {
        const parent = BrowserWindow.getAllWindows()[0];
        const view = parent.contentView.children.find(
          (child) => child.webContents && child.webContents !== parent.webContents,
        );
        return view.webContents.executeJavaScript(expression);
      }, code);
    const comboTask = `navegador combo real ${new URL("combos", site.url).href}`;
    await input.fill(comboTask);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await window.stag.getSnapshot();
          return state.busy
            ? {
                connection: state.connection,
                approvals: state.approvals.map((approval) => approval.kind),
                tools: state.items
                  .filter((item) => item.kind === "tool")
                  .map((item) => item.status),
              }
            : null;
        }),
      )
      .toBeNull();
    assert.equal(await comboDom("document.querySelector('#native').selectedIndex"), 1);
    await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
    const criticalComboTask = comboTask.replace("navegador", "navegador crítico");
    await input.fill(criticalComboTask);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    assert.equal(await comboDom("document.querySelector('#native').selectedIndex"), 0);
    await page.getByRole("button", { name: "Recusar", exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    assert.equal(await comboDom("document.querySelector('#native').selectedIndex"), 0);
    await input.fill(criticalComboTask);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    await comboDom(
      "document.querySelector('#native').options[7].value='SYNTHETIC_CHANGED_AFTER_APPROVAL'",
    );
    await page.getByRole("button", { name: "Permitir esta ação" }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    assert.equal(await comboDom("document.querySelector('#native').selectedIndex"), 0);
    assert.match(
      await page.evaluate(async () => (await window.stag.getSnapshot()).error),
      /alvo mudou/,
    );
    await input.fill(criticalComboTask);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Permitir esta ação" }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    assert.equal(await comboDom("document.querySelector('#native').selectedIndex"), 7);
    assert.doesNotMatch(
      JSON.stringify(await page.evaluate(async () => window.stag.getSnapshot())),
      /SYNTHETIC_INTERNAL|SYNTHETIC_CHANGED_AFTER_APPROVAL/,
    );
    await input.fill(`navegador envio real ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    assert.equal(site.effects.submissions, 0);
    await page.getByRole("button", { name: "Recusar", exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await expect(page.getByText("Navegador: recusado.", { exact: true }).last()).toBeVisible();
    assert.equal(site.effects.submissions, 0);
    await input.fill(`navegador envio real ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Permitir esta ação" }).click();
    await expect.poll(() => site.effects.submissions).toBe(1);
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    await input.fill(`navegador senha real ${site.url}`);
    await page.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Solicitação do assistente" })).not.toContainText(
      "feito pelo modelo",
    );
    await page.getByRole("button", { name: "Recusar", exact: true }).click();
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
    const thread = await page.evaluate(async () => (await window.stag.getSnapshot()).threadId);
    await application.evaluate(({ dialog }) => {
      global.consentWaiting = false;
      dialog.showMessageBox = () =>
        new Promise((resolve) => {
          global.consentWaiting = true;
          global.resolveConsent = resolve;
        });
    });
    const authorization = page
      .evaluate(() => window.stag.request({ type: "browserConsent", allow: true }))
      .then(
        () => null,
        (error) => error,
      );
    await expect.poll(() => application.evaluate(() => global.consentWaiting)).toBe(true);
    await page.evaluate(() => window.stag.request({ type: "newChat" }));
    await application.evaluate(() => global.resolveConsent({ response: 1 }));
    assert.match((await authorization).message, /conversa mudou/);
    assert.notEqual(
      await page.evaluate(async () => (await window.stag.getSnapshot()).threadId),
      thread,
    );
    assert.equal(
      await page.evaluate(async () => (await window.stag.getSnapshot()).browser.authorized),
      false,
    );
  }
  if (process.platform !== "win32") await validateTaskbarService(application, page);
  await validateBrowser(application, dir, site, page);
  // Check the renderer and its actual WebContentsView together with a wide local page.
  const originalSize = await application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0];
    const size = host.getContentSize();
    host.setContentSize(1584, 900);
    return size;
  });
  await page.evaluate(async (url) => {
    await window.stag.request({ type: "browserVisibility", visible: true });
    await window.stag.request({ type: "browserControl", control: { action: "navigate", url } });
  }, new URL("wide", site.url).href);
  await expect(page.getByRole("region", { name: "Navegador do assistente" })).toBeVisible();
  await expect
    .poll(async () => {
      const viewport = await page.locator(".browser-viewport").boundingBox();
      return application.evaluate(({ BrowserWindow }, bounds) => {
        const host = BrowserWindow.getAllWindows()[0];
        const view = host.contentView.children.find(
          (child) => child.webContents && child.webContents !== host.webContents,
        );
        const native = view.getBounds();
        return Math.abs(native.x - bounds.x) <= 1 && Math.abs(native.width - bounds.width) <= 1;
      }, viewport);
    })
    .toBe(true);
  const wideLayout = await application.evaluate(async ({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0];
    const view = host.contentView.children.find(
      (child) => child.webContents && child.webContents !== host.webContents,
    );
    return {
      hostWidth: host.getContentSize()[0],
      browserWidth: view.getBounds().width,
      title: view.webContents.getTitle(),
      fits: await view.webContents.executeJavaScript(
        "document.documentElement.scrollWidth <= document.documentElement.clientWidth",
      ),
      screenshot: (await view.webContents.capturePage()).toDataURL(),
    };
  });
  assert.equal(wideLayout.title, "Página larga sintética");
  assert.ok(wideLayout.browserWidth >= wideLayout.hostWidth * 0.6);
  // Some Windows runners clamp windows to the screen; verify absence of scroll when space permits.
  if (wideLayout.hostWidth >= 1584) assert.equal(wideLayout.fits, true);
  await writeFile(
    ".local/screenshots/electron-browser-wide-content.png",
    Buffer.from(wideLayout.screenshot.split(",")[1], "base64"),
  );
  await page.screenshot({ path: ".local/screenshots/electron-browser-wide.png" });
  await page.getByRole("button", { name: "Fechar navegador" }).click();
  await application.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setContentSize(...size);
  }, originalSize);
  console.log(
    "Browser layout: painel ampliado, bounds nativos sincronizados e página larga sintética conferidos.",
  );
  await validateSavedSession(application, page, site, "prepare");
  if (process.platform !== "win32") {
    const longVideo = join(dir, "reuniao-longa-sintetica.mp4");
    await promisify(execFile)(resolve(".local/media/ffmpeg"), [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=s=64x64:r=2",
      "-t",
      "601",
      "-c:v",
      "libx264",
      "-threads",
      "2",
      longVideo,
    ]);
    await page.evaluate(() => window.stag.request({ type: "newChat" }));
    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, longVideo);
    await page
      .getByLabel("Mensagem para o assistente")
      .fill("Rascunho preservado durante vídeo longo");
    await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
    const activePanel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
    await expect(activePanel).toContainText("Vídeo em processamento");
    await expect(activePanel.locator(".video-analysis-spinner")).toHaveCount(1);
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const state = await window.stag.getSnapshot();
            return { completed: state.videoAnalysis?.completed, busy: state.busy };
          }),
        { timeout: 30000 },
      )
      .toEqual({ completed: 1, busy: true });
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
    await page.getByRole("button", { name: "Parar execução", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => (await window.stag.getSnapshot()).videoAnalysis?.working),
      )
      .toBe(false);
    const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
    await expect(panel).toContainText("1 de 3 trechos");
    await expect(panel).toContainText("Análise pausada");
    await expect(panel.locator(".video-analysis-spinner")).toHaveCount(0);
    await expect(panel).toContainText("Próximo trecho 2 de 3 · 05:00–10:00");
    await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue(
      "Rascunho preservado durante vídeo longo",
    );
    backgroundSaved = await page.evaluate(
      async () => (await window.stag.getSnapshot()).videoAnalysis,
    );
    const checkpoint = JSON.parse(await readFile(join(data, "video-analysis.json"), "utf8"))[0];
    assert.equal(checkpoint.next, 1);
    assert.equal(checkpoint.status, "paused");
    assert.equal(JSON.stringify(checkpoint).includes("data:image"), false);
    assert.equal(JSON.stringify(checkpoint).includes("transcript"), false);
    await page.screenshot({ path: ".local/screenshots/electron-background-video-paused.png" });
    console.log(
      "Vídeo em segundo plano no Electron: diálogo/decoder de produção, processamento minimizado, pausa e checkpoint conferidos.",
    );
  }
  assert.deepEqual(errors, []);
  await application.close();
  if (process.platform !== "win32") env.STAG_FIXTURE_VIDEO_MODE = "normal";
  application = await _electron.launch({
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
  });
  const restartedPage = await stagWindow(application);
  await expect
    .poll(() => restartedPage.evaluate(async () => (await window.stag.getSnapshot()).connection))
    .toBe("ready");
  await expect(
    restartedPage.getByRole("button", { name: "Fontes do projeto", exact: true }),
  ).toContainText("1");
  const restarted = await restartedPage.evaluate(async () => window.stag.getSnapshot());
  assert.deepEqual(restarted.projectSources, [source]);
  assert.deepEqual(restarted.projectDatabases.connections, savedDatabases);
  assert.deepEqual(restarted.projectApis.connections, savedApis);
  assert.equal(restarted.projectApis.authorized, false);
  assert.equal(restarted.browser.authorized, false);
  if (backgroundSaved) {
    assert.equal(restarted.videoAnalysis.id, backgroundSaved.id);
    assert.equal(restarted.videoAnalysis.completed, 1);
    assert.equal(restarted.videoAnalysis.status, "paused");
    assert.equal(restarted.busy, false);
    await expect(
      restartedPage.getByRole("region", { name: "Análise de vídeo em segundo plano" }),
    ).toContainText("Análise pausada");
    await restartedPage.getByRole("button", { name: "Retomar análise", exact: true }).click();
    await expect
      .poll(
        () =>
          restartedPage.evaluate(
            async () => (await window.stag.getSnapshot()).videoAnalysis?.status,
          ),
        { timeout: 30000 },
      )
      .toBe("completed");
    const final = await restartedPage.evaluate(async () => window.stag.getSnapshot());
    assert.equal(final.threadId, backgroundSaved.threadId);
    assert.equal(final.videoAnalysis.completed, 3);
    await expect(
      restartedPage.getByRole("region", { name: "Análise de vídeo em segundo plano" }),
    ).toContainText("Análise concluída");
    const stored = JSON.parse(await readFile(join(data, "video-analysis.json"), "utf8"))[0];
    assert.equal(stored.next, 3);
    assert.equal(stored.pending, null);
    console.log(
      "Vídeo em segundo plano: reinício real, conversa/política originais, retomada do segundo trecho e conclusão confirmados.",
    );
  }
  await validateSavedSession(application, restartedPage, site, "verify");
  await application.close();
  application = await _electron.launch({
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
  });
  const forgottenPage = await stagWindow(application);
  await expect
    .poll(() => forgottenPage.evaluate(async () => (await window.stag.getSnapshot()).connection))
    .toBe("ready");
  await validateSavedSession(application, forgottenPage, site, "forgotten");
  console.log(
    "Fontes do projeto: cadastro IPC, persistência e reinício real OK; consentimento não herdado.",
  );
  console.log(
    process.platform === "win32"
      ? "Electron Windows: janela, protocolo local, preload, IPC, projeto e Codex real OK; OAuth não executado."
      : "Electron local: janela, preload isolado, IPC, login simulado, projeto, conversa e aprovação ponta a ponta OK.",
  );
} finally {
  await application?.close();
  await site?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

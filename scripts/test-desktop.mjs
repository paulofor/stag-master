import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "@playwright/test";
import { buildBrowserHarness, validateBrowser } from "./test-browser.mjs";
import { startBrowserSite } from "../tests/fixtures/browser-site.mjs";
import engineeringCorpus from "../tests/fixtures/engineering-scenarios.json" with { type: "json" };
import memoryCorpus from "../tests/fixtures/memory-scenarios.json" with { type: "json" };
import sourceCorpus from "../tests/fixtures/source-scenarios.json" with { type: "json" };
import imageFixture from "../tests/fixtures/request-image.json" with { type: "json" };
import { gitFixture } from "../tests/fixtures/project-git.mjs";

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/desktop-test-"));
const project = join(dir, "projeto-fixture");
const data = join(dir, "data");
let application;
let site;
try {
  site = await startBrowserSite();
  await buildBrowserHarness(dir);
  const gitTest = await gitFixture(dir);
  const nestedRepository = join(project, "equipe", "frontend ação");
  await gitTest.init(project);
  await gitTest.init(nestedRepository);
  await mkdir(data);
  await cp("dist", join(dir, "dist"), { recursive: true });
  await cp("native", join(dir, "native"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "stag-desktop-test", type: "module", main: "boot.cjs" }),
  );
  await writeFile(
    join(dir, "boot.cjs"),
    `const {app,dialog} = require('electron'); global.BrowserHarnessDriver = require('./browser-panel.cjs').BrowserPanel; dialog.showErrorBox = (title,message) => console.error(title + ': ' + message); app.setPath('userData', ${JSON.stringify(data)}); require('./dist/main/index.cjs');`,
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
  application = await _electron.launch({
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
  });
  application.process().on("exit", (code, signal) => {
    console.log(`Electron harness: processo encerrado (código=${code}, sinal=${signal}).`);
  });
  const page = await application.firstWindow();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("button", { name: "Entrar com ChatGPT" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).connection))
    .toBe("ready");
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
    ]) {
      const scenario = engineeringCorpus.scenarios.find((s) => s.id === id);
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
  await validateBrowser(application, dir, site);
  assert.deepEqual(errors, []);
  await application.close();
  application = await _electron.launch({
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
  });
  const restartedPage = await application.firstWindow();
  await expect
    .poll(() => restartedPage.evaluate(async () => (await window.stag.getSnapshot()).connection))
    .toBe("ready");
  await expect(
    restartedPage.getByRole("button", { name: "Fontes do projeto", exact: true }),
  ).toContainText("1");
  const restarted = await restartedPage.evaluate(async () => window.stag.getSnapshot());
  assert.deepEqual(restarted.projectSources, [source]);
  assert.equal(restarted.browser.authorized, false);
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

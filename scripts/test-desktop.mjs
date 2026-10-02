import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { _electron, expect } from "@playwright/test";
import electron from "electron";

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/desktop-test-"));
const project = join(dir, "projeto-fixture");
const data = join(dir, "data");
let application;
try {
  await mkdir(project);
  await mkdir(data);
  await cp("dist", join(dir, "dist"), { recursive: true });
  await cp("native", join(dir, "native"), { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "stag-desktop-test", type: "module", main: "boot.cjs" }),
  );
  await writeFile(
    join(dir, "boot.cjs"),
    `const {app} = require('electron'); app.setPath('userData', ${JSON.stringify(data)}); require('./dist/main/index.cjs');`,
  );
  if (process.platform === "win32") {
    // Native Windows validates renderer/preload/IPC and actual server startup, without OAuth.
    await cp(".local/codex", join(dir, ".local/codex"), { recursive: true, dereference: true });
  } else {
    // Exercise the full desktop flow with a process double, outside product code.
    await mkdir(join(dir, ".local/codex/bin"), { recursive: true });
    await writeFile(
      join(dir, ".local/codex/bin/codex"),
      `#!/usr/bin/env node\n${await readFile("tests/fixtures/app-server.mjs", "utf8")}`,
      { mode: 0o755 },
    );
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/(TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL)/i.test(key) &&
        !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "STAG_DEV_URL"].includes(key),
    ),
  );
  application = await _electron.launch({
    executablePath: electron,
    args: [dir, ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
    env,
    timeout: 30000,
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
    shell.openExternal = async () => {};
  }, project);
  await page.getByRole("button", { name: "Selecionar projeto", exact: true }).click();
  await expect(page.getByRole("button", { name: "projeto-fixture", exact: true })).toBeVisible();
  const rejected = await page.evaluate(async () => {
    try {
      await window.stag.request({ type: "openLink", url: "javascript:alert(1)" });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(rejected, true);
  if (process.platform !== "win32") {
    await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
    await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("fixture-model");
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
  }
  assert.deepEqual(errors, []);
  console.log(
    process.platform === "win32"
      ? "Electron Windows: janela, protocolo local, preload, IPC, projeto e Codex real OK; OAuth não executado."
      : "Electron local: janela, preload isolado, IPC, login simulado, projeto, conversa e aprovação ponta a ponta OK.",
  );
} finally {
  await application?.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

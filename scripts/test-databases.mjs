import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function validateDatabaseConnections(
  application,
  page,
  project,
  data,
  browserUrl,
  conversationFixture,
) {
  const previousVisibility = await page.evaluate(
    async () => (await window.stag.getSnapshot()).browser.visible,
  );
  const previousBounds = await application.evaluate(({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith("stag://app/"),
    );
    const bounds = host.getBounds();
    host.setContentSize(1200, 900);
    return bounds;
  });
  await page.evaluate(async (url) => {
    await window.stag.request({ type: "browserVisibility", visible: true });
    await window.stag.request({ type: "browserControl", control: { action: "navigate", url } });
  }, browserUrl);
  const browserBounds = () =>
    application.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith("stag://app/"),
      );
      return host.contentView.children
        .filter((view) => view.webContents && view.webContents !== host.webContents)
        .map((view) => ({ ...view.getBounds(), visible: view.getVisible() }));
    });
  await expect
    .poll(async () => (await browserBounds()).some((view) => view.visible && view.width > 0))
    .toBe(true);
  const input = page.getByLabel("Mensagem para o assistente", { exact: true });
  await input.fill("rascunho sintético da conexão");
  await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Conexões com banco de dados", exact: true });
  await expect.poll(async () => (await browserBounds()).every((view) => !view.visible)).toBe(true);
  await dialog.getByLabel("Nome da conexão", { exact: true }).fill("SQL Server sintético");
  await dialog.getByLabel("Servidor", { exact: true }).fill("localhost");
  await dialog.getByLabel("Banco de dados", { exact: true }).fill("stag_fixture");
  await dialog.getByLabel("Usuário", { exact: true }).fill("fixture-user");
  const password = " synthetic password only ! ";
  await dialog.getByLabel("Senha do usuário", { exact: true }).fill(password);
  const before = await page.evaluate(async () => window.stag.getSnapshot());
  const protectedStorage = before.projectDatabases.canRememberPassword;
  if (process.platform === "win32")
    assert.equal(protectedStorage, true, "Windows must exercise real DPAPI");
  const remember = dialog.getByLabel("Lembrar senha neste computador", { exact: true });
  if (protectedStorage) await remember.check();
  else await expect(remember).toBeDisabled();
  const file = join(data, "database-connections.json");
  await mkdir(file + ".tmp");
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("preservados");
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue(password);
  await rm(file + ".tmp", { recursive: true });
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await browserBounds()).some((view) => view.visible && view.width > 0))
    .toBe(true);
  await expect(input).toHaveValue("rascunho sintético da conexão");
  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(JSON.stringify(persisted).includes(password), false);
  const state = await page.evaluate(async () => window.stag.getSnapshot());
  assert.equal(state.projectDatabases.connections[0].passwordSaved, protectedStorage);
  assert.equal(state.projectDatabases.connections[0].passwordAvailable, true);
  assert.equal(JSON.stringify(state).includes(password), false);
  assert.equal(JSON.stringify(state).includes("encryptedPassword"), false);
  assert.equal(state.metrics.requests, before.metrics.requests);
  if (protectedStorage) {
    const encrypted = persisted.projects[project][0].encryptedPassword;
    const decoded = await application.evaluate(
      ({ safeStorage }, { encrypted, password }) => {
        const secret = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64")));
        return {
          available: safeStorage.isEncryptionAvailable(),
          matches: secret.password === password,
        };
      },
      { encrypted, password },
    );
    assert.deepEqual(decoded, { available: true, matches: true });
  }
  await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
  await expect(
    dialog.getByLabel("Conexão salva", { exact: true }).locator("option:checked"),
  ).toHaveText("SQL Server sintético");
  await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue(
    "SQL Server sintético",
  );
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue("");
  await page.reload();
  await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
  await dialog
    .getByLabel("Conexão salva", { exact: true })
    .selectOption({ label: "SQL Server sintético" });
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue("");
  // Exercise the production native consent gate, including cancellation, reload and revocation.
  await application.evaluate(({ dialog }) => {
    global.databasePreviousDialog = dialog.showMessageBox;
    global.databaseConsentResponse = 0;
    dialog.showMessageBox = async (...args) =>
      args.some((arg) => arg?.title === "Autorizar bancos")
        ? { response: global.databaseConsentResponse }
        : global.databasePreviousDialog(...args);
  });
  try {
    await dialog
      .getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true })
      .click();
    assert.equal(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.authorized,
      false,
    );
    await application.evaluate(() => {
      global.databaseConsentResponse = 1;
    });
    await dialog
      .getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true })
      .click();
    await expect(dialog.getByRole("button", { name: "Revogar bancos", exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Revogar bancos", exact: true })).toBeVisible();
    if (conversationFixture) {
      await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
      // Login belongs only to the deterministic process double. Windows launches
      // the real Codex with an empty home and must never attempt real OAuth here.
      await page.evaluate(() => window.stag.request({ type: "login" }));
      await expect
        .poll(() =>
          page.evaluate(() => window.stag.getSnapshot().then((s) => !!s.account && !!s.model)),
        )
        .toBe(true);
      await writeFile(
        join(project, "application-import.properties"),
        "spring.datasource.url=jdbc:sqlserver://localhost;databaseName=imported_fixture\nspring.datasource.username=fixture\nspring.datasource.password=synthetic-electron-import-secret\n",
      );
      await page.evaluate(() =>
        window.stag.request({
          type: "send",
          text: 'database import fixture {"args":{"sourcePath":"application-import.properties"}}',
        }),
      );
      await expect(page.getByText("Importar conexão do projeto", { exact: true })).toBeVisible();
      assert.equal((await page.evaluate(() => window.stag.getSnapshot())).busy, true);
      await page.getByRole("button", { name: "Recusar", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.stag.getSnapshot().then((s) => s.busy)))
        .toBe(false);
      await page.evaluate(() =>
        window.stag.request({
          type: "send",
          text: 'database import fixture {"args":{"sourcePath":"application-import.properties"}}',
        }),
      );
      await expect(page.getByText("Importar conexão do projeto", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Permitir esta ação", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => window.stag.getSnapshot().then((s) => s.busy)))
        .toBe(false);
      const imported = await page.evaluate(() => window.stag.getSnapshot());
      assert.equal(imported.projectDatabases.connections.length, 2);
      assert.equal(imported.projectDatabases.authorized, false);
      assert.equal(JSON.stringify(imported).includes("synthetic-electron-import-secret"), false);
      const importedProfile = imported.projectDatabases.connections.find(
        (entry) => entry.config.database === "imported_fixture",
      );
      assert.equal(importedProfile.passwordAvailable, true);
      await page.evaluate(async (entry) => {
        const state = await window.stag.getSnapshot();
        await window.stag.request({
          type: "deleteDatabase",
          projectPath: state.project.path,
          revision: state.projectDatabases.revision,
          connectionId: entry.id,
        });
        const next = await window.stag.getSnapshot();
        await window.stag.request({
          type: "databaseConsent",
          projectPath: next.project.path,
          revision: next.projectDatabases.revision,
          allow: true,
        });
      }, importedProfile);
      await rm(join(project, "application-import.properties"));
      // Await turn/start's response before interruption; busy alone is not a handshake.
      await page.evaluate(() => window.stag.request({ type: "send", text: "perguntar stack" }));
      assert.equal((await page.evaluate(() => window.stag.getSnapshot())).busy, true);
      await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
      await expect(
        dialog.getByRole("button", { name: "Salvar conexão", exact: true }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole("button", { name: "Testar conexão", exact: true }),
      ).toBeDisabled();
    }
    await dialog.getByRole("button", { name: "Revogar bancos", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.stag.getSnapshot().then((s) => s.busy)))
      .toBe(false);
    assert.equal(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.authorized,
      false,
    );
    if (conversationFixture) await page.evaluate(() => window.stag.request({ type: "logout" }));
    await dialog
      .getByLabel("Conexão salva", { exact: true })
      .selectOption({ label: "SQL Server sintético" });
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = global.databasePreviousDialog;
    });
  }
  const wrongProject = await page.evaluate(async () => {
    const state = await window.stag.getSnapshot();
    try {
      await window.stag.request({
        type: "deleteDatabase",
        projectPath: state.project.path + "-neighbor",
        revision: state.projectDatabases.revision,
        connectionId: state.projectDatabases.connections[0].id,
      });
    } catch (error) {
      return error.message;
    }
  });
  assert.match(wrongProject, /projeto mudou/i);
  const probeBaseline = await page.evaluate(() => window.stag.getSnapshot());
  // The production driver sends PRELOGIN to a loopback TCP double; cancel only after that handshake.
  let accept;
  const handshake = new Promise((resolve) => {
    accept = resolve;
  });
  const sockets = new Set();
  let respond = false;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("data", () => {
      accept();
      if (respond) socket.end();
    });
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await dialog.getByLabel("Servidor", { exact: true }).fill("127.0.0.1");
    await dialog.getByLabel("Porta", { exact: true }).fill(String(server.address().port));
    await dialog.getByLabel("Senha do usuário", { exact: true }).fill(password);
    await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
    await handshake;
    await expect(dialog.getByRole("button", { name: "Cancelar teste", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar teste", exact: true }).click();
    await expect(dialog.getByRole("status")).toContainText("cancelado");
    await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue(password);
    respond = true;
    await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("Não foi possível conectar");
    const after = await page.evaluate(async () => window.stag.getSnapshot());
    assert.equal(JSON.stringify(after).includes(password), false);
    assert.equal(after.metrics.requests, probeBaseline.metrics.requests);
    assert.equal(after.metrics.totalTokens, probeBaseline.metrics.totalTokens);
    await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  await input.fill("");
  await page.evaluate(
    (visible) => window.stag.request({ type: "browserVisibility", visible }),
    previousVisibility,
  );
  await application.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().startsWith("stag://app/"))
      .setBounds(bounds);
  }, previousBounds);
  console.log(
    `Conexões SQL Server no Electron: IPC/formulário, persistência ${protectedStorage ? "protegida pelo sistema" : "sem senha (backend indisponível)"}, reload, isolamento, cancelamento/limpeza e recuperação aprovados.`,
  );
  return state.projectDatabases.connections;
}

export async function validateDatabaseRecovery(application, page, project, data) {
  const moved = join(project, "pasta-recriada");
  await mkdir(moved, { recursive: true });
  const before = await page.evaluate(() => window.stag.getSnapshot());
  await application.evaluate(({ dialog }, path) => {
    global.recoveryOpenDialog = dialog.showOpenDialog;
    global.recoveryMessageDialog = dialog.showMessageBox;
    global.recoveryResponse = 0;
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async (...args) => {
      const box = args.find((arg) => arg?.title === "Recuperar conexões");
      if (!box) return global.recoveryMessageDialog(...args);
      global.recoveryBox = box;
      return { response: global.recoveryResponse };
    };
  }, moved);
  try {
    await page.evaluate(() => window.stag.request({ type: "selectProject" }));
    let next = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(next.projectDatabases.connections.length, 0);
    const source = next.projectDatabases.recoverySources.find((entry) => entry.path === project);
    assert.ok(source);
    const recover = {
      type: "recoverDatabases",
      projectPath: moved,
      revision: next.projectDatabases.revision,
      sourceId: source.id,
      sourceRevision: source.revision,
    };
    await page.evaluate((action) => window.stag.request(action), recover);
    assert.equal(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.connections.length,
      0,
    );
    const box = await application.evaluate(() => global.recoveryBox);
    assert.ok(box.detail.includes(project) && box.detail.includes(moved));
    await application.evaluate(() => {
      global.recoveryResponse = 1;
    });
    await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Conexões com banco de dados", exact: true });
    await form.getByText("Recuperar conexões de outra pasta", { exact: true }).click();
    await form.getByLabel("Pasta de origem", { exact: true }).selectOption(source.id);
    await form.getByRole("button", { name: "Recuperar conexões", exact: true }).click();
    await expect(form.getByLabel("Nome da conexão", { exact: true })).toHaveValue(
      before.projectDatabases.connections[0].config.name,
    );
    await form.getByRole("button", { name: "Fechar conexões", exact: true }).click();
    next = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(
      next.projectDatabases.connections.length,
      before.projectDatabases.connections.length,
    );
    assert.equal(next.projectDatabases.authorized, false);
    const persisted = JSON.parse(await readFile(join(data, "database-connections.json"), "utf8"));
    assert.equal(persisted.projects[project].length, before.projectDatabases.connections.length);
    if (process.platform === "win32") {
      const secret = await application.evaluate(
        ({ safeStorage }, value) =>
          JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))),
        persisted.projects[moved][0].encryptedPassword,
      );
      assert.equal(secret.project, moved);
      assert.equal(secret.password, " synthetic password only ! ");
    }
    await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
    await expect(form.getByLabel("Nome da conexão", { exact: true })).toHaveValue(
      before.projectDatabases.connections[0].config.name,
    );
    await form.getByRole("button", { name: "Fechar conexões", exact: true }).click();
    await page.evaluate(() => window.stag.request({ type: "selectProject" }));
    assert.deepEqual(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.connections,
      next.projectDatabases.connections,
    );
    console.log(
      "Electron: recuperação nativa recusada/aprovada, origem preservada, novo vínculo protegido e reseleção sem perda aprovados.",
    );
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = global.recoveryOpenDialog;
      dialog.showMessageBox = global.recoveryMessageDialog;
    });
  }
}

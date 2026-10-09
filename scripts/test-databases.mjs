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
  await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue(
    "SQL Server sintético",
  );
  await expect(dialog).toContainText(project);
  await expect(dialog).toContainText("1 conexão(ões) salva(s)");
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
  // Reselecting the exact root must preserve the saved profiles, independently of threads.
  const movedProject = join(project, "recovery-workspace");
  await mkdir(movedProject, { recursive: true });
  await application.evaluate(({ dialog }, project) => {
    global.previousDatabaseOpenDialog = dialog.showOpenDialog;
    global.previousDatabaseRestoreDialog = dialog.showMessageBox;
    global.databaseSelectedProject = project;
    global.databaseRestoreResponse = 0;
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [global.databaseSelectedProject],
    });
    dialog.showMessageBox = async (...args) => {
      const options = args.find((arg) => arg?.title === "Recuperar conexões");
      if (!options) return global.previousDatabaseRestoreDialog(...args);
      global.databaseRestoreDetail = options.detail;
      return { response: global.databaseRestoreResponse };
    };
  }, project);
  try {
    await page.evaluate(() => window.stag.request({ type: "selectProject" }));
    assert.deepEqual(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.connections,
      state.projectDatabases.connections,
    );
    await application.evaluate((_electron, path) => {
      global.databaseSelectedProject = path;
    }, movedProject);
    await page.evaluate(() => window.stag.request({ type: "selectProject" }));
    const moved = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(moved.projectDatabases.connections.length, 0);
    const source = moved.projectDatabases.recoverySources.find(
      (entry) => entry.projectPath === project,
    );
    assert.ok(source);
    for (const response of [0, 1]) {
      await application.evaluate((_electron, value) => {
        global.databaseRestoreResponse = value;
      }, response);
      await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
      await dialog.getByText("Recuperar conexões de outra pasta", { exact: true }).click();
      await dialog
        .getByLabel("Pasta do cadastro anterior", { exact: true })
        .selectOption(source.id);
      await dialog.getByRole("button", { name: "Recuperar conexões", exact: true }).click();
      await expect(dialog).toBeVisible();
      const next = await page.evaluate(() => window.stag.getSnapshot());
      assert.equal(next.projectDatabases.connections.length, response);
      assert.equal(next.projectDatabases.authorized, false);
      if (response)
        await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue(
          "SQL Server sintético",
        );
      await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
    }
    assert.ok(
      (await application.evaluate(() => global.databaseRestoreDetail)).includes(movedProject),
    );
    const recovered = (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases
      .connections[0];
    assert.equal(recovered.passwordAvailable, true);
    assert.equal(recovered.passwordSaved, protectedStorage);
    await application.evaluate((_electron, path) => {
      global.databaseSelectedProject = path;
    }, project);
    await page.evaluate(() => window.stag.request({ type: "selectProject" }));
    assert.deepEqual(
      (await page.evaluate(() => window.stag.getSnapshot())).projectDatabases.connections,
      state.projectDatabases.connections,
    );
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = global.previousDatabaseOpenDialog;
      dialog.showMessageBox = global.previousDatabaseRestoreDialog;
    });
  }
  if (conversationFixture) {
    const sourcePath = join(project, "application-stag-test.properties");
    await writeFile(
      sourcePath,
      `spring.datasource.url=jdbc:sqlserver://localhost;databaseName=stag_import_fixture;encrypt=true\nspring.datasource.username=fixture\nspring.datasource.password=${password.trim()}\n`,
    );
    await page.evaluate(() => window.stag.request({ type: "login" }));
    await expect
      .poll(() =>
        page.evaluate(() => window.stag.getSnapshot().then((s) => !!s.account && !!s.model)),
      )
      .toBe(true);
    await page.evaluate(
      (rememberPassword) =>
        window.stag.request({
          type: "send",
          text:
            "database import fixture " +
            JSON.stringify({
              args: {
                file: "application-stag-test.properties",
                name: "Importada Electron",
                rememberPassword,
              },
              duplicate: true,
            }),
        }),
      protectedStorage,
    );
    await expect
      .poll(() => page.evaluate(() => window.stag.getSnapshot().then((s) => s.approvals.length)))
      .toBe(1);
    const pendingImport = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(pendingImport.approvals[0].title, "Importar conexão SQL Server");
    assert.ok(pendingImport.approvals[0].detail.includes("stag_import_fixture"));
    assert.equal(JSON.stringify(pendingImport).includes(password.trim()), false);
    await page.evaluate(
      (id) => window.stag.request({ type: "answer", id, accept: true }),
      pendingImport.approvals[0].id,
    );
    await expect
      .poll(() => page.evaluate(() => window.stag.getSnapshot().then((s) => s.busy)))
      .toBe(false);
    const importedState = await page.evaluate(() => window.stag.getSnapshot());
    const imported = importedState.projectDatabases.connections.find(
      (entry) => entry.config.name === "Importada Electron",
    );
    assert.ok(imported?.passwordAvailable);
    assert.equal(imported.passwordSaved, protectedStorage);
    assert.equal(importedState.projectDatabases.authorized, false);
    assert.equal(JSON.stringify(importedState).includes(password.trim()), false);
    await page.evaluate(
      ({ projectPath, revision, connectionId }) =>
        window.stag.request({ type: "deleteDatabase", projectPath, revision, connectionId }),
      {
        projectPath: project,
        revision: importedState.projectDatabases.revision,
        connectionId: imported.id,
      },
    );
    await page.evaluate(() => window.stag.request({ type: "logout" }));
    await rm(sourcePath);
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

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { apiProvider } from "../tests/fixtures/api-provider.mjs";

export async function validateApiConnections(application, page, project, data) {
  const provider = await apiProvider();
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const callbackPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await application.evaluate(({ shell, dialog }) => {
    global.apiPreviousOpen = shell.openExternal;
    global.apiPreviousDialog = dialog.showMessageBox;
    global.apiConsentResponse = 0;
    dialog.showMessageBox = async () => ({ response: global.apiConsentResponse });
  });
  try {
    const open = page.getByRole("button", { name: "APIs HTTP e HTTPS", exact: true });
    const draft = page.getByLabel("Mensagem para o assistente", { exact: true });
    await draft.fill("rascunho sintético APIs");
    await open.click();
    const dialog = page.getByRole("dialog", { name: "APIs HTTP e HTTPS", exact: true });
    const bounds = () =>
      application.evaluate(({ BrowserWindow }) => {
        const host = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().startsWith("stag://app/"),
        );
        return host.contentView.children
          .filter((view) => view.webContents && view.webContents !== host.webContents)
          .every((view) => !view.getVisible());
      });
    await expect.poll(bounds).toBe(true);
    await dialog.getByLabel("Nome da API", { exact: true }).fill("Bearer sintético");
    await dialog.getByLabel("URL base", { exact: true }).fill(provider.url + "/v1/");
    await dialog.getByText("Segurança e prazo", { exact: true }).click();
    await dialog.getByLabel("Permitir HTTP sem criptografia nesta conexão").check();
    const secret = "synthetic-native-api-secret";
    await dialog.getByLabel("Token da API", { exact: true }).fill(secret);
    const before = await page.evaluate(() => window.stag.getSnapshot());
    const protectedStorage = before.projectApis.canRemember;
    if (process.platform === "win32")
      assert.equal(protectedStorage, true, "Windows must exercise real safeStorage/DPAPI");
    if (protectedStorage) await dialog.getByLabel("Lembrar credenciais neste computador").check();
    else await expect(dialog.getByLabel("Lembrar credenciais neste computador")).toBeDisabled();
    const file = join(data, "api-connections.json");
    await mkdir(file + ".tmp");
    await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("preservados");
    await expect(dialog.getByLabel("Token da API", { exact: true })).toHaveValue(secret);
    await rm(file + ".tmp", { recursive: true });
    await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
    await expect(dialog.getByLabel("API cadastrada")).not.toHaveValue("");
    await expect(dialog.getByLabel("Token da API", { exact: true })).toHaveValue("");
    const stored = JSON.parse(await readFile(file, "utf8"));
    assert.equal(JSON.stringify(stored).includes(secret), false);
    if (protectedStorage) {
      assert.equal(
        await application.evaluate(
          ({ safeStorage }, { encrypted, expected }) =>
            JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, "base64"))).secrets
              .credential === expected,
          { encrypted: stored.projects[project][0].encryptedSecrets, expected: secret },
        ),
        true,
      );
    }
    await dialog
      .getByRole("button", { name: "Autorizar APIs nesta conversa", exact: true })
      .click();
    assert.equal(
      (await page.evaluate(() => window.stag.getSnapshot())).projectApis.authorized,
      false,
    );
    await application.evaluate(() => {
      global.apiConsentResponse = 1;
    });
    await dialog
      .getByRole("button", { name: "Autorizar APIs nesta conversa", exact: true })
      .click();
    await expect(dialog.getByRole("button", { name: "Revogar APIs", exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Revogar APIs", exact: true }).click();
    await dialog.getByRole("button", { name: "Fechar APIs", exact: true }).click();
    await expect(draft).toHaveValue("rascunho sintético APIs");
    await page.reload();
    await open.click();
    await dialog.getByLabel("API cadastrada").selectOption({ label: "Bearer sintético" });
    await expect(dialog.getByLabel("Token da API", { exact: true })).toHaveValue("");
    const stale = await page.evaluate(async () => {
      const snapshot = await window.stag.getSnapshot();
      try {
        await window.stag.request({
          type: "deleteApi",
          projectPath: snapshot.project.path + "-neighbor",
          revision: snapshot.projectApis.revision,
          connectionId: snapshot.projectApis.connections[0].id,
        });
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(stale, true);
    await dialog.getByRole("button", { name: "Nova API", exact: true }).click();
    await dialog.getByLabel("Nome da API", { exact: true }).fill("OAuth sintético");
    await dialog.getByLabel("URL base", { exact: true }).fill(provider.url + "/v1/");
    await dialog.getByLabel("Autenticação", { exact: true }).selectOption("oauth2");
    await dialog.getByLabel("URL de autorização").fill(provider.url + "/authorize");
    await dialog.getByLabel("URL do token").fill(provider.url + "/token");
    await dialog.getByLabel("Client ID", { exact: true }).fill("synthetic-native-client");
    await dialog.getByLabel("Porta do retorno OAuth2").fill(String(callbackPort));
    const security = dialog.locator("details");
    if (!(await security.evaluate((element) => element.open)))
      await security.locator("summary").click();
    await dialog.getByLabel("Permitir HTTP sem criptografia nesta conexão").check();
    if (protectedStorage) await dialog.getByLabel("Lembrar credenciais neste computador").check();
    await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: "Entrar com OAuth2", exact: true }),
    ).toBeEnabled();
    await application.evaluate(({ shell }, base) => {
      global.apiLoginOpened = false;
      shell.openExternal = async (url) => {
        if (!url.startsWith(base + "/authorize?"))
          throw new Error("Synthetic loopback provider only");
        global.apiLoginOpened = true;
        const response = await fetch(url, { redirect: "manual" });
        const callback = new URL(response.headers.get("location"));
        if (callback.hostname !== "127.0.0.1") throw new Error("Synthetic loopback callback only");
        await fetch(callback);
      };
    }, provider.url);
    await dialog.getByRole("button", { name: "Entrar com OAuth2", exact: true }).click();
    await expect(dialog).toContainText("API autenticada.");
    assert.equal(provider.state.tokens, 1);
    const snapshot = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(JSON.stringify(snapshot).includes("synthetic-access"), false);
    assert.equal(JSON.stringify(snapshot).includes("encryptedSecrets"), false);
    assert.equal(snapshot.projectApis.authorized, false);
    assert.equal(snapshot.metrics.requests, before.metrics.requests);
    const persisted = await readFile(file, "utf8");
    assert.equal(persisted.includes("synthetic-access"), false);
    assert.equal(persisted.includes("synthetic-refresh"), false);
    // A second login waits for a browser callback. Cancel only after the listener opened.
    await application.evaluate(({ shell }) => {
      global.apiLoginOpened = false;
      shell.openExternal = async () => {
        global.apiLoginOpened = true;
      };
    });
    await dialog.getByRole("button", { name: "Entrar com OAuth2", exact: true }).click();
    await expect.poll(() => application.evaluate(() => global.apiLoginOpened)).toBe(true);
    await dialog.getByRole("button", { name: "Cancelar login", exact: true }).click();
    await expect(dialog).toContainText("Login da API cancelado.");
    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(callbackPort, "127.0.0.1", resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
    await dialog.getByRole("button", { name: "Fechar APIs", exact: true }).click();
    await draft.fill("");
    console.log(
      `APIs no Electron: cadastro/IPC, recusa/consentimento, OAuth PKCE real, callback/cancelamento, isolamento, segredos ${protectedStorage ? "protegidos pelo sistema" : "somente em memória"}, ausência em snapshots/RPC e recuperação aprovados.`,
    );
    return snapshot.projectApis.connections.map((entry) => ({
      ...entry,
      authenticated: entry.remember && entry.authenticated,
      credentialAvailable: entry.remember && entry.credentialAvailable,
    }));
  } finally {
    await application.evaluate(({ shell, dialog }) => {
      shell.openExternal = global.apiPreviousOpen;
      dialog.showMessageBox = global.apiPreviousDialog;
    });
    await provider.close();
  }
}

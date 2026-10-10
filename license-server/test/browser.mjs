import assert from "node:assert/strict";
import { chromium, devices, expect } from "@playwright/test";
import { join } from "node:path";
import { createDevice } from "../client/client.mjs";

export async function browserContracts({ origin, password, api, directory }) {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });
  try {
    for (const [name, options] of [
      ["desktop", { viewport: { width: 1360, height: 960 } }],
      ["mobile", { ...devices["Pixel 7"] }],
    ]) {
      const context = await browser.newContext({ ...options, locale: "pt-BR" });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", () => errors.push("script-error"));
      try {
        await page.goto(origin);
        await expect(
          page.getByRole("heading", { name: "Controle quem usa o STAG Plus." }),
        ).toBeVisible();
        await page.getByLabel("Usuário", { exact: true }).fill("admin");
        await page.getByLabel("Senha", { exact: true }).fill(password);
        await page.getByRole("button", { name: "Entrar no painel" }).click();
        await expect(page.locator("#dashboard")).toBeVisible();
        await expect(page.locator("#stat-active")).not.toHaveText("—");
        api.sensitive.push(...(await context.cookies(origin)).map((cookie) => cookie.value));
        await page.getByRole("button", { name: "Nova licença" }).click();
        const dialog = page.locator("#create-dialog");
        await dialog.getByLabel("Nome ou identificação").fill(`UI ${name} synthetic`);
        await dialog.getByRole("button", { name: "Emitir licença", exact: true }).click();
        const keyDialog = page.locator("#key-dialog");
        await expect(keyDialog).toBeVisible();
        const key = await page.locator("#license-key").inputValue();
        api.sensitive.push(key);
        await keyDialog.getByRole("button", { name: "Copiar código" }).click();
        await expect(page.locator("#copy-status")).toHaveText("Código copiado.");
        assert.ok(
          key === (await page.evaluate(() => navigator.clipboard.readText())),
          "clipboard deve receber o código completo",
        );
        await keyDialog.getByRole("button", { name: "Concluir" }).click();
        await expect(page.locator("#license-key")).toHaveValue("");
        await expect(page.locator("#detail-title")).toHaveText(`UI ${name} synthetic`);
        const edit = page.locator("#edit-form");
        await edit.getByLabel("Nome ou identificação").fill(`UI ${name} updated`);
        await page.getByRole("button", { name: "+ 30 dias" }).click();
        await edit.getByRole("button", { name: "Salvar alterações" }).click();
        await expect(page.locator("#notice")).toHaveText("Alterações salvas.");
        await expect(page.locator("#detail-title")).toHaveText(`UI ${name} updated`);
        const device = createDevice();
        await api.device("activate", key, device, `Device ${name}`);
        await page.getByRole("button", { name: "Atualizar", exact: true }).click();
        await expect(page.locator("#devices")).toContainText(`Device ${name}`);
        await page.getByRole("button", { name: `Liberar Device ${name}`, exact: true }).click();
        await page.locator("#confirm-no").click();
        await expect(
          page.getByRole("button", { name: `Liberar Device ${name}`, exact: true }),
        ).toBeVisible();
        await page.getByRole("button", { name: `Liberar Device ${name}`, exact: true }).click();
        await page.locator("#confirm-yes").click();
        await expect(page.locator("#notice")).toHaveText("Computador liberado.");
        await page.getByRole("button", { name: "Revogar licença", exact: true }).click();
        await page.locator("#confirm-yes").click();
        await expect(page.locator("#detail-status")).toHaveText("Revogada");
        await page.getByRole("button", { name: "Reativar licença", exact: true }).click();
        await page.locator("#confirm-yes").click();
        await expect(page.locator("#detail-status")).toHaveText("Ativa");
        await page.getByRole("button", { name: "Gerar novo código", exact: true }).click();
        await page.locator("#confirm-yes").click();
        await expect(keyDialog).toBeVisible();
        const rotated = await page.locator("#license-key").inputValue();
        api.sensitive.push(rotated);
        assert.ok(rotated !== key, "rotação deve emitir outro código");
        await keyDialog.getByRole("button", { name: "Concluir" }).click();
        await api.device("activate", key, device, "Old key", 401);
        // A transient backend failure must preserve the editable draft and recover on explicit retry.
        await edit.getByLabel("Nome ou identificação").fill(`UI ${name} recovered`);
        await page.route("**/api/admin/licenses/*", async (route) =>
          route.request().method() === "PATCH"
            ? route.fulfill({
                status: 503,
                contentType: "application/json",
                body: JSON.stringify({ error: { message: "Falha sintética recuperável." } }),
              })
            : route.continue(),
        );
        await edit.getByRole("button", { name: "Salvar alterações" }).click();
        await expect(page.locator("#notice")).toHaveText("Falha sintética recuperável.");
        await expect(edit.getByLabel("Nome ou identificação")).toHaveValue(`UI ${name} recovered`);
        await page.unroute("**/api/admin/licenses/*");
        await edit.getByRole("button", { name: "Salvar alterações" }).click();
        await expect(page.locator("#detail-title")).toHaveText(`UI ${name} recovered`);
        await page.getByLabel("Buscar licença").fill(`UI ${name} recovered`);
        await page.getByRole("button", { name: "Buscar", exact: true }).click();
        await expect(page.locator(".license-row")).toHaveCount(1);
        await page.locator(".audit summary").click();
        await page.getByRole("button", { name: "Carregar atividade" }).click();
        await expect(page.locator("#audit-list")).toContainText("Licença emitida");
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
          "painel não pode ter scroll horizontal",
        );
        await page.screenshot({ path: join(directory, `${name}-panel.png`), fullPage: true });
        await page.reload();
        await expect(page.locator("#dashboard")).toBeVisible();
        await expect(page.locator("#stat-active")).not.toHaveText("—");
        await page.getByRole("button", { name: "Sair", exact: true }).click();
        await expect(page.locator("#login-view")).toBeVisible();
        await page.reload();
        await expect(page.locator("#login-view")).toBeVisible();
        assert.equal(errors.length, 0, "não pode haver erros de JavaScript");
        console.log(
          `Licenças: painel ${name}, cópia, edição, confirmações, recuperação e reload aprovados.`,
        );
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
}

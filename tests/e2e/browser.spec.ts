import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
});
async function ready(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
}
test("sessão por projeto é opcional e esquecer revoga o controle", async ({ page }, info) => {
  await ready(page);
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  const remember = page.getByRole("checkbox", { name: "Lembrar sessões neste projeto" });
  await expect(remember).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Esquecer logins" })).toBeDisabled();
  await remember.check();
  await expect(remember).toBeChecked();
  await expect(page.getByText("Sessões salvas neste computador.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await page.getByRole("button", { name: "Fechar navegador" }).click();
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(remember).toBeChecked();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-session.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Esquecer logins" }).click();
  await expect(remember).not.toBeChecked();
});
test("navegador ao lado, endereço e fechamento preservam conversa", async ({ page }, info) => {
  await ready(page);
  for (const width of [1584, 1280, 901]) {
    await page.setViewportSize({ width, height: 900 });
    const chat = await page.locator(".app-shell").boundingBox();
    const browser = await page
      .getByRole("region", { name: "Navegador do assistente" })
      .boundingBox();
    expect(browser!.x).toBeGreaterThanOrEqual(chat!.x + chat!.width - 1);
    expect(chat!.width).toBeGreaterThanOrEqual(360);
    expect(browser!.width).toBeGreaterThanOrEqual(width * 0.6);
    expect(browser!.x + browser!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 1584, height: 1080 });
  expect((await page.locator(".browser-viewport").boundingBox())!.width).toBeGreaterThanOrEqual(
    1000,
  );
  await page.getByLabel("Endereço do navegador").fill("https://fixture.invalid/docs");
  await page.getByRole("button", { name: "Ir", exact: true }).click();
  await expect(page.getByLabel("Endereço do navegador")).toHaveValue(
    "https://fixture.invalid/docs",
  );
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await expect(page.getByText("Modelo autorizado · confirmações críticas")).toBeVisible();
  await page.getByLabel("Mensagem para o assistente").fill("rascunho preservado");
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-panel.png` });
  await page.getByRole("button", { name: "Fechar navegador" }).click();
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("rascunho preservado");
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("janela compacta alterna navegador e conversa, rotina segue e crítico pode ser recusado", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByLabel("Endereço do navegador")).toBeVisible();
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await page.getByRole("button", { name: "Voltar à conversa" }).click();
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("navegador ler documentação");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(
    page.getByText("Navegador: documentação consultada.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
  await input.fill("navegador crítico enviar dados");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(page.getByText("Navegador: ação recusada.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

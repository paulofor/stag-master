import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import appMetadata from "../../package.json" with { type: "json" };
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
});

test("Sobre mostra crédito e versão sem login, contém o foco e pode ser reaberto", async ({
  page,
}, info) => {
  const account = page.getByRole("button", { name: "Conta e conexão", exact: true });
  const before = await page.evaluate(async () => window.stag!.getSnapshot());
  await account.click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sobre o STAG", exact: true });
  await expect(dialog).toContainText("Desenvolvido por: Paulo Forestieri");
  await expect(dialog).toContainText(`Versão ${appMetadata.version}`);
  const close = dialog.getByRole("button", { name: "Fechar", exact: true });
  await expect(close).toBeFocused();
  await close.press("Tab");
  await expect(close).toBeFocused();
  await close.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(account).toBeFocused();
  await account.click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  await expect(dialog).toBeVisible();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-about.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(account).toBeFocused();
  expect(await page.evaluate(async () => window.stag!.getSnapshot())).toEqual(before);
});

test("Sobre preserva conversa, rascunho, aprovação, consentimento e métricas com navegador", async ({
  page,
}, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Voltar à conversa" }).click();
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("recusar comando");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toBeVisible();
  await input.fill("Rascunho\npara a próxima tarefa");
  const before = await page.evaluate(async () => window.stag!.getSnapshot());
  await page.getByRole("button", { name: "Conta e conexão", exact: true }).click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sobre o STAG", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.press("Control+n");
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-about-conversation.png` });
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  expect(await page.evaluate(async () => window.stag!.getSnapshot())).toEqual(before);
  await expect(input).toHaveValue("Rascunho\npara a próxima tarefa");
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toBeVisible();
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(page.getByText("Ação recusada. Nenhum comando executado.")).toBeVisible();
});

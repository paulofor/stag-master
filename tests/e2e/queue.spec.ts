import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

async function ready(page: Page) {
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Selecionar projeto", exact: true }).click();
  await page.getByRole("button", { name: "Entrar com ChatGPT", exact: true }).click();
}
test("fila visível, ordem, remoção e envio só depois da resposta atual", async ({ page }, info) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  const add = page.getByRole("button", { name: "Adicionar texto à fila" });
  const queue = page.getByRole("region", { name: "Fila de solicitações" });
  await input.fill("perguntar primeiro");
  await input.press("Enter");
  await expect(add).toBeDisabled();
  await input.fill("perguntar segundo");
  await input.press("Enter"); // Enter never silently enqueues or interrupts.
  await expect(input).toHaveValue("perguntar segundo");
  await add.dblclick();
  await expect(input).toHaveValue("");
  await expect(queue.locator("li")).toHaveCount(1);
  await input.fill("texto removível");
  await add.click();
  await input.fill("último texto da fila");
  await add.click();
  await queue.getByRole("button", { name: "Remover texto 2 da fila" }).click();
  await expect(queue.locator("li")).toHaveCount(2);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-message-queue.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByLabel("Qual stack deseja?", { exact: true }).selectOption("TypeScript");
  await page.getByRole("button", { name: "Responder", exact: true }).click();
  await expect(page.locator(".user-message")).toHaveText([
    "perguntar primeiro",
    "perguntar segundo",
  ]);
  await expect(queue).toContainText("último texto da fila");
  await page.getByLabel("Qual stack deseja?", { exact: true }).selectOption("TypeScript");
  await page.getByRole("button", { name: "Responder", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await expect(page.locator(".user-message")).toHaveText([
    "perguntar primeiro",
    "perguntar segundo",
    "último texto da fila",
  ]);
});

test("parar preserva fila pausada, continuar envia e nova conversa descarta", async ({ page }) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  const queue = page.getByRole("region", { name: "Fila de solicitações" });
  await input.fill("lento");
  await input.press("Enter");
  await input.fill("outra tarefa lento");
  await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
  await queue.getByRole("button", { name: "Pausar fila" }).click();
  await expect(page.getByRole("button", { name: "Parar execução" })).toBeVisible();
  await page.getByRole("button", { name: "Parar execução" }).click();
  await expect(queue).toContainText("pausada");
  await expect(page.locator(".user-message")).toHaveCount(1);
  await queue.getByRole("button", { name: "Continuar fila" }).click();
  await expect(page.locator(".user-message")).toHaveCount(2);
  await input.fill("descartar ao sair");
  await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
  await page.getByRole("button", { name: "Parar execução" }).click();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(queue).toHaveCount(0);
  await expect(page.locator(".user-message")).toHaveCount(0);
});

test("falha no cadastro preserva rascunho e não duplica o texto na recuperação", async ({
  page,
}) => {
  await ready(page);
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failed = false;
    window.stag!.request = async (action) => {
      if (action.type === "enqueue" && !failed) {
        failed = true;
        throw new Error("Falha sintética ao enfileirar");
      }
      return original(action);
    };
  });
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("lento");
  await input.press("Enter");
  await input.fill("preservar este rascunho");
  await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(input).toHaveValue("preservar este rascunho");
  await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
  await expect(input).toHaveValue("");
  await expect(
    page.getByRole("region", { name: "Fila de solicitações" }).locator("li"),
  ).toHaveCount(1);
});

import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Branches dos projetos", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
});

test("consulta vários projetos, cria, troca, renomeia e exclui sem perder rascunho", async ({
  page,
}, info) => {
  await page.getByLabel("Mensagem para o assistente").fill("Edite o cadastro na branch escolhida");
  await page.getByRole("button", { name: "Branches dos projetos", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Branches dos projetos", exact: true });
  await expect(dialog).toContainText("2 projeto(s) Git");
  await expect(dialog.getByLabel("Projeto das branches").locator("option")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Nova branch", exact: true }).click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("feature/tela-clientes");
  await dialog.getByRole("button", { name: "Criar branch", exact: true }).click();
  await dialog
    .getByRole("article", { name: "Branch feature/tela-clientes", exact: true })
    .getByRole("button", { name: "Trocar", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Trocar branch", exact: true }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: feature/tela-clientes");
  await dialog
    .getByRole("article", { name: "Branch feature/tela-clientes", exact: true })
    .getByRole("button", { name: "Renomear" })
    .click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("feature/tela-renomeada");
  await dialog.getByRole("button", { name: "Salvar nome" }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("feature/tela-renomeada");
  await dialog
    .getByRole("article", { name: "Branch feature/cadastro", exact: true })
    .getByRole("button", { name: "Excluir" })
    .click();
  await expect(
    dialog.getByRole("article", { name: "Branch feature/cadastro", exact: true }),
  ).toHaveCount(0);
  const options = await dialog
    .getByLabel("Projeto das branches")
    .locator("option")
    .allTextContents();
  await dialog.getByLabel("Projeto das branches").selectOption({ label: options[1] });
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: main");
  await dialog.getByLabel("Filtrar branches").fill("desenvolvimento");
  await expect(dialog.getByRole("article")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Criar local" }).click();
  await expect(dialog.getByLabel("Nome da branch", { exact: true })).toHaveValue("desenvolvimento");
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-branches.png` });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Branches dos projetos", exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue(
    "Edite o cadastro na branch escolhida",
  );
});

test("erros preservam edição; Leitura consulta, mantém foco e não concede navegador", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Branches dos projetos", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Branches dos projetos", exact: true });
  await dialog.getByRole("button", { name: "Nova branch", exact: true }).click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("nome inválido");
  await dialog.getByRole("button", { name: "Criar branch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nome de branch inválido");
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("feature/recuperacao");
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failed = false;
    window.stag!.request = async (action) => {
      if (action.type === "changeBranch" && !failed) {
        failed = true;
        throw new Error("Falha sintética de Git");
      }
      return original(action);
    };
  });
  await dialog.getByRole("button", { name: "Criar branch", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Falha sintética");
  await expect(dialog.getByLabel("Nome da branch", { exact: true })).toHaveValue(
    "feature/recuperacao",
  );
  await dialog.getByRole("button", { name: "Criar branch", exact: true }).click();
  await expect(dialog.getByRole("article", { name: "Branch feature/recuperacao" })).toBeVisible();
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press("Control+n");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-branches-wide.png` });
  await dialog.getByRole("button", { name: "Fechar branches" }).click();
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByRole("button", { name: "Branches dos projetos", exact: true }).click();
  await expect(dialog).toContainText("Modo Leitura");
  await expect(dialog.getByRole("button", { name: "Nova branch", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Atualizar lista" })).toBeEnabled();
  for (const button of await dialog
    .getByRole("button", { name: /Trocar$|Renomear|Excluir$/ })
    .all())
    await expect(button).toBeDisabled();
  const state = await page.evaluate(async () => window.stag!.getSnapshot());
  expect(state.browser.authorized).toBe(false);
  expect(state.mode).toBe("read");
});

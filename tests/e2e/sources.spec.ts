import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
});

test("cadastro, edição, remoção e cancelamento preservam a conversa e o rascunho", async ({
  page,
}, info) => {
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("rascunho da tarefa");
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fontes do projeto", exact: true });
  await expect(dialog).toContainText("Nenhuma fonte cadastrada");
  await dialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await dialog.getByLabel("Nome da fonte 1", { exact: true }).fill("Arquitetura do sistema");
  await dialog
    .getByLabel("URL da fonte 1", { exact: true })
    .fill("https://docs.example.invalid/arquitetura");
  await dialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await dialog.getByLabel("Nome da fonte 2", { exact: true }).fill("Regras de negócio");
  await dialog.getByLabel("URL da fonte 2", { exact: true }).fill("http://localhost:4201/regras");
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-sources.png` });
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue("rascunho da tarefa");
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toContainText(
    "2",
  );
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  await dialog.getByLabel("Nome da fonte 1", { exact: true }).fill("edição cancelada");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  await expect(dialog.getByLabel("Nome da fonte 1", { exact: true })).toHaveValue(
    "Arquitetura do sistema",
  );
  await dialog
    .getByLabel("URL da fonte 1", { exact: true })
    .fill("https://docs.example.invalid/arquitetura-v2");
  await dialog.getByRole("button", { name: "Remover fonte 2", exact: true }).click();
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toContainText(
    "1",
  );
  await input.press("Enter");
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  await expect(dialog.getByLabel("URL da fonte 1", { exact: true })).toHaveValue(
    "https://docs.example.invalid/arquitetura-v2",
  );
  await dialog.getByRole("button", { name: "Remover fonte 1", exact: true }).click();
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(page.getByRole("button", { name: "Fontes do projeto", exact: true })).toContainText(
    "0",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("valida URLs/duplicatas e falha de salvamento mantém o formulário para recuperação", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fontes do projeto", exact: true });
  await dialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await dialog.getByLabel("Nome da fonte 1", { exact: true }).fill("Documentação");
  await dialog.getByLabel("URL da fonte 1", { exact: true }).fill("file:///C:/docs");
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("HTTP ou HTTPS");
  await dialog.getByLabel("URL da fonte 1", { exact: true }).fill("https://docs.example.invalid");
  await dialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await dialog.getByLabel("Nome da fonte 2", { exact: true }).fill("Duplicada");
  await dialog
    .getByLabel("URL da fonte 2", { exact: true })
    .fill("https://DOCS.example.invalid:443/");
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("já está cadastrada");
  await dialog.getByRole("button", { name: "Remover fonte 2", exact: true }).click();
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failed = false;
    window.stag!.request = async (action) => {
      if (action.type === "projectSources" && !failed) {
        failed = true;
        throw new Error("Falha sintética ao salvar fontes.");
      }
      return original(action);
    };
  });
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Falha sintética");
  await expect(dialog.getByLabel("Nome da fonte 1", { exact: true })).toHaveValue("Documentação");
  expect((await page.evaluate(async () => window.stag!.getSnapshot())).projectSources).toEqual([]);
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await page.evaluate(async () => window.stag!.getSnapshot())).projectSources).toEqual([
    { name: "Documentação", url: "https://docs.example.invalid/" },
  ]);
});

test("janela ampla mantém foco no cadastro e não concede navegador ou desktop", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Fontes do projeto", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fontes do projeto", exact: true });
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await dialog.getByRole("button", { name: "Adicionar fonte" }).click();
  await dialog.getByLabel("Nome da fonte 1", { exact: true }).fill("Fonte <texto inerte>");
  await dialog
    .getByLabel("URL da fonte 1", { exact: true })
    .fill("https://docs.example.invalid/project");
  await page.keyboard.press("Control+n");
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-sources-wide.png` });
  await dialog.getByRole("button", { name: "Salvar fontes" }).click();
  const snapshot = await page.evaluate(async () => window.stag!.getSnapshot());
  expect(snapshot.browser.authorized).toBe(false);
  expect(snapshot.browser.url).toBe("");
  expect(snapshot.mode).toBe("project");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

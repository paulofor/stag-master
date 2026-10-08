import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page, { project: { path: "C:/fixture", name: "Projeto sintético" } });
  await page.goto("/");
});
async function form(page: Page) {
  await page.getByRole("button", { name: "APIs HTTP e HTTPS", exact: true }).click();
  return page.getByRole("dialog", { name: "APIs HTTP e HTTPS", exact: true });
}
test("cadastro Bearer, máscara, edição, consentimento e exclusão preservam rascunho e foco", async ({
  page,
}, info) => {
  const draft = page.getByLabel("Mensagem para o assistente", { exact: true });
  await draft.fill("rascunho sintético da API");
  const dialog = await form(page);
  await dialog.getByLabel("Nome da API", { exact: true }).fill("API sintética");
  await dialog.getByLabel("URL base", { exact: true }).fill("https://api.example.invalid/v1/");
  const token = dialog.getByLabel("Token da API", { exact: true });
  await token.fill("synthetic-token");
  await expect(token).toHaveAttribute("type", "password");
  await dialog.getByLabel("Lembrar credenciais neste computador").check();
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await expect(token).toHaveValue("");
  await expect(dialog.getByLabel("API cadastrada")).not.toHaveValue("");
  await dialog.getByRole("button", { name: "Autorizar APIs nesta conversa", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Revogar APIs", exact: true })).toBeVisible();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-apis.png` });
  await dialog.getByLabel("Nome da API").fill("API editada");
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Autorizar APIs nesta conversa", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Excluir API", exact: true }).click();
  await dialog.getByRole("button", { name: "Manter API", exact: true }).click();
  await dialog.getByRole("button", { name: "Excluir API", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirmar exclusão da API", exact: true }).click();
  await expect(dialog.getByLabel("API cadastrada").locator("option")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(draft).toHaveValue("rascunho sintético da API");
  await expect(page.getByRole("button", { name: "APIs HTTP e HTTPS", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("OAuth2 expõe campos, retorno e fluxo de login sem pedir senha na conversa", async ({
  page,
}) => {
  const dialog = await form(page);
  await dialog.getByLabel("Nome da API").fill("OAuth sintético");
  await dialog.getByLabel("URL base", { exact: true }).fill("https://api.example.invalid/");
  await dialog.getByLabel("Autenticação", { exact: true }).selectOption("oauth2");
  await dialog.getByLabel("URL de autorização").fill("https://login.example.invalid/authorize");
  await dialog.getByLabel("URL do token").fill("https://login.example.invalid/token");
  await dialog.getByLabel("Client ID", { exact: true }).fill("synthetic-client");
  await dialog.getByLabel("Scopes (separados por espaço)").fill("api.read offline_access");
  await expect(dialog).toContainText("http://127.0.0.1:43821/oauth/callback");
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await dialog.getByRole("button", { name: "Entrar com OAuth2", exact: true }).click();
  await expect(dialog).toContainText("API autenticada");
  await dialog.getByLabel("URL do token").fill("https://login.example.invalid/other-token");
  await expect(dialog.getByRole("button", { name: "Entrar com OAuth2" })).toBeDisabled();
  await dialog.getByLabel("Fluxo OAuth2").selectOption("client_credentials");
  await expect(dialog.getByLabel("URL de autorização")).toHaveCount(0);
  await expect(dialog.getByLabel("Client secret", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
});
test("Basic aceita usuário/senha, valida URL e HTTP explícito; falha preserva formulário", async ({
  page,
}) => {
  const dialog = await form(page);
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nome da API");
  await dialog.getByLabel("Nome da API").fill("Basic");
  await dialog.getByLabel("URL base", { exact: true }).fill("http://127.0.0.1:12345/v1/");
  await dialog.getByLabel("Autenticação", { exact: true }).selectOption("basic");
  await dialog.getByLabel("Usuário da API").fill("synthetic-user");
  await dialog.getByLabel("Senha da API").fill("synthetic-password");
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Permitir HTTP");
  await dialog.getByText("Segurança e prazo", { exact: true }).click();
  await dialog.getByLabel("Permitir HTTP sem criptografia nesta conexão").check();
  await page.evaluate(() => {
    const original = window.stag!.request;
    window.stag!.request = async (action) => {
      if (action.type === "saveApi")
        throw new Error("Falha sintética ao salvar; formulário preservado.");
      return original(action);
    };
  });
  await dialog.getByRole("button", { name: "Salvar API", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("preservado");
  await expect(dialog.getByLabel("Senha da API")).toHaveValue("synthetic-password");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("diálogo oculta o navegador, bloqueia atalho de nova conversa e restaura bounds", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => {
    const w = window as unknown as { apiBounds: { width: number }[] };
    w.apiBounds = [];
    const original = window.stag!.request;
    window.stag!.request = async (action) => {
      if (action.type === "browserBounds") w.apiBounds.push(action.bounds);
      return original(action);
    };
  });
  const last = () =>
    page.evaluate(
      () => (window as unknown as { apiBounds: { width: number }[] }).apiBounds.at(-1)?.width,
    );
  const dialog = await form(page);
  await expect.poll(last).toBe(0);
  await dialog.getByLabel("Nome da API").fill("rascunho");
  await page.keyboard.press("Control+n");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Nome da API")).toHaveValue("rascunho");
  await dialog.getByRole("button", { name: "Fechar APIs", exact: true }).click();
  await expect.poll(last).toBeGreaterThan(0);
});

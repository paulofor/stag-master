import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }, info) => {
  await installBridge(page, {
    project: { path: "C:/fixture", name: "Projeto sintético" },
    ...(info.tags.includes("@storageDisabled")
      ? {
          mode: "read" as const,
          projectDatabases: {
            revision: "11111111-1111-4111-8111-111111111111",
            connections: [],
            canRememberPassword: false,
            authorized: false,
            metrics: { requests: 0, failures: 0, elapsedMs: 0, lastRows: null },
            test: null,
          },
        }
      : {}),
  });
  await page.goto("/");
});
async function form(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
  return page.getByRole("dialog", { name: "Conexões com banco de dados", exact: true });
}
async function fill(dialog: import("@playwright/test").Locator) {
  await dialog.getByLabel("Nome da conexão", { exact: true }).fill("Homologação");
  await dialog.getByLabel("Servidor", { exact: true }).fill("sql.example.invalid");
  await dialog.getByLabel("Banco de dados", { exact: true }).fill("stag_fixture");
  await dialog.getByLabel("Usuário", { exact: true }).fill("fixture");
  await dialog.getByLabel("Senha do usuário", { exact: true }).fill("synthetic only !");
}
test("autoriza bancos por conversa, permite revogar e edição encerra consentimento", async ({
  page,
}) => {
  let dialog = await form(page);
  await expect(
    dialog.getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true }),
  ).toBeDisabled();
  await fill(dialog);
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await expect(dialog).toContainText("Salvar ou testar não autoriza consultas");
  await dialog
    .getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true })
    .click();
  await expect(dialog.getByRole("button", { name: "Revogar bancos", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Revogar bancos", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true })
    .click();
  await dialog.getByLabel("Conexão salva", { exact: true }).selectOption({ label: "Homologação" });
  await dialog.getByLabel("Nome da conexão", { exact: true }).fill("Editada");
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await expect(
    dialog.getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true }),
  ).toBeVisible();
});
test("senha somente na sessão permite testar e lembrar sem redigitar", async ({ page }) => {
  let dialog = await form(page);
  await fill(dialog);
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await dialog.getByLabel("Conexão salva", { exact: true }).selectOption({ label: "Homologação" });
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveAttribute(
    "placeholder",
    /nesta sessão/,
  );
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Conexão validada");
  await dialog.getByLabel("Lembrar senha neste computador", { exact: true }).check();
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test("consulta em andamento permite abrir Conexões e revogar, mantendo edição bloqueada", async ({
  page,
}) => {
  let dialog = await form(page);
  await fill(dialog);
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await dialog
    .getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
  await page.evaluate(() => {
    window.dispatchEvent(
      new CustomEvent("stag-fixture-snapshot", {
        detail: { busy: true, threadId: "sql-active-fixture" },
      }),
    );
  });
  await expect(page.getByRole("button", { name: "Conexões com banco de dados" })).toBeEnabled();
  dialog = await form(page);
  await expect(dialog.getByRole("button", { name: "Salvar conexão", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Testar conexão", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Revogar bancos", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Autorizar bancos nesta conversa", exact: true }),
  ).toBeVisible();
  expect((await page.evaluate(() => window.stag!.getSnapshot())).busy).toBe(false);
});
test("diálogo de conexão oculta o navegador lateral e restaura seus bounds ao fechar", async ({
  page,
}) => {
  await page.evaluate(() => {
    const recorder = window as unknown as Window & {
      databaseBounds: { width: number; height: number }[];
    };
    recorder.databaseBounds = [];
    const original = window.stag!.request;
    window.stag!.request = async (action) => {
      if (action.type === "browserBounds") recorder.databaseBounds.push(action.bounds);
      return original(action);
    };
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  const lastBounds = () =>
    page.evaluate(() =>
      (
        window as unknown as Window & { databaseBounds: { width: number; height: number }[] }
      ).databaseBounds.at(-1),
    );
  await expect.poll(async () => (await lastBounds())?.width || 0).toBeGreaterThan(0);
  const dialog = await form(page);
  await expect.poll(lastBounds).toMatchObject({ width: 0, height: 0 });
  await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
  await expect.poll(async () => (await lastBounds())?.width || 0).toBeGreaterThan(0);
});
test("cadastro, teste, edição e exclusão preservam rascunho e máscara da senha", async ({
  page,
}, info) => {
  const input = page.getByLabel("Mensagem para o assistente", { exact: true });
  await input.fill("rascunho da tarefa");
  let dialog = await form(page);
  await fill(dialog);
  const secret = dialog.getByLabel("Senha do usuário", { exact: true });
  await expect(secret).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Mostrar senha", exact: true }).click();
  await expect(secret).toHaveAttribute("type", "text");
  await dialog.getByRole("button", { name: "Ocultar senha", exact: true }).click();
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Conexão validada");
  await dialog.getByLabel("Lembrar senha neste computador", { exact: true }).check();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-databases.png` });
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(input).toHaveValue("rascunho da tarefa");
  await expect(
    page.getByRole("button", { name: "Conexões com banco de dados", exact: true }),
  ).toBeFocused();
  dialog = await form(page);
  await dialog.getByLabel("Conexão salva", { exact: true }).selectOption({ label: "Homologação" });
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("Lembrar senha neste computador", { exact: true })).toBeChecked();
  await dialog.getByLabel("Nome da conexão", { exact: true }).fill("Homologação editada");
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await dialog
    .getByLabel("Conexão salva", { exact: true })
    .selectOption({ label: "Homologação editada" });
  await dialog.getByRole("button", { name: "Excluir conexão", exact: true }).click();
  await dialog.getByRole("button", { name: "Manter conexão", exact: true }).click();
  await expect(dialog.getByLabel("Conexão salva", { exact: true }).locator("option")).toHaveCount(
    2,
  );
  await dialog.getByRole("button", { name: "Excluir conexão", exact: true }).click();
  await dialog.getByRole("button", { name: "Confirmar exclusão", exact: true }).click();
  await expect(dialog.getByLabel("Conexão salva", { exact: true }).locator("option")).toHaveCount(
    1,
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("valida servidor/porta e mostra instância com opções TLS padrão", async ({ page }) => {
  const dialog = await form(page);
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Nome");
  await fill(dialog);
  await dialog.getByLabel("Servidor", { exact: true }).fill("https://user:synthetic@host");
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("hostname ou IP");
  await expect(dialog.getByRole("alert")).not.toContainText("synthetic@");
  await dialog.getByLabel("Servidor", { exact: true }).fill("localhost");
  await dialog.getByLabel("Porta", { exact: true }).fill("0");
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Porta ou instância");
  await dialog.getByLabel("Endereço por", { exact: true }).selectOption("instance");
  await expect(dialog.getByLabel("Porta", { exact: true })).toHaveCount(0);
  await dialog.getByLabel("Instância", { exact: true }).fill("SQLEXPRESS");
  await expect(dialog).toContainText("UDP 1434");
  await dialog.getByText("Segurança e opções avançadas", { exact: true }).click();
  await expect(dialog.getByLabel("Criptografar conexão (TLS)", { exact: true })).toBeChecked();
  await expect(
    dialog.getByLabel("Confiar no certificado do servidor", { exact: true }),
  ).not.toBeChecked();
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Conexão validada");
});
test("falha de persistência preserva campos/senha e permite recuperação", async ({ page }) => {
  const dialog = await form(page);
  await fill(dialog);
  await page.evaluate(() => {
    const original = window.stag!.request;
    let fail = true;
    window.stag!.request = async (action) => {
      if (action.type === "saveDatabase" && fail) {
        fail = false;
        throw new Error("Não foi possível salvar as conexões. O formulário foi preservado.");
      }
      return original(action);
    };
  });
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("preservado");
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue(
    "synthetic only !",
  );
  await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue("Homologação");
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
test(
  "Leitura e armazenamento indisponível permitem salvar campos sem senha",
  { tag: "@storageDisabled" },
  async ({ page }) => {
    const dialog = await form(page);
    await fill(dialog);
    await expect(
      dialog.getByLabel("Lembrar senha neste computador", { exact: true }),
    ).toBeDisabled();
    await dialog.getByLabel("Senha do usuário", { exact: true }).fill("");
    await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("read");
  },
);
test("janela 360×600 mantém campos e botões acessíveis sem overflow", async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 600 });
  const dialog = await form(page);
  await fill(dialog);
  await dialog.getByText("Segurança e opções avançadas", { exact: true }).click();
  await dialog.getByRole("button", { name: "Testar conexão", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Conexão validada");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-databases-360.png` });
});

test("reabrir seleciona conexão salva e informa raiz; Nova conexão continua explícita", async ({
  page,
}) => {
  let dialog = await form(page);
  await fill(dialog);
  await dialog.getByRole("button", { name: "Salvar conexão", exact: true }).click();
  dialog = await form(page);
  await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue("Homologação");
  await expect(dialog).toContainText("Pasta: C:/fixture");
  await expect(dialog).toContainText("1 conexão(ões) salva(s)");
  await expect(dialog.getByLabel("Senha do usuário", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Conexão salva", { exact: true }).selectOption("");
  await expect(dialog.getByLabel("Nome da conexão", { exact: true })).toHaveValue("");
});

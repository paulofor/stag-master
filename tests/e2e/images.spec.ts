import { test, expect, type Page } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";
import fixture from "../fixtures/request-image.json" with { type: "json" };

async function paste(
  page: Page,
  options: { dataUrl?: string; type?: string; count?: number; size?: number } = {},
) {
  await page.getByLabel("Mensagem para o assistente").evaluate(
    (textarea, value) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob(value.dataUrl.split(",")[1]), (c) => c.charCodeAt(0));
      for (let i = 0; i < value.count; i++)
        data.items.add(
          new File([value.size ? new Uint8Array(value.size) : bytes], "imagem-sintetica", {
            type: value.type,
          }),
        );
      textarea.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { dataUrl: fixture.dataUrl, type: "image/png", count: 1, ...options },
  );
}
test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
});
test("imagens pendentes não são descartadas nem enviadas pela fila de texto", async ({ page }) => {
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("lento");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await input.fill("Analise depois");
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Adicionar texto à fila" })).toBeDisabled();
  await expect(page.getByLabel("Imagens da solicitação")).toContainText(
    "fila aceita somente texto",
  );
  await expect(input).toHaveValue("Analise depois");
  await page.getByRole("button", { name: "Remover imagem 1" }).click();
  await expect(page.getByRole("button", { name: "Adicionar texto à fila" })).toBeEnabled();
  await page.getByRole("button", { name: "Adicionar texto à fila" }).click();
  await expect(page.getByRole("region", { name: "Fila de solicitações" })).toContainText(
    "Analise depois",
  );
});
test("consultar Sobre preserva o rascunho e a imagem pendente sem enviar", async ({ page }) => {
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Analise esta tela\nquando eu enviar");
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  const before = await page.evaluate(async () => window.stag!.getSnapshot());
  await page.getByRole("button", { name: "Conta e conexão", exact: true }).click();
  await page.getByRole("button", { name: "Sobre o STAG", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Sobre o STAG", exact: true });
  await expect(dialog).toContainText("Desenvolvido por: Paulo Forestieri");
  await dialog.getByRole("button", { name: "Fechar", exact: true }).click();
  await expect(input).toHaveValue("Analise esta tela\nquando eu enviar");
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toHaveCount(0);
  expect(await page.evaluate(async () => window.stag!.getSnapshot())).toEqual(before);
});
test("cola, remove e envia texto com imagens sem perder o texto", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Analise esta tela do sistema");
  await paste(page, { count: 2 });
  await expect(page.locator(".composer img")).toHaveCount(2);
  await expect(input).toHaveValue("Analise esta tela do sistema");
  await page.getByRole("button", { name: "Remover imagem 1" }).click();
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(input).toHaveValue("Analise esta tela do sistema");
  await input.press("Enter");
  await input.pressSequentially("Confira o formulário");
  await expect(input).toHaveValue("Analise esta tela do sistema\nConfira o formulário");
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toHaveCount(0);
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.locator(".user-message img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toContainText("Analise esta tela do sistema");
  await expect(page.locator(".composer img")).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-request-image.png` });
});
test("Enter preserva imagem sem texto; o botão envia e o histórico restaura", async ({ page }) => {
  await paste(page);
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeEnabled();
  const input = page.getByLabel("Mensagem para o assistente");
  await input.press("Enter");
  await expect(input).toHaveValue("\n");
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.stag!.getSnapshot()).threadId)).toBeNull();
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.locator(".user-message img")).toHaveCount(1);
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await page.getByRole("button", { name: "Histórico de conversas" }).click();
  await page.getByRole("button", { name: "Solicitação com imagens", exact: true }).click();
  await expect(page.locator(".composer img")).toHaveCount(0);
  await expect(page.locator(".user-message img")).toHaveCount(1);
});
test("falha preserva rascunho multilinha/anexo e novo envio funciona", async ({ page }) => {
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failed = false;
    window.stag!.request = async (action) => {
      if (action.type === "send" && !failed) {
        failed = true;
        throw new Error("Falha sintética ao enviar.");
      }
      return original(action);
    };
  });
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Analise o diagrama");
  await input.press("Enter");
  await input.pressSequentially("Verifique as relações");
  const text = "Analise o diagrama\nVerifique as relações";
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(input).toHaveValue(text);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await expect(input).toBeFocused();
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.locator(".user-message img")).toHaveCount(1);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect(input).toBeFocused();
  expect(
    await page.evaluate(
      async () =>
        (await window.stag!.getSnapshot()).items.find((item) => item.kind === "user")?.text,
    ),
  ).toBe(text);
});
test("formatos e limites inválidos preservam o rascunho e os anexos válidos", async ({ page }) => {
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Minha tarefa");
  await paste(page, { type: "image/svg+xml" });
  await expect(page.getByRole("alert")).toContainText("PNG ou JPEG");
  await paste(page, { dataUrl: "data:image/png;base64,AAAA" });
  await expect(page.getByRole("alert")).toContainText("inválida");
  await paste(page, { size: 4 * 1024 * 1024 + 1 });
  await expect(page.getByRole("alert")).toContainText("4 MB");
  await paste(page, { count: 4 });
  await expect(page.locator(".composer img")).toHaveCount(4);
  await paste(page);
  await expect(page.getByRole("alert")).toContainText("no máximo 4 imagens");
  await expect(page.locator(".composer img")).toHaveCount(4);
  await expect(input).toHaveValue("Minha tarefa");
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(page.locator(".composer img")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
});
test("colagem em andamento não reaparece depois de trocar conversa", async ({ page }) => {
  await page.evaluate(() => {
    const Original = window.FileReader;
    const hooks = window as typeof window & { finishImageRead?: () => void };
    window.FileReader = class extends Original {
      override readAsDataURL(blob: Blob) {
        hooks.finishImageRead = () => {
          window.FileReader = Original;
          super.readAsDataURL(blob);
        };
      }
    };
  });
  await paste(page);
  await expect(page.getByRole("status", { name: "Imagens da solicitação" })).toContainText(
    "Preparando imagem",
  );
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await page.evaluate(() =>
    (window as typeof window & { finishImageRead: () => void }).finishImageRead(),
  );
  await expect(page.getByRole("status", { name: "Imagens da solicitação" })).not.toContainText(
    "Preparando imagem",
  );
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
});
test("cancelar seleção mantém anexo; selecionar projeto e sair da conta o descartam", async ({
  page,
}) => {
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Analise o projeto");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await page.evaluate(() => {
    const original = window.stag!.request;
    let canceled = false;
    window.stag!.request = async (action) => {
      if (action.type === "selectProject" && !canceled) {
        canceled = true;
        return window.stag!.getSnapshot();
      }
      return original(action);
    };
  });
  await page.getByRole("button", { name: "Selecionar pasta do projeto", exact: true }).click();
  await expect(page.locator(".composer img")).toHaveCount(1);
  await page.getByRole("button", { name: "Selecionar pasta do projeto", exact: true }).click();
  await expect(page.locator(".composer img")).toHaveCount(0);
  await paste(page);
  await expect(page.locator(".composer img")).toHaveCount(1);
  await page.getByRole("button", { name: "Conta e conexão" }).click();
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await expect(page.locator(".composer img")).toHaveCount(0);
});

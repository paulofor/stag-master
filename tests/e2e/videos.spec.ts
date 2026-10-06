import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
});
test("anexa vídeo e envia só pelo botão, sem duplicar o texto", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  const attachment = page.getByRole("region", { name: "Vídeo da solicitação" });
  await expect(attachment).toContainText("fala transcrita");
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Aprenda as regras deste projeto");
  await input.press("Enter");
  await expect(input).toHaveValue("Aprenda as regras deste projeto\n");
  await expect(page.locator(".user-message")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-video.png` });
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(attachment).toHaveCount(0);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect(page.locator(".user-message")).toContainText("projeto-sintetico.mp4");
  await expect(input).toHaveValue("");
});
test("Leitura, remoção, troca de conversa e falha preservam o rascunho", async ({ page }) => {
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  const attachment = page.getByRole("region", { name: "Vídeo da solicitação" });
  await expect(attachment).toContainText("sem salvar anotações");
  await page.getByLabel("Mensagem para o assistente").fill("Observe as regras");
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failure = true;
    window.stag!.request = async (action) => {
      if (action.type === "send" && failure) {
        failure = false;
        throw new Error("Falha sintética de vídeo");
      }
      return original(action);
    };
  });
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(attachment).toBeVisible();
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Remover vídeo", exact: true }).click();
  await expect(attachment).toHaveCount(0);
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(attachment).toHaveCount(0);
});

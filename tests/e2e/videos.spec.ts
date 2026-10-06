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

test("vídeo longo tem progresso, pausa, retomada e cancelamento sem perder o rascunho", async ({
  page,
}, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Pergunta para depois da análise");
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
  await expect(panel).toContainText("0 de 19 trechos");
  await expect(panel).toContainText("Continua minimizado");
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  await expect(input).toHaveValue("Pergunta para depois da análise");
  await page.getByRole("button", { name: "Pausar análise", exact: true }).click();
  await expect(panel).toContainText("1 de 19 trechos");
  await expect(
    page.getByRole("progressbar", { name: "Progresso da análise de vídeo" }),
  ).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "Retomar análise", exact: true }).click();
  await expect(panel).toContainText("próximo trecho");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-background-video.png` });
  await page.getByRole("button", { name: "Cancelar análise", exact: true }).click();
  await expect(panel).toContainText("Análise cancelada");
  await expect(input).toHaveValue("Pergunta para depois da análise");
});
test("vídeo longo em Leitura mantém aviso e falha de início preserva texto", async ({ page }) => {
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByLabel("Mensagem para o assistente").fill("Observe as regras");
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failure = true;
    window.stag!.request = async (action) => {
      if (action.type === "analyzeVideo" && failure) {
        failure = false;
        throw new Error("Falha sintética ao preparar vídeo longo");
      }
      return original(action);
    };
  });
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Análise de vídeo em segundo plano" }),
  ).toContainText("sem salvar anotações");
});

test("controles de vídeo longo cabem na janela mínima", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const pause = page.getByRole("button", { name: "Pausar análise", exact: true });
  await expect(pause).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Cancelar análise", exact: true }),
  ).toBeInViewport();
  await expect(page.getByLabel("Mensagem para o assistente")).toBeInViewport();
  const box = await page.locator(".composer-controls").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
});

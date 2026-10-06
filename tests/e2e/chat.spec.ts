import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";
import { mkdir } from "node:fs/promises";

test.beforeEach(async ({ page }, info) => {
  await installBridge(page, info.tags.includes("@linux") ? { platform: "linux" } : {});
  await page.goto("/");
});
async function ready(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
}
test("selecionar pasta autoriza leitura e escrita, e Leitura continua disponível", async ({
  page,
}) => {
  await ready(page);
  await expect(page.getByRole("region", { name: "Preparação Git", exact: true })).toContainText(
    "Git pronto: 2 repositório(s) verificado(s).",
  );
  const access = page.getByLabel("Acesso", { exact: true });
  await expect(access).toHaveValue("project");
  await expect(access.locator("option:checked")).toHaveText("Projeto · leitura e escrita");
  await access.selectOption("read");
  await expect(access).toHaveValue("read");
  await page.getByRole("button", { name: "Selecionar pasta do projeto", exact: true }).click();
  await expect(access).toHaveValue("project");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("preparação Git com falha mostra orientação sem bloquear conversa", async ({ page }, info) => {
  await installBridge(page, {
    project: {
      path: "C:/Projetos/exemplo",
      name: "exemplo",
      git: {
        phase: "complete",
        scanned: 2,
        found: 1,
        added: 0,
        verified: 0,
        skipped: 1,
        failures: 1,
        incomplete: false,
        issues: [
          {
            path: "frontend",
            message:
              "Não foi possível cadastrar a confiança Git. Verifique a configuração e selecione a pasta novamente.",
          },
        ],
      },
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  const report = page.getByRole("region", { name: "Preparação Git", exact: true });
  await expect(report).toContainText("Há pendências");
  await report.getByText("Detalhes do Git").click();
  await expect(report).toContainText("selecione a pasta novamente");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-git-report.png` });
  await page.getByLabel("Mensagem para o assistente").fill("Explique a arquitetura");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
});
test("painel compacto, onboarding e conversa Markdown", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByRole("heading", { name: "Do que vamos cuidar hoje?" })).toBeVisible();
  await expect(page.locator(".welcome-description")).toContainText(
    "Arquitetura, programação e regras de negócio.",
  );
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-welcome.png` });
  await ready(page);
  await expect(page.getByLabel("Modelo", { exact: true })).toHaveValue("fixture-model");
  await page.getByLabel("Mensagem para o assistente").fill("Analise o projeto");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  await expect(page.locator("pre code")).toContainText("const ready = true");
  await expect(page.getByRole("table")).toBeVisible();
  await expect(page.locator(".metrics")).toContainText("1.234 tokens");
  await expect(page.getByRole("button", { name: "Parar execução" })).toHaveCount(0);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-conversation.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
test("Enter e Shift+Enter criam linhas sem enviar; o botão envia o texto completo", async ({
  page,
}, info) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  const send = page.getByRole("button", { name: "Enviar mensagem" });
  await expect(page.locator(".footer-hint")).toContainText("Enter para nova linha");
  await input.press("Enter");
  await expect(input).toHaveValue("\n");
  await expect(send).toBeDisabled();
  await input.fill("Primeira linha");
  await input.press("Enter");
  await input.pressSequentially("Segunda linha");
  await input.press("Shift+Enter");
  await input.pressSequentially("Terceira linha");
  const text = "Primeira linha\nSegunda linha\nTerceira linha";
  await expect(input).toHaveValue(text);
  await expect(page.locator(".user-message")).toHaveCount(0);
  expect(await page.evaluate(async () => (await window.stag!.getSnapshot()).threadId)).toBeNull();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-multiline-request.png` });
  await send.click();
  await expect(page.locator(".user-message")).toHaveCount(1);
  expect(
    await page.evaluate(async () =>
      (await window.stag!.getSnapshot()).items
        .filter((item) => item.kind === "user")
        .map((item) => item.text),
    ),
  ).toEqual([text]);
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
});
test("aprovação recusada e histórico restaurado", async ({ page }) => {
  await ready(page);
  await page.getByLabel("Mensagem para o assistente").fill("recusar comando");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toBeVisible();
  await expect(page.getByText("npm test", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(page.getByText("Ação recusada. Nenhum comando executado.")).toBeVisible();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(page.locator(".user-message")).toHaveCount(0);
  await page.getByRole("button", { name: "Histórico de conversas" }).click();
  await page.getByRole("button", { name: "recusar comando", exact: true }).click();
  await expect(page.getByText("Ação recusada. Nenhum comando executado.")).toBeVisible();
});
test("pergunta obrigatória e interrupção", async ({ page }) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("perguntar");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("button", { name: "Responder", exact: true })).toBeDisabled();
  await page.getByLabel("Qual stack deseja?", { exact: true }).selectOption("TypeScript");
  await page.getByRole("button", { name: "Responder", exact: true }).click();
  await expect(page.getByText("Resposta recebida. Fluxo concluído.")).toBeVisible();
  await input.fill("lento");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByLabel("Acesso", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Parar execução" }).click();
  await expect(page.getByText("Execução interrompida.")).toBeVisible();
});
test("modo Windows exige consentimento e cancelamento preserva modo", async ({ page }) => {
  await ready(page);
  const mode = page.getByLabel("Acesso", { exact: true });
  await mode.selectOption("windows");
  await expect(page.getByRole("dialog", { name: "Trabalhar no Windows" })).toBeVisible();
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(mode).toHaveValue("project");
  await mode.selectOption("windows");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(mode).toHaveValue("windows");
});
test("desktop autorizado segue rotina, confirma ponto crítico e pode ser revogado", async ({
  page,
}, info) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("capturar desktop");
  await page.getByRole("button", { name: "Autorizar desktop", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Trabalhar no Windows" })).toContainText(
    "enviados ao ChatGPT",
  );
  await expect(page.getByRole("dialog", { name: "Trabalhar no Windows" })).toContainText(
    "somente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient",
  );
  await expect(page.getByRole("dialog", { name: "Trabalhar no Windows" })).toContainText(
    "inclusive para reconectar a VPN",
  );
  await expect(page.getByRole("dialog", { name: "Trabalhar no Windows" })).toContainText(
    "mesmo com aprovação",
  );
  await page.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("project");
  await expect(input).toHaveValue("capturar desktop");
  await page.getByRole("button", { name: "Autorizar desktop", exact: true }).click();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.getByRole("region", { name: "Controle do desktop" })).toContainText(
    "Desktop autorizado · Postman, IntelliJ, VS Code, DBeaver e FortiClient",
  );
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(
    page.getByText("Desktop: captura e navegação sintéticas concluídas.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
  await input.fill("desktop crítico enviar requisição");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Confirmar ação no desktop?", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toContainText(
    "Enviar requisição ao serviço externo",
  );
  await expect(page.getByRole("button", { name: "Revogar acesso", exact: true })).toBeDisabled();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-desktop-approval.png` });
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(page.getByText("Desktop: ação recusada.", { exact: true })).toBeVisible();
  await input.fill("desktop crítico enviar requisição");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Confirmar ação no desktop?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Permitir esta ação", exact: true }).click();
  await expect(
    page.getByText("Desktop: ação crítica sintética concluída.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Revogar acesso", exact: true }).click();
  await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("project");
  await expect(page.getByRole("button", { name: "Autorizar desktop", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test("nova conversa encerra acesso ao desktop", async ({ page }) => {
  await ready(page);
  await page.getByRole("button", { name: "Autorizar desktop", exact: true }).click();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(page.getByRole("button", { name: "Autorizar desktop", exact: true })).toBeVisible();
  await expect(page.getByLabel("Acesso", { exact: true })).toHaveValue("project");
});
test("Linux não oferece autorização de desktop", { tag: "@linux" }, async ({ page }) => {
  await ready(page);
  await expect
    .poll(() => page.evaluate(async () => (await window.stag!.getSnapshot()).platform))
    .toBe("linux");
  await expect(page.getByRole("region", { name: "Controle do desktop" })).toHaveCount(0);
  await expect(
    page.getByLabel("Acesso", { exact: true }).locator('option[value="windows"]'),
  ).toHaveJSProperty("disabled", true);
});
test("erro permite reconectar e Markdown não executa HTML/imagens remotas", async ({ page }) => {
  await ready(page);
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("erro");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("alert")).toContainText("Reconecte");
  await page.getByRole("button", { name: "Reconectar", exact: true }).click();
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) remoteRequests.push(request.url());
  });
  await input.fill("html");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Texto seguro.", { exact: false })).toBeVisible();
  expect(
    await page.evaluate(() => (window as Window & { hacked?: boolean }).hacked),
  ).toBeUndefined();
  expect(remoteRequests).toEqual([]);
  await expect(page.locator(".markdown img")).toHaveCount(0);
});
test("layout amplo mantém um único painel sem overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.locator("main")).toHaveCount(1);
  await expect(page.locator("aside")).toHaveCount(0);
});

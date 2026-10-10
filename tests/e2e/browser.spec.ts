import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";
import { emptySnapshot, type Action } from "../../src/shared/types";
import { browserCaptureError } from "../../src/main/browser-capture";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
});
async function ready(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
}
test("download exibe progresso, caminho confirmado e falha sem overflow", async ({
  page,
}, info) => {
  const browser = structuredClone(emptySnapshot.browser);
  Object.assign(browser, {
    available: true,
    visible: true,
    authorized: true,
    url: "https://fixture.invalid/documentos",
    download: {
      status: "downloading",
      receivedBytes: 1024 * 1024,
      totalBytes: 4 * 1024 * 1024,
      message: "Baixando arquivo para o projeto…",
    },
  });
  browser.tabs.documentation.url = browser.url;
  await installBridge(page, { busy: true, browser });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar navegador", exact: true }).click();
  const status = page.getByRole("status", { name: "Download do navegador" });
  await expect(status).toContainText("1.0 MiB de 4.0 MiB");
  await expect(status.getByRole("progressbar")).toHaveAttribute("value", String(1024 * 1024));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-download.png` });
  await page.evaluate(() => {
    void window.stag!.getSnapshot().then((state) => {
      state.browser.download = {
        status: "completed",
        receivedBytes: 4 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024,
        path: "stag-downloads/download-sintetico/documento.pdf",
        message: "Download concluído no projeto.",
      };
      window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
    });
  });
  await expect(status).toContainText("stag-downloads/download-sintetico/documento.pdf");
  await expect(status.getByRole("progressbar")).toHaveCount(0);
  const destination = "relatorios/homologacao/retornos/" + "resultado-".repeat(7) + ".xlsx";
  await page.evaluate((path) => {
    void window.stag!.getSnapshot().then((state) => {
      state.browser.download!.path = path;
      state.browser.download!.receivedBytes = 3072;
      state.browser.download!.totalBytes = 3072;
      window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
    });
  }, destination);
  await expect(status).toContainText(destination);
  await expect(status).toContainText("3.0 KiB de 3.0 KiB");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-browser-download-destination.png`,
  });
  await page.evaluate(() => {
    void window.stag!.getSnapshot().then((state) => {
      state.browser.download = {
        status: "failed",
        receivedBytes: 0,
        totalBytes: null,
        message: "O formato recebido não corresponde à extensão do destino.",
      };
      window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
    });
  });
  await expect(status).toContainText("não corresponde à extensão");
  await expect(status).not.toContainText(destination);
  await expect(status).not.toContainText("stag-downloads/");
});
test("restaurar visualização durante execução só atualiza a área, preservando página e autorização", async ({
  page,
}, info) => {
  const browser = structuredClone(emptySnapshot.browser);
  Object.assign(browser, {
    available: true,
    visible: true,
    authorized: true,
    url: "https://fixture.invalid/docs",
    error: browserCaptureError,
  });
  browser.tabs.documentation.url = browser.url;
  await installBridge(page, { busy: true, browser });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar navegador", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Navegador do assistente" }).getByRole("alert"),
  ).toContainText(browserCaptureError);
  await page.evaluate(() => {
    const fixture = window as typeof window & { browserActions: Action[] };
    fixture.browserActions = [];
    const request = window.stag!.request;
    window.stag!.request = (action) => {
      fixture.browserActions.push(action);
      return request(action);
    };
  });
  const restore = page.getByRole("button", { name: "Restaurar visualização", exact: true });
  await expect(restore).toBeEnabled();
  await expect(page.getByRole("button", { name: "Recarregar página", exact: true })).toBeDisabled();
  await restore.click();
  const actions = await page.evaluate(
    () => (window as typeof window & { browserActions: Action[] }).browserActions,
  );
  expect(actions.length).toBeGreaterThan(0);
  expect(actions.every((action) => action.type === "browserBounds")).toBe(true);
  const last = actions.at(-1) as Extract<Action, { type: "browserBounds" }>;
  expect(last.bounds.width).toBeGreaterThan(0);
  expect(last.bounds.height).toBeGreaterThan(100);
  const state = await page.evaluate(() => window.stag!.getSnapshot());
  expect(state.busy).toBe(true);
  expect(state.browser.authorized).toBe(true);
  expect(state.browser.url).toBe(browser.url);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-restore.png` });
});
test("abas preservam endereço e rascunho, suportam teclado e descartam páginas ao revogar", async ({
  page,
}, info) => {
  await ready(page);
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  const docs = page.getByRole("tab", { name: "Documentação", exact: true });
  const system = page.getByRole("tab", { name: "Sistema do projeto", exact: true });
  const address = page.getByLabel("Endereço do navegador");
  await expect(docs).toHaveAttribute("aria-selected", "true");
  await address.fill("https://fixture.invalid/docs");
  await page.getByRole("button", { name: "Ir", exact: true }).click();
  await system.click();
  await expect(address).toHaveValue("");
  await address.fill("http://localhost:4201/");
  await docs.click();
  await expect(address).toHaveValue("https://fixture.invalid/docs");
  await docs.press("ArrowRight");
  await expect(system).toBeFocused();
  await expect(system).toHaveAttribute("aria-selected", "true");
  await expect(address).toHaveValue("http://localhost:4201/");
  await page.getByRole("button", { name: "Ir", exact: true }).click();
  await system.press("Home");
  await expect(docs).toHaveAttribute("aria-selected", "true");
  await docs.press("End");
  await expect(address).toHaveValue("http://localhost:4201/");
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-tabs.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await page.getByRole("button", { name: "Revogar navegador", exact: true }).click();
  await expect(address).toHaveValue("");
  await system.click();
  await expect(address).toHaveValue("");
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
});

test("duas abas permanecem dentro da janela mínima sem perder a conversa", async ({ page }) => {
  await ready(page);
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  for (const name of ["Documentação", "Sistema do projeto"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const bounds = (await tab.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(361);
    expect((await page.locator(".browser-viewport").boundingBox())!.height).toBeGreaterThan(150);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByRole("button", { name: "Voltar à conversa" }).click();
  await expect(page.getByLabel("Mensagem para o assistente")).toBeVisible();
});
test("sessão por projeto é opcional e esquecer revoga o controle", async ({ page }, info) => {
  await ready(page);
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  const remember = page.getByRole("checkbox", { name: "Lembrar sessões neste projeto" });
  await expect(remember).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Esquecer logins" })).toBeDisabled();
  await remember.check();
  await expect(remember).toBeChecked();
  await expect(page.getByText("Sessões salvas neste computador.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await page.getByRole("button", { name: "Fechar navegador" }).click();
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(remember).toBeChecked();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-session.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Esquecer logins" }).click();
  await expect(remember).not.toBeChecked();
});
test("navegador ao lado, endereço e fechamento preservam conversa", async ({ page }, info) => {
  await ready(page);
  for (const width of [1584, 1280, 901]) {
    await page.setViewportSize({ width, height: 900 });
    const chat = await page.locator(".app-shell").boundingBox();
    const browser = await page
      .getByRole("region", { name: "Navegador do assistente" })
      .boundingBox();
    expect(browser!.x).toBeGreaterThanOrEqual(chat!.x + chat!.width - 1);
    expect(chat!.width).toBeGreaterThanOrEqual(360);
    expect(browser!.width).toBeGreaterThanOrEqual(width * 0.6);
    expect(browser!.x + browser!.width).toBeLessThanOrEqual(width + 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.setViewportSize({ width: 1584, height: 1080 });
  expect((await page.locator(".browser-viewport").boundingBox())!.width).toBeGreaterThanOrEqual(
    1000,
  );
  await page.getByLabel("Endereço do navegador").fill("https://fixture.invalid/docs");
  await page.getByRole("button", { name: "Ir", exact: true }).click();
  await expect(page.getByLabel("Endereço do navegador")).toHaveValue(
    "https://fixture.invalid/docs",
  );
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await expect(page.getByText("Modelo autorizado · confirmações críticas")).toBeVisible();
  await page.getByLabel("Mensagem para o assistente").fill("rascunho preservado");
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-panel.png` });
  await page.getByRole("button", { name: "Fechar navegador" }).click();
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("rascunho preservado");
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("janela compacta alterna navegador e conversa, rotina segue e crítico pode ser recusado", async ({
  page,
}) => {
  await ready(page);
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByLabel("Endereço do navegador")).toBeVisible();
  await page.getByRole("button", { name: "Autorizar navegador", exact: true }).click();
  await page.getByRole("button", { name: "Voltar à conversa" }).click();
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("navegador ler documentação");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(
    page.getByText("Navegador: documentação consultada.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toHaveCount(0);
  await input.fill("navegador crítico enviar dados");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Confirmar ação no navegador?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Recusar", exact: true }).click();
  await expect(page.getByText("Navegador: ação recusada.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByText("Controle do modelo desativado")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("autorização de testes exibe origem, persiste no reload do painel e revoga durante tarefa", async ({
  page,
}, info) => {
  const browser = structuredClone(emptySnapshot.browser);
  const url = "https://sistema-homologacao.synthetic.invalid:8443/form";
  Object.assign(browser, {
    available: true,
    visible: true,
    authorized: true,
    activeTab: "system",
    url,
  });
  browser.tabs.system.url = url;
  await installBridge(page, {
    browser,
    project: { name: "Projeto sintético", path: "/synthetic/project" },
    mode: "project",
  });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar navegador", exact: true }).click();
  const control = page.getByRole("checkbox", { name: "Autorizar testes neste site" });
  await expect(control).not.toBeChecked();
  await control.check();
  await expect(page.getByText("Testes autorizados neste site", { exact: true })).toBeVisible();
  const saved = await page.evaluate(() => window.stag!.getSnapshot());
  expect(saved.browser.testOrigin).toBe(new URL(url).origin);
  await installBridge(page, { ...saved, busy: true });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar navegador", exact: true }).click();
  await expect(control).toBeChecked();
  await expect(control).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-testing.png` });
  await control.uncheck();
  await expect(control).not.toBeChecked();
  const revoked = await page.evaluate(() => window.stag!.getSnapshot());
  expect(revoked.browser.testOrigin).toBeUndefined();
  expect(revoked.busy).toBe(false);
});

test("Leitura mantém a opção de testes desabilitada", async ({ page }) => {
  const browser = structuredClone(emptySnapshot.browser);
  Object.assign(browser, {
    available: true,
    visible: true,
    authorized: true,
    activeTab: "system",
    url: "https://test.invalid",
  });
  browser.tabs.system.url = browser.url;
  await installBridge(page, {
    browser,
    project: { name: "Projeto sintético", path: "/synthetic/project" },
    mode: "read",
  });
  await page.reload();
  await page.getByRole("button", { name: "Mostrar navegador", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Autorizar testes neste site" })).toBeDisabled();
});

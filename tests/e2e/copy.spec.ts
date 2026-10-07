import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";
import fixture from "../fixtures/copy-response.json" with { type: "json" };
import { mkdir } from "node:fs/promises";

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installBridge(page, {
    connection: "ready",
    project: { path: "C:/Projetos/sintetico", name: "sintetico" },
    mode: "read",
    threadId: "synthetic-copy",
    busy: true,
    items: [
      { id: "synthetic-user", kind: "user", text: "Solicitação sintética." },
      { id: "synthetic-final", kind: "assistant", text: fixture.markdown, phase: "final_answer" },
      { id: "synthetic-other", kind: "assistant", text: fixture.other, phase: "final_answer" },
      { id: "synthetic-progress", kind: "assistant", text: fixture.progress, phase: "commentary" },
    ],
  });
  await page.goto("/");
});

test("copia cada resposta formatada e texto simples, sem mudar conversa ou rascunho", async ({
  page,
}, info) => {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("example.invalid")) remoteRequests.push(request.url());
  });
  const responses = page.locator(".assistant-message");
  await expect(responses).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Copiar resposta" })).toHaveCount(3);
  await responses.first().getByRole("button", { name: "Copiar resposta" }).scrollIntoViewIfNeeded();
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: `.local/screenshots/copy-icons-${info.project.name}.png`,
    fullPage: true,
  });
  const draft = page.getByLabel("Mensagem para o assistente");
  await draft.fill("Meu rascunho permanece.");
  const before = await page.evaluate(() => window.stag!.getSnapshot());
  const button = responses.first().getByRole("button", { name: "Copiar resposta" });
  await button.focus();
  await button.press("Enter");
  await expect(button).toHaveText("Copiado");
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return {
      html: await (await item.getType("text/html")).text(),
      text: await (await item.getType("text/plain")).text(),
    };
  });
  expect(copied.html).toContain("<h1");
  expect(copied.html).toContain("<strong");
  expect(copied.html).toContain("<ol");
  expect(copied.html).toContain("<ul");
  expect(copied.html).toContain("<table");
  expect(copied.html).toContain("<pre");
  expect(copied.html).toContain('href="https://example.invalid/docs"');
  expect(copied.html).not.toMatch(/<script|<img|<input|onclick=|class=|synthetic:synthetic/);
  expect(copied.text).toContain("Revisão aprovada com ênfase");
  expect(copied.text).toContain("1. Conferir configuração.");
  expect(copied.text).toContain("2. Validar implantação.");
  expect(copied.text).toContain("SELECT id, nome\nFROM cadastro\nWHERE id < 10;");
  expect(copied.text).toContain("Etapa\tResultado\nValidação\tOK");
  expect(copied.text).toContain("☑ Conferência concluída");
  expect(copied.text).not.toMatch(/\*\*|```|STAG|Copiar|conteúdo inerte/);
  expect(await page.evaluate(() => window.stag!.getSnapshot())).toEqual(before);
  await expect(draft).toHaveValue("Meu rascunho permanece.");
  await draft.fill("");
  await draft.focus();
  await draft.press("Control+v");
  await expect(draft).toHaveValue(copied.text);
  await expect(page.locator(".composer img")).toHaveCount(0);
  await responses.nth(1).getByRole("button", { name: "Copiar resposta" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Outra resposta separada.",
  );
  await responses.nth(2).getByRole("button", { name: "Copiar resposta" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Conferindo configuração do sistema…",
  );
  expect(remoteRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({
    path: `.local/screenshots/copy-${info.project.name}.png`,
    fullPage: true,
  });
});

test("falha de cópia é explícita e a tentativa seguinte recupera, inclusive após reload", async ({
  page,
}) => {
  const response = page.locator(".assistant-message").nth(1);
  const copy = response.getByRole("button", { name: "Copiar resposta" });
  await page.evaluate(() => {
    const original = document.execCommand.bind(document);
    document.execCommand = () => {
      document.execCommand = original;
      return false;
    };
  });
  await copy.click();
  await expect(response.getByRole("status")).toContainText("Não foi possível copiar");
  await expect(copy).toHaveText("Copiar");
  await copy.click();
  await expect(copy).toHaveText("Copiado");
  await expect(response.getByRole("status")).toHaveText("Resposta copiada com formatação.");
  await expect(copy).toHaveText("Copiar", { timeout: 4000 });
  await page.reload();
  await expect(copy).toHaveText("Copiar");
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Outra resposta separada.",
  );
});

test("preserva indentação e caracteres do código, e numeração inicial da lista", async ({
  page,
}) => {
  await installBridge(page, {
    items: [
      {
        id: "synthetic-code",
        kind: "assistant",
        text: "```text\n  primeira linha\n    <tag> & conteúdo\n```",
      },
      { id: "synthetic-list", kind: "assistant", text: "3. Terceira etapa\n4. Quarta etapa" },
    ],
  });
  await page.reload();
  const copy = page.getByRole("button", { name: "Copiar resposta" });
  await copy.first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "  primeira linha\n    <tag> & conteúdo",
  );
  await copy.nth(1).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "3. Terceira etapa\n4. Quarta etapa",
  );
});

test("não declara sucesso quando o comando não entrega o evento de cópia", async ({ page }) => {
  const copy = page.getByRole("button", { name: "Copiar resposta" }).nth(1);
  await copy.click();
  await page.evaluate(() => {
    document.execCommand = () => true;
  });
  await page.getByRole("button", { name: "Copiar resposta" }).first().click();
  await expect(page.locator(".assistant-message").first().getByRole("status")).toContainText(
    "Não foi possível copiar",
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "Outra resposta separada.",
  );
});

test("resposta retomada do histórico mantém cópia e remove feedback da conversa anterior", async ({
  page,
}) => {
  await installBridge(page);
  await page.reload();
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
  await page.getByLabel("Mensagem para o assistente").fill("Resumo sintético do sistema");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  const copy = page.getByRole("button", { name: "Copiar resposta" });
  await copy.click();
  await expect(copy).toHaveText("Copiado");
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(copy).toHaveCount(0);
  await page.getByRole("button", { name: "Histórico de conversas" }).click();
  await page.getByRole("button", { name: "Resumo sintético do sistema", exact: true }).click();
  await expect(copy).toHaveText("Copiar");
  const before = await page.evaluate(() => window.stag!.getSnapshot());
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "Pronto para o próximo passo.",
  );
  expect(await page.evaluate(() => window.stag!.getSnapshot())).toEqual(before);
});

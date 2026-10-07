import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import fixture from "../tests/fixtures/copy-response.json" with { type: "json" };

export async function validateResponseCopy(application, page) {
  const before = await page.evaluate(() => window.stag.getSnapshot());
  const snapshot = {
    ...before,
    items: [
      { id: "copy-final", kind: "assistant", phase: "final_answer", text: fixture.markdown },
      { id: "copy-other", kind: "assistant", phase: "final_answer", text: fixture.other },
      { id: "copy-progress", kind: "assistant", phase: "commentary", text: fixture.progress },
    ],
  };
  // Supply synthetic model output through the production preload's snapshot
  // channel on both OSes, without authentication or a paid model turn.
  const publish = (value) =>
    application.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send("stag:snapshot", state);
    }, value);
  await application.evaluate(({ clipboard }) => clipboard.writeText("Sentinela sintética."));
  await publish(snapshot);
  const responses = page.locator(".assistant-message");
  await expect(page.getByRole("button", { name: "Copiar resposta" })).toHaveCount(3);
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Rascunho sintético preservado.");
  const copy = responses.first().getByRole("button", { name: "Copiar resposta" });
  await copy.focus();
  await copy.press("Enter");
  await expect(copy).toHaveText("Copiado");
  const contents = await application.evaluate(async ({ clipboard }) => {
    const [item] = await clipboard.read();
    return {
      html: await (await item.getType("text/html")).text(),
      text: await (await item.getType("text/plain")).text(),
    };
  });
  assert.match(contents.html, /<h1/);
  assert.match(contents.html, /<strong/);
  assert.match(contents.html, /<ol/);
  assert.match(contents.html, /<table/);
  assert.match(contents.html, /<pre/);
  assert.match(contents.html, /href="https:\/\/example.invalid\/docs"/);
  assert.doesNotMatch(contents.html, /<script|<img|<input|onclick=|synthetic:synthetic|class=/);
  assert.match(contents.text, /1\. Conferir configuração\./);
  assert.match(contents.text, /SELECT id, nome\nFROM cadastro\nWHERE id < 10;/);
  assert.match(contents.text, /Etapa\tResultado\nValidação\tOK/);
  assert.doesNotMatch(contents.text, /\*\*|```|STAG|Copiar|conteúdo inerte/);
  await expect(input).toHaveValue("Rascunho sintético preservado.");
  await input.fill("");
  await input.focus();
  await input.press("Control+v");
  await expect(input).toHaveValue(contents.text);
  await expect(page.locator(".composer img")).toHaveCount(0);
  await page.evaluate(() => {
    const editor = document.createElement("div");
    editor.id = "synthetic-document";
    editor.contentEditable = "true";
    editor.setAttribute("role", "textbox");
    editor.setAttribute("aria-label", "Documento sintético");
    editor.style.cssText =
      "position:fixed;inset:20px;background:white;overflow:auto;z-index:10000;";
    document.body.append(editor);
  });
  try {
    const editor = page.getByRole("textbox", { name: "Documento sintético" });
    await editor.focus();
    await editor.press("Control+v");
    await expect(editor.getByRole("heading", { name: "Plano do sistema" })).toBeVisible();
    await expect(editor.locator("strong")).toHaveText("Revisão aprovada");
    await expect(editor.locator("ol > li")).toHaveCount(2);
    await expect(editor.getByRole("table")).toContainText("Validação");
    await expect(editor.locator("pre")).toContainText("WHERE id < 10;");
    await expect(editor.locator("img, input, script, button")).toHaveCount(0);
    await editor.screenshot({ path: `.local/screenshots/copy-document-${process.platform}.png` });
  } finally {
    await page.evaluate(() => document.getElementById("synthetic-document")?.remove());
  }
  await responses.nth(1).getByRole("button", { name: "Copiar resposta" }).click();
  assert.equal(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    "Outra resposta separada.",
  );
  const progress = responses.nth(2).getByRole("button", { name: "Copiar resposta" });
  await progress.click();
  await expect(progress).toHaveText("Copiado");
  snapshot.items[2].text += "\n\nNovo resultado.";
  await publish(snapshot);
  await expect(progress).toHaveText("Copiar");
  await progress.click();
  assert.match(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    /Novo resultado\.$/,
  );
  await page.evaluate(() => {
    const original = document.execCommand.bind(document);
    document.execCommand = () => {
      document.execCommand = original;
      return false;
    };
  });
  await copy.click();
  await expect(responses.first().getByRole("status")).toContainText("Não foi possível copiar");
  await expect(copy).toHaveText("Copiar");
  await copy.click();
  await expect(copy).toHaveText("Copiado");
  assert.deepEqual(await page.evaluate(() => window.stag.getSnapshot()), before);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.stag).sort()), [
    "getSnapshot",
    "onSnapshot",
    "request",
  ]);
  await input.fill("Cópia manual sintética.");
  await input.focus();
  await input.press("Control+a");
  await input.press("Control+c");
  assert.equal(
    await application.evaluate(({ clipboard }) => clipboard.readText()),
    "Cópia manual sintética.",
  );
  await input.fill("");
  await page.reload();
  await expect(responses).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.stag.getSnapshot()), before);
  console.log(
    "Cópia no Electron: HTML/texto nativos, documento editável, teclado, progresso, falha/recuperação e isolamento OK.",
  );
}

import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function validateBrowserTesting({ execute, reason, snapshot, dom, target, site }) {
  console.log(
    "Browser: formulário de teste real sem confirmações repetidas, limites e recuperação.",
  );
  const origin = new URL(site.url).origin;
  const navigate = async (tab = "system") =>
    execute({
      action: "navigate",
      tab,
      url: site.url + "testing",
      risk: "routine",
      intent: "Testar formulário sintético",
    });
  await navigate();
  let doc = await snapshot();
  const input = (label, action = "click", extra = {}) => ({
    action,
    ...target(doc, label),
    tab: "system",
    risk: "routine",
    intent: "Executar fluxo com registros sintéticos",
    ...extra,
  });
  const start = site.effects.testWrites;
  for (const [label, action, extra] of [
    ["Nome de teste", "fill", { text: "Registro criado" }],
    ["Data de teste", "fill", { text: "2026-10-12" }],
    ["Cadastrar", "click", {}],
  ]) {
    doc = await snapshot();
    const args = input(label, action, extra);
    assert.equal(await reason(args, origin), null);
    if (action === "click") assert.ok(await reason(args));
    await execute(args, origin);
  }
  await expect
    .poll(() => dom("document.querySelector('#rows').textContent"))
    .toContain("Registro criado:2026-10-12");
  doc = await snapshot();
  await execute(input("Nome de teste", "fill", { text: "Registro editado" }), origin);
  await execute(input("Salvar edição"), origin);
  await expect
    .poll(() => dom("document.querySelector('#rows').textContent"))
    .toContain("Registro editado");
  doc = await snapshot();
  await execute(input("Excluir registro de teste"), origin);
  await expect.poll(() => site.effects.testWrites).toBe(start + 3);
  await expect
    .poll(() => dom("document.querySelector('#rows').textContent"))
    .toContain('"rows":[]');
  doc = await snapshot();
  const enter = input("Nome de teste", "press", { key: "Enter" });
  assert.ok(await reason(enter));
  assert.equal(await reason(enter, origin), null);
  await execute(enter, origin);
  await expect.poll(() => site.effects.testWrites).toBe(start + 4);
  await dom(
    "window.preventTestEnter = event => { if(event.key === 'Enter') event.preventDefault(); }; document.addEventListener('keydown', window.preventTestEnter)",
  );
  doc = await snapshot();
  await execute(input("Nome de teste", "press", { key: "Enter" }), origin);
  await dom("document.removeEventListener('keydown', window.preventTestEnter)");
  assert.equal(
    site.effects.testWrites,
    start + 4,
    "Enter cancelado pela aplicação não deve enviar o formulário.",
  );
  for (const label of [
    "Publicar",
    "Pagar",
    "Segurança",
    "Enviar para terceiro",
    "Continuar",
    "Senha",
  ]) {
    doc = await snapshot();
    const args = input(label);
    assert.ok(await reason(args, origin), label);
    await assert.rejects(execute(args, origin), /autorização de testes/);
  }
  doc = await snapshot();
  assert.ok(await reason({ ...input("Cadastrar"), risk: "critical" }, origin));
  assert.ok(await reason(input("Cadastrar"), "http://127.0.0.1:1"));
  assert.equal(await reason(input("Cadastrar"), origin), null);
  // DOM inspection and execution must independently check a newly sensitive form.
  await dom(
    "document.querySelector('#testing').insertAdjacentHTML('beforeend','<input type=password hidden>')",
  );
  await assert.rejects(execute(input("Cadastrar"), origin), /autorização de testes/);
  await dom("document.querySelector('#testing input[type=password]').remove()");
  doc = await snapshot();
  assert.equal(await reason(input("Cadastrar"), origin), null);
  await execute(input("Cadastrar"), origin);
  await expect.poll(() => site.effects.testWrites).toBe(start + 5);
  await navigate("documentation");
  doc = await snapshot();
  assert.ok(await reason({ ...input("Cadastrar"), tab: "documentation" }, origin));
  await assert.rejects(
    execute({ ...input("Cadastrar"), tab: "documentation" }, origin),
    /autorização de testes/,
  );
  await navigate();
  doc = await snapshot();
  const old = input("Cadastrar");
  assert.equal(await reason(old, origin), null);
  await dom("document.querySelector('#testing').action='https://external.invalid/write'");
  await assert.rejects(execute(old, origin), /mudou|autorização de testes|alterado/);
  doc = await snapshot();
  assert.ok(await reason(input("Cadastrar"), origin));
  assert.equal(site.effects.testWrites, start + 5);
}

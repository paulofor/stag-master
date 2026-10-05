import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function validateBrowserCombos({ execute, reason, snapshot, dom, target, site }) {
  console.log(
    "Browser real: combos React nativos, ARIA, pesquisa e portal; validação e recuperação.",
  );
  await execute({
    action: "navigate",
    url: new URL("combos", site.url).href,
    risk: "routine",
    intent: "Ler combos sintéticos",
  });
  await expect.poll(() => dom("!!document.querySelector('#native')")).toBe(true);
  let doc = await snapshot();
  const select = (name, choice, source = doc) => ({
    action: "select",
    ...target(source, name),
    ...choice,
    risk: "routine",
    intent: "Escolher opção no formulário sintético local",
  });
  const click = (name, source = doc) => ({
    action: "click",
    ...target(source, name),
    risk: "routine",
    intent: "Interagir com opção sintética local",
  });
  const element = (name) => doc.elements.find((el) => el.label === name);
  assert.doesNotMatch(JSON.stringify(doc), /SYNTHETIC_INTERNAL/);
  assert.equal(element("Ambiente de teste").options[5].disabled, true);
  assert.equal(element("Lista longa").optionCount, 60);
  assert.equal(element("Lista longa").optionsTruncated, true);
  assert.equal(element("Lista longa").options.length, 50);
  assert.equal(element("Categoria sintética").role, "combobox");
  assert.equal(element("Categoria sintética").expanded, false);
  assert.ok(!doc.elements.some((el) => el.role === "option"));

  const native = select("Ambiente de teste", { label: "Desenvolvimento local" });
  assert.equal(await reason(native), null);
  await dom(
    "window.nativeEvents=[];for(const type of ['input','change']) document.querySelector('#native').addEventListener(type, event => window.nativeEvents.push(event.type))",
  );
  await execute(native);
  assert.equal(await dom("document.querySelector('#native').selectedIndex"), 1);
  await expect
    .poll(() => dom("document.querySelector('#native-changes').textContent"))
    .toBe("Alterações: 1");
  assert.deepEqual(await dom("window.nativeEvents"), ["input", "change"]);
  await execute(select("Ambiente de teste", { index: 3 }));
  assert.equal(await dom("document.querySelector('#native').selectedIndex"), 3);
  await execute(select("Ambiente de teste", { value: "SYNTHETIC_INTERNAL_INITIAL" }));
  assert.equal(await dom("document.querySelector('#native').selectedIndex"), 0);
  await execute(select("Lista longa", { label: "Opção 59" }));
  assert.equal(await dom("document.querySelector('#long').selectedIndex"), 59);
  await execute(select("Valores repetidos", { index: 2 }));
  assert.equal(await dom("document.querySelector('#duplicates').selectedIndex"), 2);

  for (const args of [
    select("Ambiente de teste", { label: "Duplicada" }),
    select("Ambiente de teste", { index: 200 }),
    select("Ambiente de teste", { label: "Não existe" }),
    select("Ambiente de teste", { index: 4 }),
    select("Ambiente de teste", { index: 5 }),
    select("Ambiente de teste", { index: 6 }),
    select("Valores repetidos", { value: "same" }),
    select("Lista múltipla", { index: 0 }),
    select("Categoria sintética", { label: "Programação" }),
  ]) {
    await assert.rejects(reason(args), /ambígua|inexistente|desabilitada|múltipla|combo nativo/);
    await assert.rejects(execute(args), /ambígua|inexistente|desabilitada|múltipla|combo nativo/);
  }
  assert.equal(await dom("document.querySelector('#native').selectedIndex"), 0);
  assert.ok(
    await reason(select("Ambiente de teste", { index: 7 })),
    "Opção crítica deve ser confirmada mesmo em combo rotineiro.",
  );
  assert.ok(
    await reason(select("Bandeira sintética", { label: "B" })),
    "Select de pagamento deve ser confirmado.",
  );
  await assert.rejects(execute(select("Seleção recusada", { index: 1 })), /não manteve a seleção/);
  await execute(select("Seleção recusada", { index: 0 }));

  await dom("document.querySelector('#native').options[1].value='SYNTHETIC_INTERNAL_CHANGED'");
  await assert.rejects(reason(native), /alvo mudou/);
  await assert.rejects(execute(native), /alvo mudou/);
  doc = await snapshot();
  await execute(select("Ambiente de teste", { label: "Desenvolvimento local" }));
  await dom("document.querySelector('#native').setAttribute('aria-readonly','true')");
  doc = await snapshot();
  await assert.rejects(reason(select("Ambiente de teste", { index: 0 })), /somente leitura/);
  await dom("document.querySelector('#native').removeAttribute('aria-readonly')");

  doc = await snapshot();
  assert.equal(await reason(click("Categoria sintética")), null);
  await execute(click("Categoria sintética"));
  await expect.poll(() => dom("!!document.querySelector('#custom-combo-list')")).toBe(true);
  doc = await snapshot();
  assert.equal(element("Categoria sintética").expanded, true);
  assert.ok(
    element("Categoria sintética").controlsRefs.includes(
      element("Opções de Categoria sintética").ref,
    ),
  );
  assert.equal(element("Programação").listboxRef, element("Opções de Categoria sintética").ref);
  assert.equal(await reason(click("Programação")), null);
  assert.ok(await reason(click("Excluir projeto sintético")));
  await assert.rejects(reason(click("Indisponível")), /desabilitado/);
  const oldOption = click("Programação");
  await execute(oldOption);
  await expect
    .poll(() => dom("document.querySelector('#custom-combo-result').textContent"))
    .toBe("Programação");
  await assert.rejects(execute(oldOption), /alvo mudou/);

  doc = await snapshot();
  await execute(click("Lista por ponteiro"));
  await expect.poll(() => dom("!!document.querySelector('#pointer-list')")).toBe(true);
  doc = await snapshot();
  await execute(click("Opção por clique"));
  await expect
    .poll(() => dom("document.querySelector('#pointer-result').textContent"))
    .toBe("Escolhida");

  doc = await snapshot();
  await execute({
    action: "fill",
    ...target(doc, "Cidade sintética"),
    text: "Curi",
    risk: "routine",
    intent: "Filtrar cidades sintéticas",
  });
  await expect.poll(() => dom("!!document.querySelector('#search-combo-list')")).toBe(true);
  doc = await snapshot();
  assert.ok(!doc.elements.some((el) => el.label === "Recife"));
  await execute(click("Curitiba"));
  await expect
    .poll(() => dom("document.querySelector('#search-combo-result').textContent"))
    .toBe("Curitiba");

  doc = await snapshot();
  await dom(
    "window.comboKeys=[];document.querySelector('#custom-combo').addEventListener('keydown', event => window.comboKeys.push(event.key))",
  );
  for (const key of ["ArrowUp", "ArrowLeft", "ArrowRight"])
    await execute({
      action: "press",
      ...target(doc, "Categoria sintética"),
      key,
      risk: "routine",
      intent: "Navegar combo sintético por teclado",
    });
  await execute({
    action: "press",
    ...target(doc, "Categoria sintética"),
    key: "ArrowDown",
    risk: "routine",
    intent: "Abrir lista sintética por teclado",
  });
  await expect.poll(() => dom("!!document.querySelector('#custom-combo-list')")).toBe(true);
  doc = await snapshot();
  const beforeOwnerChange = click("Programação");
  assert.deepEqual(await dom("window.comboKeys"), [
    "ArrowUp",
    "ArrowLeft",
    "ArrowRight",
    "ArrowDown",
  ]);
  await dom("document.querySelector('#custom-combo').setAttribute('autocomplete','cc-type')");
  await assert.rejects(execute(beforeOwnerChange), /alvo mudou/);
  doc = await snapshot();
  assert.ok(
    await reason(click("Programação")),
    "Opção em portal preserva o risco do combo associado.",
  );
  await dom("document.querySelector('#custom-combo').setAttribute('aria-disabled','true')");
  doc = await snapshot();
  await assert.rejects(reason(click("Programação")), /desabilitado/);
  await dom(
    "document.querySelector('#custom-combo').removeAttribute('aria-disabled');document.querySelector('#custom-combo').removeAttribute('autocomplete')",
  );
  doc = await snapshot();
  const beforeReplacement = click("Programação");
  await dom(
    "const list=document.querySelector('#custom-combo-list');list.replaceWith(list.cloneNode(true))",
  );
  await assert.rejects(execute(beforeReplacement), /alvo mudou/);
  doc = await snapshot();
  const beforeHidden = click("Programação");
  await dom("document.querySelector('#custom-combo-list').setAttribute('aria-hidden','true')");
  await assert.rejects(execute(beforeHidden), /alvo mudou/);
  doc = await snapshot();
  assert.ok(!doc.elements.some((el) => el.role === "option"));
  await execute({
    action: "navigate",
    url: site.url,
    risk: "routine",
    intent: "Retomar documentação sintética",
  });
  await assert.rejects(execute(beforeHidden), /página mudou/);
  assert.match((await snapshot()).text, /Documentação sintética/);
  console.log(
    "Browser real: seleção confirmada pela aplicação, opções inválidas sem efeito e recuperação aprovadas.",
  );
}

import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function validateBrowserDates({ execute, reason, snapshot, dom, target, site }) {
  console.log("Browser: calendário Angular/PrimeNG real, competências e datas nativas.");
  await execute({
    action: "navigate",
    url: new URL("dates", site.url).href,
    risk: "routine",
    intent: "Conferir datas sintéticas",
  });
  await expect.poll(() => dom("document.body.dataset.ready"), { timeout: 15000 }).toBe("true");
  let doc = await snapshot();
  const element = (name) => doc.elements.find((el) => el.label === name);
  const click = (name) => ({
    action: "click",
    ...target(doc, name),
    risk: "routine",
    intent: "Escolher data sintética",
  });
  const fill = (name, text) => ({
    action: "fill",
    ...target(doc, name),
    text,
    risk: "routine",
    intent: "Preencher data sintética",
  });
  assert.equal(element("Competência sintética").readOnly, true);
  assert.deepEqual(element("Data nativa").date, {
    format: "YYYY-MM-DD",
    min: "2024-01-01",
    max: "2028-12-31",
  });
  assert.equal(element("Mês nativo").date.format, "YYYY-MM");
  assert.doesNotMatch(JSON.stringify(doc), /SYNTHETIC_PRIVATE_DATE_SECRET/);
  assert.equal(await reason(click("Competência sintética")), null);
  await execute(click("Competência sintética"));
  await expect.poll(() => dom("document.querySelectorAll('.p-monthpicker-month').length")).toBe(12);
  doc = await snapshot();
  assert.ok(element("Set"), "Meses renderizados como spans precisam de ref.");
  assert.ok(element("Set").calendarRef);
  assert.ok(element("Competência sintética").controlsRefs.includes(element("Set").calendarRef));
  const staleMonth = click("Set");
  const next = doc.elements.find((el) => /Next Year/.test(el.label));
  assert.ok(next);
  await execute(click(next.label));
  await expect
    .poll(() => dom("document.querySelector('.p-datepicker-year').textContent.trim()"))
    .toBe("2027");
  await assert.rejects(reason(staleMonth), /alvo mudou/);
  await assert.rejects(execute(staleMonth), /alvo mudou/);
  doc = await snapshot();
  await execute(click("Choose Year"));
  await expect
    .poll(() => dom("document.querySelectorAll('.p-yearpicker-year').length"))
    .toBeGreaterThan(0);
  doc = await snapshot();
  const year = click("2026");
  assert.equal(await reason(year), null);
  assert.equal(element("2023").disabled, true);
  await assert.rejects(execute(click("2023")), /desabilitado/);
  const decadeNext = doc.elements.find((el) => /Next Decade/.test(el.label));
  assert.ok(decadeNext);
  await execute(click(decadeNext.label));
  await assert.rejects(execute(year), /alvo mudou/);
  doc = await snapshot();
  const decadeBack = doc.elements.find((el) => /Previous Decade/.test(el.label));
  assert.ok(decadeBack);
  await execute(click(decadeBack.label));
  doc = await snapshot();
  await execute(click("2026"));
  await expect.poll(() => dom("document.querySelectorAll('.p-monthpicker-month').length")).toBe(12);
  doc = await snapshot();
  const september = click("Set");
  assert.equal(await reason(september), null);
  await execute(september);
  await expect
    .poll(() => dom("document.querySelector('#month-result').textContent"))
    .toBe("09/2026");
  await assert.rejects(execute(september), /alvo mudou/);

  // The popup lives under body, outside the input's component. Its risks still follow the input.
  doc = await snapshot();
  await execute(click("Competência sintética"));
  doc = await snapshot();
  assert.ok(doc.elements.some((el) => el.selected && el.calendarRef));
  assert.equal(element("Set").selected, true);
  const beforeRisk = click("Out");
  await dom("document.querySelector('#competencia').setAttribute('autocomplete','cc-exp')");
  await assert.rejects(reason(beforeRisk), /alvo mudou/);
  doc = await snapshot();
  assert.ok(await reason(click("Out")), "Calendário deve herdar a confirmação de pagamento.");
  await dom("document.querySelector('#competencia').removeAttribute('autocomplete')");
  doc = await snapshot();
  await execute(click("Out"));
  await expect
    .poll(() => dom("document.querySelector('#month-result').textContent"))
    .toBe("10/2026");
  doc = await snapshot();
  await assert.rejects(reason(fill("Competência sintética", "11/2026")), /somente leitura/);
  await execute(click("Dia sintético"));
  await expect.poll(() => dom("!!document.querySelector('.p-datepicker-calendar')")).toBe(true);
  doc = await snapshot();
  assert.equal(element("18").disabled, true);
  assert.ok(doc.elements.some((el) => el.otherMonth === true));
  assert.equal(element("15").otherMonth, false);
  await assert.rejects(reason(click("18")), /desabilitado/);
  await assert.rejects(execute(click("18")), /desabilitado/);
  await execute(click("15"));
  await expect
    .poll(() => dom("document.querySelector('#day-result').textContent"))
    .toBe("15/09/2026");

  doc = await snapshot();
  await dom(
    "window.dateEvents=[];for(const type of ['input','change']) document.querySelector('#native-date').addEventListener(type,event=>window.dateEvents.push(event.type))",
  );
  const invalid = [
    ["Data nativa", "2026-02-30"],
    ["Data nativa", "15/09/2026"],
    ["Data nativa", "2029-01-01"],
    ["Data nativa", "2023-12-31"],
    ["Mês nativo", "2026-13"],
    ["Mês nativo", "2026-02"],
    ["Data e hora nativas", "2026-09-15T14:30Z"],
    ["Hora nativa", "07:00"],
    ["Hora nativa", "12:07"],
    ["Semana nativa", "2026-W99"],
  ];
  for (const [name, text] of invalid) {
    await assert.rejects(reason(fill(name, text)), /inválid|limites/);
    await assert.rejects(execute(fill(name, text)), /inválid|limites/);
  }
  assert.deepEqual(await dom("window.dateEvents"), []);
  assert.equal(await dom("document.querySelector('#native-date').value"), "");
  for (const [name, text, id] of [
    ["Data nativa", "2024-02-29", "native-date"],
    ["Mês nativo", "2026-09", "native-month"],
    ["Data e hora nativas", "2026-09-15T14:30", "native-datetime"],
    ["Hora nativa", "14:30", "native-time"],
    ["Semana nativa", "2026-W38", "native-week"],
  ]) {
    assert.equal(await reason(fill(name, text)), null);
    await execute(fill(name, text));
    assert.equal(await dom(`document.getElementById('${id}').value`), text);
  }
  await expect
    .poll(() => dom("document.querySelector('#native-result').textContent"))
    .toBe("2024-02-29 / 1");
  assert.deepEqual(await dom("window.dateEvents"), ["input", "change"]);
  await assert.rejects(execute(fill("Data revertida", "2026-09-15")), /não manteve a data/);
  for (const name of ["Data bloqueada", "Data somente leitura"]) {
    await assert.rejects(reason(fill(name, "2026-09-15")), /desabilitado|somente leitura/);
    await assert.rejects(execute(fill(name, "2026-09-15")), /desabilitado|somente leitura/);
  }
  const beforeLimits = fill("Data nativa", "2026-09-15");
  await dom("document.querySelector('#native-date').max='2025-01-01'");
  await assert.rejects(execute(beforeLimits), /alvo mudou/);
  await dom("document.querySelector('#native-date').max='2028-12-31'");
  doc = await snapshot();
  await execute(fill("Data nativa", "2026-09-15"));
  await expect
    .poll(() => dom("document.querySelector('#native-result').textContent"))
    .toBe("2026-09-15 / 2");
  // Accessible grids need no PrimeNG classes. Changing their heading expires identical day labels.
  await dom(
    `document.body.insertAdjacentHTML('beforeend','<button aria-haspopup="dialog" aria-controls="synthetic-calendar" aria-label="Data ARIA"></button><div id="synthetic-calendar" role="dialog" aria-label="Calendário ARIA"><h2>Setembro 2026</h2><div role="grid"><span role="gridcell" aria-selected="false" tabindex="-1">Dia ARIA</span><span role="gridcell" aria-disabled="true">Bloqueado ARIA</span></div></div>');document.querySelector('[role=gridcell]').addEventListener('click',event=>event.currentTarget.setAttribute('aria-selected','true'))`,
  );
  doc = await snapshot();
  const ariaDay = click("Dia ARIA");
  await assert.rejects(execute(click("Bloqueado ARIA")), /desabilitado/);
  await execute(ariaDay);
  doc = await snapshot();
  assert.equal(element("Dia ARIA").selected, true);
  const oldHeading = click("Dia ARIA");
  await dom("document.querySelector('#synthetic-calendar h2').textContent='Outubro 2026'");
  await assert.rejects(execute(oldHeading), /alvo mudou/);
  doc = await snapshot();
  await execute(click("Dia ARIA"));
  doc = await snapshot();
  const beforeReplacement = click("Dia ARIA");
  await dom(
    "const cell=document.querySelector('[role=gridcell]');cell.replaceWith(cell.cloneNode(true))",
  );
  await assert.rejects(execute(beforeReplacement), /alvo mudou/);
  doc = await snapshot();
  const beforeHidden = click("Dia ARIA");
  await dom("document.querySelector('#synthetic-calendar').setAttribute('aria-hidden','true')");
  await assert.rejects(execute(beforeHidden), /alvo mudou/);
  doc = await snapshot();
  assert.ok(!element("Dia ARIA"));
  console.log(
    "Browser: seleção confirmada no ngModel; limites, referências antigas, aprovação e recuperação OK.",
  );
}

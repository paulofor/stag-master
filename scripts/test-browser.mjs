import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { validateBrowserCombos } from "./test-browser-combos.mjs";
import { validateBrowserSessions } from "./test-browser-sessions.mjs";
import { validateBrowserCertificates } from "./test-browser-certificates.mjs";

export async function buildBrowserHarness(dir) {
  await build({
    entryPoints: ["src/main/browser-panel.ts"],
    outfile: join(dir, "browser-panel.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
}

export async function validateBrowser(application, dir, site, page) {
  const initialSubmissions = site.effects.submissions;
  const oversizedRejected = await application.evaluate(async ({ BrowserWindow }) => {
    const host = new BrowserWindow({
      width: 640,
      height: 600,
      show: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await host.loadURL("about:blank");
    global.browserHarness = { host, browser: new global.BrowserHarnessDriver(host) };
    const [width, height] = host.getContentSize();
    let rejected = false;
    try {
      global.browserHarness.browser.setBounds({ x: 0, y: 0, width: width + 10, height });
    } catch {
      rejected = true;
    }
    global.browserHarness.browser.setBounds({
      x: 0,
      y: 0,
      width: Math.min(850, width),
      height: Math.min(700, height),
    });
    return rejected;
  });
  assert.ok(oversizedRejected, "O navegador deve permanecer dentro da área útil da janela.");
  const execute = (args) =>
    application.evaluate(
      async (_electron, input) => global.browserHarness.browser.execute(input),
      args,
    );
  const reason = (args) =>
    application.evaluate(
      async (_electron, input) => global.browserHarness.browser.confirmationReason(input),
      args,
    );
  const snapshot = async () =>
    JSON.parse((await execute({ action: "snapshot" })).contentItems[0].text);
  const state = () => application.evaluate(() => global.browserHarness.browser.snapshot());
  const dom = (expression) =>
    application.evaluate(
      async (_electron, code) =>
        global.browserHarness.browser.view.webContents.executeJavaScript(code),
      expression,
    );
  const target = (doc, label) => {
    const ref = doc.elements.find((el) => el.label === label)?.ref;
    assert.ok(ref, `Elemento sintético ausente: ${label}`);
    return { pageId: doc.pageId, ref };
  };
  let validationError;
  try {
    console.log(
      "Browser real: navegação, texto, campos, seleções, cliques, teclas, rolagem e captura.",
    );
    await execute({ action: "navigate", url: site.url, risk: "routine", intent: "Ler fixture" });
    let doc = await snapshot();
    assert.match(doc.text, /Documentação sintética/);
    assert.doesNotMatch(JSON.stringify(doc), /SYNTHETIC_PRIVATE_FIELD|SYNTHETIC_HIDDEN_CONTENT/);
    const local = {
      action: "fill",
      ...target(doc, "Texto local"),
      text: "texto + ^ % literal",
      risk: "routine",
      intent: "Editar campo local",
    };
    assert.equal(await reason(local), null);
    await execute(local);
    assert.equal(await dom("document.querySelector('#local').value"), local.text);
    await execute({
      action: "press",
      ...target(doc, "Texto local"),
      key: "Control+A",
      risk: "routine",
      intent: "Selecionar texto local",
    });
    await execute({
      action: "select",
      ...target(doc, "Seção"),
      value: "api",
      risk: "routine",
      intent: "Selecionar seção local",
    });
    assert.equal(await dom("document.querySelector('select').value"), "api");
    const expand = {
      action: "click",
      ...target(doc, "Expandir seção"),
      risk: "routine",
      intent: "Expandir seção",
    };
    assert.equal(await reason(expand), null);
    await execute(expand);
    assert.equal(await dom("window.expansions"), 1);
    await execute({ action: "scroll", delta: 400 });
    assert.ok(await dom("scrollY > 0"));
    const image = await execute({ action: "screenshot" });
    assert.match(image.contentItems[1].imageUrl, /^data:image\/png;base64,/);
    doc = await snapshot();
    for (const [label, action, extra] of [
      ["Senha sintética", "fill", { text: "SYNTHETIC_NEW_PASSWORD" }],
      ["Pagamento sintético", "fill", { text: "0000" }],
      ["Enviar sintético", "click", {}],
    ]) {
      const critical = {
        action,
        ...target(doc, label),
        ...extra,
        risk: "routine",
        intent: "Teste sintético",
      };
      assert.ok(await reason(critical), `Controle crítico liberado: ${label}`);
    }
    await assert.rejects(
      reason({
        action: "click",
        ...target(doc, "Arquivo sintético"),
        risk: "routine",
        intent: "Abrir arquivo",
      }),
      /manual/,
    );
    await assert.rejects(
      reason({
        action: "fill",
        ...target(doc, "Campo bloqueado"),
        text: "fixture",
        risk: "routine",
        intent: "Editar",
      }),
      /desabilitado/,
    );
    const stale = {
      action: "click",
      ...target(doc, "Expandir seção"),
      risk: "routine",
      intent: "Expandir",
    };
    await dom("document.querySelector('#expand').textContent='Enviar dados alterados'");
    await assert.rejects(execute(stale), /alvo mudou/);
    doc = await snapshot();
    await execute({
      action: "click",
      ...target(doc, "Próxima página"),
      risk: "routine",
      intent: "Ler próxima página",
    });
    await expect.poll(async () => (await state()).url).toBe(new URL("next", site.url).href);
    await assert.rejects(execute(local), /página mudou/);
    await execute({ action: "back" });
    await expect.poll(async () => (await state()).url).toBe(site.url);
    await execute({ action: "forward" });
    await expect.poll(async () => (await state()).url).toBe(new URL("next", site.url).href);
    await execute({
      action: "navigate",
      url: site.url,
      risk: "routine",
      intent: "Voltar à fixture",
    });
    console.log(
      "Browser real: segurança, IPC remoto, popups/downloads, protocolos e sessão efêmera.",
    );
    await validateBrowserCombos({ execute, reason, snapshot, dom, target, site });
    assert.deepEqual(await dom("window.securityProbe"), {
      node: "undefined",
      require: "undefined",
      bridge: "undefined",
    });
    assert.equal(
      await dom(
        `new Promise(resolve => { const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws'); socket.onopen = () => { socket.close(); resolve('open'); }; socket.onerror = () => resolve('error'); })`,
      ),
      "open",
    );
    const preferences = await application.evaluate(() =>
      global.browserHarness.browser.view.webContents.getLastWebPreferences(),
    );
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.preload, undefined);
    for (const url of [
      "file:///private",
      "javascript:alert(1)",
      "stag://app/index.html",
      "https://user:pass@example.invalid/",
    ])
      await assert.rejects(
        execute({ action: "navigate", url, risk: "routine", intent: "Teste de recusa" }),
      );
    doc = await snapshot();
    await execute({
      action: "click",
      ...target(doc, "Nova janela"),
      risk: "routine",
      intent: "Abrir link sintético",
    });
    assert.match((await state()).error, /janela bloqueada/);
    await execute({
      action: "click",
      ...target(doc, "Baixar sintético"),
      risk: "routine",
      intent: "Baixar fixture",
    });
    await expect.poll(async () => (await state()).error).toMatch(/Download bloqueado/);
    await dom(
      "document.cookie='synthetic_session=fixture';localStorage.setItem('synthetic','fixture')",
    );
    await validateBrowserSessions({ application, site, execute, reason, snapshot, dom, target });
    await validateBrowserCertificates({ application, site, execute, snapshot, state, page });
    console.log("Browser real: descartar sessão sintética e recuperar navegação interrompida.");
    // Reproduce native window resizing after renderer bounds were accepted, before reset.
    const previousSize = await application.evaluate(() => {
      const host = global.browserHarness.host;
      const size = host.getContentSize();
      host.setContentSize(320, 240);
      return size;
    });
    await expect
      .poll(() => application.evaluate(() => global.browserHarness.host.getContentSize()[0]))
      .toBeLessThan(previousSize[0]);
    await application.evaluate(() => global.browserHarness.browser.reset());
    const resized = await application.evaluate(() => {
      const { host, browser } = global.browserHarness;
      const [width, height] = host.getContentSize();
      const bounds = browser.view.getBounds();
      return {
        inside: bounds.x + bounds.width <= width + 1 && bounds.y + bounds.height <= height + 1,
        visible: browser.view.getVisible(),
      };
    });
    assert.equal(resized.inside, true);
    assert.equal(resized.visible, false);
    await application.evaluate((_electron, size) => {
      const { host, browser } = global.browserHarness;
      host.setContentSize(...size);
      const [width, height] = host.getContentSize();
      browser.setBounds({ x: 0, y: 0, width, height });
    }, previousSize);
    await execute({
      action: "navigate",
      url: site.url,
      risk: "routine",
      intent: "Nova sessão sintética",
    });
    assert.equal(await dom("document.cookie"), "");
    assert.equal(await dom("localStorage.getItem('synthetic')"), null);
    // Visibility changes also revalidate stored layout, without changing the current session.
    await application.evaluate(() => {
      global.browserHarness.host.setContentSize(320, 240);
    });
    await expect
      .poll(() => application.evaluate(() => global.browserHarness.host.getContentSize()[0]))
      .toBeLessThan(previousSize[0]);
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      browser.setVisible(false);
      browser.setVisible(true);
    });
    assert.equal(
      await application.evaluate(() => global.browserHarness.browser.view.getVisible()),
      false,
    );
    await application.evaluate((_electron, size) => {
      const { host, browser } = global.browserHarness;
      host.setContentSize(...size);
      const [width, height] = host.getContentSize();
      browser.setBounds({ x: 0, y: 0, width, height });
    }, previousSize);
    assert.equal(await dom("localStorage.getItem('synthetic')"), null);
    console.log(
      "Browser real: reset/visibilidade recuperam bounds após reduzir a janela, sem aceitar bounds externos inválidos.",
    );
    assert.equal(site.effects.submissions, initialSubmissions);
    const canceled = execute({
      action: "navigate",
      url: new URL("hang", site.url).href,
      risk: "routine",
      intent: "Carga sintética interrompida",
    }).then(
      () => null,
      (error) => error,
    );
    await expect.poll(async () => (await state()).loading).toBe(true);
    await application.evaluate(() => global.browserHarness.browser.cancel());
    assert.ok(await canceled, "Navegação interrompida não deveria concluir com sucesso.");
    await execute({
      action: "navigate",
      url: site.url,
      risk: "routine",
      intent: "Recuperar carga",
    });
    assert.match((await snapshot()).text, /Documentação sintética/);
    doc = await snapshot();
    console.log("Browser real: cancelar tecla pendente ao trocar sessão durante o foco.");
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      const document = browser.document.bind(browser);
      browser.document = async (request) => {
        const result = await document(request);
        if (request.action === "focus")
          await new Promise((resolve) => {
            global.focusWaiting = true;
            global.releaseFocus = resolve;
          });
        return result;
      };
      global.keyboardEffects = [];
      browser.view.webContents.sendInputEvent = (event) => global.keyboardEffects.push(event);
    });
    const keyAction = execute({
      action: "press",
      ...target(doc, "Texto local"),
      key: "Enter",
      risk: "critical",
      intent: "Tecla aprovada em sessão sintética antiga",
    }).then(
      () => null,
      (error) => error,
    );
    await expect.poll(() => application.evaluate(() => global.focusWaiting)).toBe(true);
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      browser.reset();
      browser.view.webContents.sendInputEvent = (event) => global.keyboardEffects.push(event);
      global.releaseFocus();
    });
    assert.match((await keyAction).message, /cancelada/);
    assert.deepEqual(await application.evaluate(() => global.keyboardEffects), []);
    console.log("Browser real: driver de produção e dados sintéticos aprovados.");
  } catch (error) {
    validationError = error;
    throw error;
  } finally {
    try {
      await application.evaluate(() => {
        global.browserHarness.browser.dispose();
        global.browserHarness.host.destroy();
        delete global.browserHarness;
      });
    } catch (error) {
      if (!validationError) throw error;
      console.error(
        "Browser harness: limpeza falhou após o erro de validação; causa original preservada.",
      );
    }
  }
}

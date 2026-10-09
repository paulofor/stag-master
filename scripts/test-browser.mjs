import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { validateBrowserCombos } from "./test-browser-combos.mjs";
import { validateBrowserSessions } from "./test-browser-sessions.mjs";
import { validateBrowserCertificates } from "./test-browser-certificates.mjs";
import { startBrowserTlsSite } from "../tests/fixtures/browser-tls.mjs";
import { validateBrowserVisibility } from "./test-browser-visibility.mjs";
import { validateBrowserCapture } from "./test-browser-capture.mjs";

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

async function validateBrowserTabs({
  application,
  site,
  execute,
  reason,
  snapshot,
  state,
  dom,
  target,
  page,
}) {
  const tls = await startBrowserTlsSite();
  const navigate = (tab, url = site.url) =>
    execute({ action: "navigate", tab, url, risk: "routine", intent: "Conferir aba sintética" });
  try {
    await application.evaluate(() => global.browserHarness.browser.reset(null));
    await navigate("documentation");
    const docs = await snapshot();
    assert.equal(docs.tab, "documentation");
    const docsEdit = {
      action: "fill",
      ...target(docs, "Texto local"),
      tab: "documentation",
      text: "rascunho documentação",
      risk: "routine",
      intent: "Editar campo sintético",
    };
    await execute(docsEdit);
    await dom(
      "document.cookie='synthetic_tab=documentation';localStorage.setItem('tab','documentation')",
    );
    await navigate("system");
    assert.equal(await dom("document.cookie"), "");
    assert.equal(await dom("localStorage.getItem('tab')"), null);
    const system = await snapshot();
    assert.equal(system.tab, "system");
    assert.notEqual(system.pageId, docs.pageId);
    await execute({
      ...docsEdit,
      ...target(system, "Texto local"),
      tab: "system",
      text: "rascunho sistema",
    });
    await dom("document.cookie='synthetic_tab=system';localStorage.setItem('tab','system')");
    await assert.rejects(execute({ ...docsEdit, tab: "system" }), /página mudou/);
    await assert.rejects(reason({ ...docsEdit, tab: "system" }), /página mudou/);
    assert.equal(await dom("document.querySelector('#local').value"), "rascunho sistema");
    await execute({ action: "snapshot", tab: "documentation" });
    assert.equal(await dom("document.querySelector('#local').value"), "rascunho documentação");
    assert.equal(await dom("localStorage.getItem('tab')"), "documentation");
    assert.match(await dom("document.cookie"), /documentation/);
    assert.equal((await state()).tabs.system.url, site.url);
    await navigate("documentation", `${site.url}next`);
    await execute({ action: "back", tab: "documentation" });
    await expect.poll(async () => (await state()).tabs.documentation.url).toBe(site.url);
    assert.equal((await state()).tabs.system.url, site.url);
    await execute({ action: "snapshot", tab: "system" });
    assert.equal(await dom("document.querySelector('#local').value"), "rascunho sistema");
    const shot = await execute({ action: "screenshot", tab: "system" });
    assert.match(shot.contentItems[0].text, /Sistema do projeto/);
    assert.match(shot.contentItems[1].imageUrl, /^data:image\/png;base64,/);
    await assert.rejects(execute({ action: "snapshot", tab: "other" }));
    assert.equal((await state()).activeTab, "system");
    await assert.rejects(navigate("documentation", tls.url), /ERR_CERT_AUTHORITY_INVALID/);
    const failed = await state();
    assert.match(failed.tabs.documentation.error, /ERR_CERT_AUTHORITY_INVALID/);
    assert.equal(failed.tabs.system.error, null);
    await execute({ action: "snapshot", tab: "system" });
    assert.equal(await dom("document.querySelector('#local').value"), "rascunho sistema");
    await navigate("documentation");
    const canceled = navigate("system", `${site.url}hang`).then(
      () => null,
      (error) => error,
    );
    await expect.poll(async () => (await state()).tabs.system.loading).toBe(true);
    await application.evaluate(() => global.browserHarness.browser.selectTab("documentation"));
    await application.evaluate(() => global.browserHarness.browser.cancel());
    assert.ok(await canceled, "Cancelar deve interromper a carga da aba oculta.");
    await navigate("system");
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      global.oldTabFailures = Object.values(browser.pages).map(
        (tab) => tab.view.webContents.listeners("did-fail-load")[0],
      );
      browser.reset();
      for (const failure of global.oldTabFailures)
        failure({}, -202, "SYNTHETIC_OLD_ERROR", "", true);
      delete global.oldTabFailures;
    });
    for (const tab of ["documentation", "system"]) {
      assert.equal((await state()).tabs[tab].url, "");
      assert.equal((await state()).tabs[tab].error, null);
      await navigate(tab);
      assert.equal(await dom("document.cookie"), "");
      assert.equal(await dom("localStorage.getItem('tab')"), null);
      assert.deepEqual(await dom("window.securityProbe"), {
        node: "undefined",
        require: "undefined",
        bridge: "undefined",
      });
    }
    // A partial deletion is reported and remains retryable for both persistent partitions.
    const profile = "00000000-0000-4000-8000-000000000039";
    await application.evaluate(
      (_electron, id) => global.browserHarness.browser.setProfile(id),
      profile,
    );
    for (const tab of ["documentation", "system"]) {
      await navigate(tab, `${site.url}session-login`);
      await dom(
        "document.querySelector('#remember').checked=true;document.querySelector('form').requestSubmit()",
      );
      await expect
        .poll(() => dom("document.querySelector('h1')?.textContent"))
        .toBe("Conectado sintético");
    }
    await application.evaluate(() => {
      global.failedTabSession = global.browserHarness.browser.view.webContents.session;
      global.restoreTabClear = global.failedTabSession.clearData.bind(global.failedTabSession);
      global.failedTabSession.clearData = async () => {
        throw new Error("Falha sintética na segunda partição");
      };
    });
    await assert.rejects(
      application.evaluate(() => global.browserHarness.browser.clearProfile()),
      /Não foi possível apagar todos/,
    );
    await navigate("system", `${site.url}session-login`);
    assert.equal(await dom("document.querySelector('h1')?.textContent"), "Conectado sintético");
    await navigate("documentation", `${site.url}session-login`);
    assert.equal(await dom("document.querySelector('h1')?.textContent"), "Login necessário");
    await application.evaluate(() => {
      global.failedTabSession.clearData = global.restoreTabClear;
      delete global.failedTabSession;
      delete global.restoreTabClear;
    });
    await application.evaluate(() => global.browserHarness.browser.clearProfile());
    await application.evaluate(
      (_electron, id) => global.browserHarness.browser.setProfile(id),
      profile,
    );
    for (const tab of ["documentation", "system"]) {
      await navigate(tab, `${site.url}session-login`);
      assert.equal(await dom("document.querySelector('h1')?.textContent"), "Login necessário");
    }
    // The actual renderer/preload/main can select and retain both native pages, including reload.
    await page.evaluate(async (url) => {
      await window.stag.request({ type: "browserVisibility", visible: true });
      await window.stag.request({
        type: "browserControl",
        control: { action: "navigate", tab: "documentation", url },
      });
      await window.stag.request({
        type: "browserControl",
        control: { action: "navigate", tab: "system", url: `${url}next` },
      });
    }, site.url);
    await expect(
      page.getByRole("tab", { name: "Sistema do projeto", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Documentação", exact: true }).click();
    await expect(page.getByLabel("Endereço do navegador")).toHaveValue(site.url);
    await page.reload();
    await expect(page.getByRole("tab", { name: "Documentação", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "Sistema do projeto", exact: true }).click();
    await expect(page.getByLabel("Endereço do navegador")).toHaveValue(`${site.url}next`);
    const mainPageId = await application.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith("stag://app/"),
      );
      const view = main.contentView.children.find((view) =>
        view.webContents?.getURL().endsWith("/next"),
      );
      // Simulate a lost native presentation without losing the document or session.
      view.setVisible(false);
      return view.webContents.id;
    });
    await page.getByRole("button", { name: "Restaurar visualização", exact: true }).click();
    await expect
      .poll(() =>
        application.evaluate(({ BrowserWindow }, id) => {
          const main = BrowserWindow.getAllWindows().find((window) =>
            window.webContents.getURL().startsWith("stag://app/"),
          );
          return main.contentView.children
            .find((view) => view.webContents?.id === id)
            ?.getVisible();
        }, mainPageId),
      )
      .toBe(true);
    await expect
      .poll(() =>
        application.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].contentView.children.filter(
              (view) => view.webContents && view.getVisible(),
            ).length,
        ),
      )
      .toBe(1);
    await page.screenshot({ path: ".local/screenshots/electron-browser-tabs.png" });
    await page.evaluate(() => window.stag.request({ type: "browserVisibility", visible: false }));
    const closed = await page.evaluate(async () => (await window.stag.getSnapshot()).browser);
    assert.equal(closed.authorized, false);
    assert.equal(closed.tabs.documentation.url, "");
    assert.equal(closed.tabs.system.url, "");
    await application.evaluate(() => global.browserHarness.browser.reset(null));
    await navigate("documentation");
    console.log(
      "Browser real: duas abas, refs cruzadas, estado/histórico/armazenamento isolados, TLS, cancelamento, reload e descarte aprovados.",
    );
  } finally {
    await tls.close();
  }
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
    await validateBrowserVisibility({ application, site, execute, snapshot, state, dom });
    await validateBrowserCapture({ application, site, execute, snapshot, state, dom });
    await validateBrowserTabs({
      application,
      site,
      execute,
      reason,
      snapshot,
      state,
      dom,
      target,
      page,
    });
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
      const panel = global.browserHarness.browser;
      const browser = panel.pages[panel.snapshot().activeTab];
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

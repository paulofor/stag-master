import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect } from "@playwright/test";

// The same production driver used by the application, with loopback-only synthetic data.
export async function validateBrowserSessions({
  application,
  site,
  execute,
  reason,
  snapshot,
  dom,
  target,
}) {
  const profileA = randomUUID();
  const profileB = randomUUID();
  const profile = (id) =>
    application.evaluate((_electron, id) => global.browserHarness.browser.setProfile(id), id);
  const reset = () => application.evaluate(() => global.browserHarness.browser.reset());
  const navigate = () =>
    execute({
      action: "navigate",
      url: `${site.url}session-login`,
      risk: "routine",
      intent: "Ler login sintético",
    });
  const loggedIn = () => dom("document.querySelector('h1').textContent");
  const login = async () => {
    await dom(
      "document.querySelector('#remember').checked=true;document.querySelector('form').requestSubmit()",
    );
    await expect.poll(loggedIn).toBe("Conectado sintético");
  };
  await profile(profileA);
  await navigate();
  let doc = await snapshot();
  const remember = {
    action: "click",
    ...target(doc, "Continuar conectado"),
    risk: "routine",
    intent: "Manter login de teste",
  };
  assert.equal(doc.elements.find((el) => el.label === "Continuar conectado").checked, false);
  assert.equal(doc.elements.find((el) => el.label === "Perfil sintético").checked, true);
  assert.equal(doc.elements.find((el) => el.label === "Preferência mista").checked, "mixed");
  assert.equal(doc.elements.find((el) => el.label === "Tema sintético").checked, false);
  assert.doesNotMatch(JSON.stringify(doc), /SYNTHETIC_PRIVATE_CHECKBOX/);
  assert.match(await reason(remember), /manter o login/);
  // A refused action performs no write; then a manually changed target expires the approval.
  assert.equal(await dom("document.querySelector('#remember').checked"), false);
  await dom("document.querySelector('#remember').checked=true");
  await assert.rejects(execute(remember), /alvo mudou/);
  doc = await snapshot();
  assert.equal(doc.elements.find((el) => el.label === "Continuar conectado").checked, true);
  await execute({ ...remember, ...target(doc, "Continuar conectado") });
  doc = await snapshot();
  assert.equal(doc.elements.find((el) => el.label === "Continuar conectado").checked, false);
  await execute({
    action: "click",
    ...target(doc, "Tema sintético"),
    risk: "routine",
    intent: "Trocar tema local",
  });
  assert.equal(
    (await snapshot()).elements.find((el) => el.label === "Tema sintético").checked,
    true,
  );
  await login();
  await dom("localStorage.setItem('synthetic_preference','project-A')");
  assert.equal(await dom("document.cookie"), "", "Cookie HttpOnly não é lido pelo DOM.");
  await reset();
  await assert.rejects(execute(remember), /página mudou/);
  await navigate();
  assert.equal(await loggedIn(), "Conectado sintético");
  assert.equal(await dom("localStorage.getItem('synthetic_preference')"), "project-A");
  assert.deepEqual(await dom("window.securityProbe"), {
    node: "undefined",
    require: "undefined",
    bridge: "undefined",
  });
  const listenerCount = await application.evaluate(() =>
    global.browserHarness.browser.view.webContents.session.listenerCount("will-download"),
  );
  await reset();
  assert.equal(
    await application.evaluate(() =>
      global.browserHarness.browser.view.webContents.session.listenerCount("will-download"),
    ),
    listenerCount,
  );
  await profile(profileB);
  await navigate();
  assert.equal(await loggedIn(), "Login necessário");
  assert.equal(await dom("localStorage.getItem('synthetic_preference')"), null);
  await dom("localStorage.setItem('synthetic_preference','project-B')");
  await profile(profileA);
  await navigate();
  assert.equal(await loggedIn(), "Conectado sintético");
  // Inject cleanup failure in the real Electron session; keep the profile available to retry.
  await application.evaluate(() => {
    const session = global.browserHarness.browser.view.webContents.session;
    global.restoreClearData = session.clearData.bind(session);
    session.clearData = async () => {
      throw new Error("Falha sintética");
    };
    global.failedSession = session;
  });
  await assert.rejects(
    application.evaluate(() => global.browserHarness.browser.clearProfile()),
    /Não foi possível apagar/,
  );
  await application.evaluate(() => {
    global.failedSession.clearData = global.restoreClearData;
  });
  await navigate();
  assert.equal(await loggedIn(), "Conectado sintético");
  await application.evaluate(() => global.browserHarness.browser.clearProfile());
  // Even reusing the old identifier cannot recover forgotten data.
  await profile(profileA);
  await navigate();
  assert.equal(await loggedIn(), "Login necessário");
  assert.equal(await dom("localStorage.getItem('synthetic_preference')"), null);
  await profile(profileB);
  await navigate();
  assert.equal(await dom("localStorage.getItem('synthetic_preference')"), "project-B");
  await application.evaluate(() => global.browserHarness.browser.clearProfile());
  await navigate();
  await login();
  await reset();
  await navigate();
  assert.equal(await loggedIn(), "Login necessário", "Modo temporário continua descartável.");
  await execute({
    action: "navigate",
    url: site.url,
    risk: "routine",
    intent: "Retomar regressões",
  });
  console.log(
    "Browser real: estados checked, consentimento, sessão persistente, isolamento, exclusão e recuperação OK.",
  );
}

export async function validateSavedSession(application, page, site, phase) {
  const state = () => page.evaluate(() => window.stag.getSnapshot());
  const projectPath = (await state()).project.path;
  const remember = (value) =>
    page.evaluate((action) => window.stag.request(action), {
      type: "browserSession",
      projectPath,
      remember: value,
    });
  const navigate = () =>
    page.evaluate(
      (url) =>
        window.stag.request({ type: "browserControl", control: { action: "navigate", url } }),
      `${site.url}session-login`,
    );
  const dom = (expression) =>
    application.evaluate(async ({ BrowserWindow }, code) => {
      const parent = BrowserWindow.getAllWindows()[0];
      const view = parent.contentView.children.find(
        (child) => child.webContents && child.webContents !== parent.webContents,
      );
      return view.webContents.executeJavaScript(code);
    }, expression);
  const connected = () => dom("document.querySelector('h1')?.textContent");
  const dialog = (response) =>
    application.evaluate(({ dialog }, response) => {
      dialog.showMessageBox = async () => ({ response });
    }, response);
  if (phase === "prepare") {
    await dialog(0);
    await remember(true);
    assert.equal((await state()).browser.remember, false, "Cancelar não ativa persistência.");
    await application.evaluate(({ dialog }) => {
      global.sessionDialogWaiting = false;
      dialog.showMessageBox = () =>
        new Promise((resolve) => {
          global.sessionDialogWaiting = true;
          global.resolveSessionDialog = resolve;
        });
    });
    const pending = remember(true).then(
      () => null,
      (error) => error,
    );
    await expect.poll(() => application.evaluate(() => global.sessionDialogWaiting)).toBe(true);
    await page.evaluate(() => window.stag.request({ type: "newChat" }));
    await application.evaluate(() => global.resolveSessionDialog({ response: 1 }));
    assert.match((await pending).message, /conversa mudou/);
    assert.equal((await state()).browser.remember, false);
    await dialog(1);
    await page.getByRole("button", { name: "Mostrar navegador" }).click();
    // The controlled checkbox changes only after the native dialog and durable save acknowledge.
    await page.getByRole("checkbox", { name: "Lembrar sessões neste projeto" }).click();
    await expect.poll(async () => (await state()).browser.remember).toBe(true);
    await navigate();
    await dom(
      "document.querySelector('#remember').checked=true;document.querySelector('form').requestSubmit()",
    );
    await expect.poll(connected).toBe("Conectado sintético");
    await dom("localStorage.setItem('synthetic_restart','SYNTHETIC_PRIVATE_STORAGE')");
    for (const action of [
      { type: "browserVisibility", visible: false },
      { type: "newChat" },
      { type: "browserConsent", allow: false },
    ]) {
      await page.evaluate((action) => window.stag.request(action), action);
      assert.equal((await state()).browser.authorized, false);
      assert.equal((await state()).browser.remember, true);
      await navigate();
      assert.equal(await connected(), "Conectado sintético");
    }
    assert.doesNotMatch(JSON.stringify(await state()), /synthetic_login|SYNTHETIC_PRIVATE_STORAGE/);
    return;
  }
  assert.equal((await state()).browser.remember, true);
  assert.equal((await state()).browser.authorized, false);
  await navigate();
  if (phase === "forgotten") {
    assert.equal(await connected(), "Login necessário");
    assert.equal(await dom("localStorage.getItem('synthetic_restart')"), null);
    console.log(
      "Sessão Electron reiniciada: exclusão confirmada em disco, sem herdar consentimento.",
    );
    return;
  }
  assert.equal(await connected(), "Conectado sintético");
  assert.equal(await dom("localStorage.getItem('synthetic_restart')"), "SYNTHETIC_PRIVATE_STORAGE");
  await dialog(0);
  await remember(false);
  assert.equal((await state()).browser.remember, true);
  assert.equal(await connected(), "Conectado sintético");
  await dialog(1);
  await remember(false);
  assert.equal((await state()).browser.remember, false);
  await navigate();
  assert.equal(await connected(), "Login necessário");
  await remember(true);
  await navigate();
  assert.equal(await connected(), "Login necessário");
  assert.equal(await dom("localStorage.getItem('synthetic_restart')"), null);
  console.log(
    "Sessão Electron: cookie HttpOnly e preferência sobrevivem ao reinício; Esquecer logins limpa ambos.",
  );
}

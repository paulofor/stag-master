import assert from "node:assert/strict";
import { expect } from "@playwright/test";

// Exercises the production view, not just the DOM that remains readable while hidden.
export async function validateBrowserVisibility({
  application,
  site,
  execute,
  snapshot,
  state,
  dom,
}) {
  await execute({ action: "navigate", url: site.url, risk: "routine", intent: "Página sintética" });
  await dom("document.querySelector('#local').value='rascunho preservado'");
  const before = await application.evaluate(() => {
    const { host, browser } = global.browserHarness;
    // Native frame/menu insets can settle after the first load; measure the ready host.
    const size = host.getContentSize();
    browser.setBounds({ x: 0, y: 0, width: size[0], height: size[1] });
    return { size, id: browser.view.webContents.id };
  });
  // The renderer can retain the same layout across minimization/native size changes.
  // A tool call in that interval must not permanently erase the accepted viewport.
  await application.evaluate(() => global.browserHarness.host.setContentSize(320, 240));
  await expect
    .poll(() => application.evaluate(() => global.browserHarness.host.getContentSize()[0]))
    .toBe(320);
  assert.match((await snapshot()).text, /Documentação sintética/);
  assert.equal(
    await application.evaluate(() => global.browserHarness.browser.view.getVisible()),
    false,
  );
  await application.evaluate(
    (_electron, size) => global.browserHarness.host.setContentSize(...size),
    before.size,
  );
  await expect
    .poll(() => application.evaluate(() => global.browserHarness.browser.view.getVisible()))
    .toBe(true);
  assert.equal(
    await application.evaluate(() => global.browserHarness.browser.view.webContents.id),
    before.id,
  );
  assert.equal(await dom("document.querySelector('#local').value"), "rascunho preservado");
  const rendered = await application.evaluate(async () => {
    const image = await global.browserHarness.browser.view.webContents.capturePage();
    const pixels = image.toBitmap();
    let ink = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index] < 200 || pixels[index + 1] < 200 || pixels[index + 2] < 200) ink++;
    return { empty: image.isEmpty(), ink };
  });
  assert.equal(rendered.empty, false);
  assert.ok(
    rendered.ink > 100,
    "A página sintética restaurada deve produzir pixels além do fundo branco.",
  );

  const accepted = await application.evaluate(() => global.browserHarness.browser.view.getBounds());
  for (const event of ["restore", "show"]) {
    await application.evaluate((_electron, event) => {
      const { host, browser } = global.browserHarness;
      browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      host.emit(event);
    }, event);
    assert.equal(
      await application.evaluate(() => global.browserHarness.browser.view.getVisible()),
      false,
      "Restaurar janela não revela página oculta por diálogo/conversa compacta.",
    );
  }
  await application.evaluate(
    (_electron, bounds) => global.browserHarness.browser.setBounds(bounds),
    accepted,
  );
  // A timeout uses the real slow loopback endpoint; advance only after the HTTP handshake.
  const hangs = site.effects.hangs;
  await application.evaluate((_electron, url) => {
    const original = global.setTimeout;
    global.setTimeout = (callback, ms, ...args) => {
      const timer = original(callback, ms, ...args);
      if (ms === 30000)
        global.fireBrowserTimeout = () => {
          clearTimeout(timer);
          callback(...args);
        };
      return timer;
    };
    try {
      global.browserTimeoutResult = global.browserHarness.browser
        .execute({
          action: "navigate",
          url,
          risk: "routine",
          intent: "Timeout sintético",
        })
        .then(
          () => null,
          (error) => error.message,
        );
    } finally {
      global.setTimeout = original;
    }
  }, `${site.url}hang`);
  await expect.poll(() => site.effects.hangs).toBe(hangs + 1);
  const failure = await application.evaluate(async () => {
    global.fireBrowserTimeout();
    const result = await global.browserTimeoutResult;
    delete global.fireBrowserTimeout;
    delete global.browserTimeoutResult;
    return result;
  });
  assert.match(failure, /demorou/);
  assert.equal(
    (await state()).error,
    failure,
    "Timeout deve aparecer na aba, além do erro da ferramenta.",
  );
  await execute({
    action: "navigate",
    url: site.url,
    risk: "routine",
    intent: "Recuperação sintética",
  });
  assert.equal((await state()).error, null);
  assert.match((await snapshot()).text, /Documentação sintética/);
  // A failed capture can recover on the next read without replaying navigation/actions.
  const captureFailure = await application.evaluate(async () => {
    const browser = global.browserHarness.browser;
    const contents = browser.view.webContents;
    const capture = contents.capturePage;
    const timer = global.setTimeout;
    let expire;
    try {
      contents.capturePage = () => new Promise(() => {});
      global.setTimeout = (callback, ms, ...args) => {
        const handle = timer(callback, ms, ...args);
        if (ms === 30000)
          expire = () => {
            clearTimeout(handle);
            callback(...args);
          };
        return handle;
      };
      const pending = browser.execute({ action: "screenshot" }).then(
        () => null,
        (error) => error.message,
      );
      global.setTimeout = timer;
      expire();
      return await pending;
    } finally {
      contents.capturePage = capture;
      global.setTimeout = timer;
    }
  });
  assert.match(captureFailure, /demorou/);
  assert.equal((await state()).error, captureFailure);
  assert.match((await snapshot()).text, /Documentação sintética/);
  assert.equal((await state()).error, null);
  await application.evaluate(() => {
    global.browserHarness.browser.view.webContents.forcefullyCrashRenderer();
  });
  await expect.poll(async () => (await state()).error).toMatch(/encerrou/);
  await assert.rejects(snapshot(), /encerrou/);
  await assert.rejects(execute({ action: "screenshot" }), /encerrou/);
  await execute({
    action: "navigate",
    url: site.url,
    risk: "routine",
    intent: "Recuperação após falha sintética",
  });
  assert.match((await snapshot()).text, /Documentação sintética/);
  console.log(
    "Browser real: visualização restaurada sem reload, rascunho preservado, timeout/crash e recuperação aprovados.",
  );
}

import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

export async function validateBrowserCapture({ application, site, execute, snapshot, state, dom }) {
  const navigate = () =>
    execute({ action: "navigate", url: site.url, intent: "Captura sintética", risk: "routine" });
  await navigate();
  await dom(
    "document.querySelector('#local').value='rascunho da captura';document.cookie='capture=synthetic'",
  );
  const initialId = await application.evaluate(
    () => global.browserHarness.browser.view.webContents.id,
  );
  // First capture fails in Chromium's compositor; the following call still uses the real API.
  for (const failure of ["UnknownVizError", "empty"]) {
    const recovered = await application.evaluate(async ({ nativeImage }, failure) => {
      const { browser } = global.browserHarness;
      const contents = browser.view.webContents;
      const capture = contents.capturePage;
      let calls = 0;
      const throttling = contents.getBackgroundThrottling();
      try {
        contents.capturePage = (...args) => {
          calls++;
          if (calls === 1)
            return failure === "empty"
              ? Promise.resolve(nativeImage.createEmpty())
              : Promise.reject(new Error(failure));
          return capture.apply(contents, args);
        };
        const result = await browser.execute({ action: "screenshot" });
        const image = nativeImage.createFromDataURL(result.contentItems[1].imageUrl);
        return {
          calls,
          empty: image.isEmpty(),
          restored: contents.getBackgroundThrottling() === throttling,
          error: browser.snapshot().error,
        };
      } finally {
        contents.capturePage = capture;
      }
    }, failure);
    assert.deepEqual(recovered, { calls: 2, empty: false, restored: true, error: null });
  }
  assert.equal(await dom("document.querySelector('#local').value"), "rascunho da captura");
  assert.match(await dom("document.cookie"), /capture=synthetic/);
  assert.equal(
    await application.evaluate(() => global.browserHarness.browser.view.webContents.id),
    initialId,
  );

  for (const failure of ["UnknownVizError", "SYNTHETIC_SECRET https://private.invalid"]) {
    const failed = await application.evaluate(async (_electron, failure) => {
      const browser = global.browserHarness.browser;
      const contents = browser.view.webContents;
      const capture = contents.capturePage;
      let calls = 0;
      try {
        contents.capturePage = async () => {
          calls++;
          throw new Error(failure);
        };
        const message = await browser.execute({ action: "screenshot" }).then(
          () => null,
          (e) => e.message,
        );
        return { calls, message, state: browser.snapshot() };
      } finally {
        contents.capturePage = capture;
      }
    }, failure);
    assert.equal(failed.calls, failure === "UnknownVizError" ? 3 : 1);
    assert.match(failed.message, /Não foi possível capturar/);
    assert.doesNotMatch(failed.message, /UnknownVizError|SYNTHETIC_SECRET|private.invalid/);
    assert.equal(failed.state.tabs.documentation.error, failed.message);
    assert.equal(failed.state.tabs.system.error, null);
    assert.match((await snapshot()).text, /Documentação sintética/);
    await execute({ action: "screenshot" });
    assert.equal((await state()).error, null);
  }

  // Cancel while native capture is pending, then deliver the old failure/result.
  for (const change of ["cancel", "navigate", "reset"]) {
    console.log(`Browser real: cancelar captura pendente por ${change}.`);
    const canceled = await application.evaluate(
      async (_electron, { change, url }) => {
        const browser = global.browserHarness.browser;
        const contents = browser.view.webContents;
        const capture = contents.capturePage;
        let release,
          calls = 0;
        try {
          contents.capturePage = () => {
            calls++;
            return new Promise((_resolve, reject) => {
              release = reject;
            });
          };
          const result = browser.execute({ action: "screenshot" }).then(
            () => null,
            (error) => error.message,
          );
          if (change === "navigate")
            await browser.execute({
              action: "navigate",
              url: `${url}next`,
              risk: "routine",
              intent: "Navegação sintética",
            });
          else browser[change]();
          const message = await result;
          release(new Error("UnknownVizError"));
          return {
            message,
            calls,
            error: browser.snapshot().error,
            restored: contents.isDestroyed() || contents.getBackgroundThrottling(),
          };
        } finally {
          if (!contents.isDestroyed()) contents.capturePage = capture;
        }
      },
      { change, url: site.url },
    );
    assert.match(canceled.message, /cancelada/);
    assert.equal(canceled.calls, 1);
    assert.equal(canceled.error, null);
    assert.equal(canceled.restored, true);
    await navigate();
    await execute({ action: "screenshot" });
  }

  // Captures must not reveal a view hidden by a dialog/compact conversation or focus the host.
  const hidden = await application.evaluate(async () => {
    const { browser, host } = global.browserHarness;
    const bounds = browser.view.getBounds();
    const contents = browser.view.webContents;
    const capture = contents.capturePage;
    let calls = 0;
    contents.capturePage = (...args) => {
      calls++;
      return capture.apply(contents, args);
    };
    browser.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    host.hide();
    try {
      const result = await browser.execute({ action: "screenshot" }).then(
        () => null,
        (error) => error.message,
      );
      return {
        message: result,
        calls,
        visible: browser.view.getVisible(),
        hostVisible: host.isVisible(),
        focused: host.isFocused(),
      };
    } finally {
      contents.capturePage = capture;
      host.show();
      browser.setBounds(bounds);
    }
  });
  assert.match(hidden.message, /deixe.*visíveis/);
  assert.equal(hidden.calls, 0);
  assert.equal(hidden.visible, false);
  assert.equal(hidden.hostVisible, false);
  assert.equal(hidden.focused, false);
  assert.match((await snapshot()).text, /Documentação sintética/);
  await execute({ action: "screenshot" });
  assert.equal((await state()).error, null);
  if (process.platform === "win32") {
    await application.evaluate(() => global.browserHarness.host.minimize());
    await expect
      .poll(() => application.evaluate(() => global.browserHarness.host.isMinimized()))
      .toBe(true);
    await assert.rejects(execute({ action: "screenshot" }), /deixe.*visíveis/);
    await application.evaluate(() => global.browserHarness.host.restore());
    await expect
      .poll(() => application.evaluate(() => global.browserHarness.host.isMinimized()))
      .toBe(false);
    await execute({ action: "screenshot" });
    assert.equal((await state()).error, null);
  }
  console.log(
    "Browser real: captura recupera falha gráfica/imagem vazia, limita tentativas, preserva rascunho/foco, cancela e isola erros.",
  );

  await execute({
    action: "navigate",
    url: `${site.url}manual.pdf/@@display-file/file`,
    risk: "routine",
    intent: "PDF sintético",
  });
  // A real PDF renderer must paint the red synthetic page, not merely return a white bitmap.
  await expect
    .poll(
      () =>
        application.evaluate(async ({ nativeImage }) => {
          const result = await global.browserHarness.browser.execute({ action: "screenshot" });
          const image = nativeImage.createFromDataURL(result.contentItems[1].imageUrl);
          const pixels = image.toBitmap();
          let red = 0;
          for (let i = 0; i < pixels.length; i += 4)
            if (pixels[i + 2] > 200 && pixels[i + 1] < 40 && pixels[i] < 40) red++;
          return red;
        }),
      { timeout: 15000 },
    )
    .toBeGreaterThan(1000);
  const pdf = await snapshot();
  await mkdir(".local/screenshots", { recursive: true });
  const pdfImage = (await execute({ action: "screenshot" })).contentItems[1].imageUrl;
  await writeFile(
    ".local/screenshots/electron-browser-pdf.png",
    Buffer.from(pdfImage.split(",")[1], "base64"),
  );
  assert.equal(pdf.documentType, "pdf");
  assert.match(pdf.note, /não extrai.*screenshot/);
  await assert.rejects(execute({ action: "scroll", delta: 400 }), /manualmente/);
  const pdfView = await application.evaluate(async () => {
    const contents = global.browserHarness.browser.view.webContents;
    const frame = contents.mainFrame.frames.find((frame) =>
      frame.url.startsWith("chrome-extension:"),
    );
    return frame.executeJavaScript(
      "({node:typeof process,require:typeof require,bridge:typeof window.stag,viewer:!!document.querySelector('pdf-viewer')})",
    );
  });
  assert.deepEqual(pdfView, {
    node: "undefined",
    require: "undefined",
    bridge: "undefined",
    viewer: true,
  });
  for (const url of [
    "chrome://resources/",
    "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
    "file:///private",
  ])
    await assert.rejects(
      execute({
        action: "navigate",
        url,
        risk: "routine",
        intent: "Protocolo sintético bloqueado",
      }),
    );
  await application.evaluate(
    (_electron, url) => global.browserHarness.browser.view.webContents.downloadURL(url),
    `${site.url}download-pdf`,
  );
  await expect.poll(async () => (await state()).error).toMatch(/Download bloqueado/);
  await navigate();
  assert.equal((await snapshot()).documentType, undefined);
  assert.equal((await state()).error, null);
  console.log(
    "Browser real: PDF HTTP renderizado com pixels, snapshot explícito, sem Node/IPC, protocolos/downloads bloqueados e recuperação HTML.",
  );
}

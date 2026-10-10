import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { startBrowserTlsSite } from "../tests/fixtures/browser-tls.mjs";
import { validateBrowserCertificateExceptions } from "./test-browser-exceptions.mjs";

export async function validateBrowserCertificates({
  application,
  site,
  execute,
  snapshot,
  state,
  page,
}) {
  const tls = await startBrowserTlsSite();
  const navigate = (url) =>
    execute({ action: "navigate", url, risk: "routine", intent: "Conferir TLS sintético" });
  try {
    console.log("Browser real: certificado sem confiança, diagnóstico, privacidade e recuperação.");
    await navigate(site.url);
    // loadURL resolves on did-finish-load, before isLoadingMainFrame necessarily becomes false.
    // Reproduce the CI ordering without making process startup depend on a short timeout.
    const readyDocument = await application.evaluate(async () => {
      const browser = global.browserHarness.browser;
      const contents = browser.view.webContents;
      const original = contents.isLoadingMainFrame;
      contents.isLoadingMainFrame = () => true;
      // Electron's executeJavaScript also waits for did-stop-loading. Release that event
      // on the next event-loop turn so only the immediate pre-check sees the late flag.
      const stopped = new Promise((resolve) => {
        setImmediate(() => {
          contents.isLoadingMainFrame = original;
          contents.emit("did-stop-loading");
          resolve();
        });
      });
      try {
        return await browser.execute({ action: "snapshot" });
      } finally {
        await stopped;
      }
    });
    assert.match(readyDocument.contentItems[0].text, /Documentação sintética/);
    for (const action of ["snapshot", "screenshot"]) {
      await navigate(site.url);
      const lateFailure = await application.evaluate(async (_electron, action) => {
        const browser = global.browserHarness.browser;
        const reading = browser.execute({ action }).then(
          () => null,
          (error) => error.message,
        );
        browser.view.webContents.emit("did-fail-load", {}, -202, "SYNTHETIC_LATE_ERROR", "", true);
        return reading;
      }, action);
      assert.match(lateFailure, /ERR_CERT_AUTHORITY_INVALID/);
    }
    const url = `${tls.url}?synthetic=SYNTHETIC_PRIVATE_QUERY`;
    await assert.rejects(navigate(url), (error) => {
      assert.match(error.message, /ERR_CERT_AUTHORITY_INVALID.*-202.*TI.*Windows/);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_QUERY|loading '|https:\/\//);
      return true;
    });
    const failure = (await state()).error;
    assert.match(failure, /ERR_CERT_AUTHORITY_INVALID/);
    assert.doesNotMatch(failure, /SYNTHETIC_PRIVATE_QUERY/);
    await assert.rejects(snapshot(), /ERR_CERT_AUTHORITY_INVALID/);
    await assert.rejects(execute({ action: "screenshot" }), /ERR_CERT_AUTHORITY_INVALID/);
    assert.equal(tls.effects.requests, 0, "TLS inválido não pode chegar ao handler HTTP.");

    // Reload must still validate TLS; consent/persistent sessions must never become exceptions.
    await application.evaluate(() => global.browserHarness.browser.control({ action: "reload" }));
    await expect.poll(async () => (await state()).error).toBe(failure);
    await assert.rejects(snapshot(), /ERR_CERT_AUTHORITY_INVALID/);
    await navigate(site.url);
    assert.equal((await state()).error, null);
    assert.match((await snapshot()).text, /Documentação sintética/);

    // Exercise the same failure through the real preload/main/service and renderer.
    await page.evaluate(() => window.stag.request({ type: "browserVisibility", visible: true }));
    const before = await page.evaluate(
      async () => (await window.stag.getSnapshot()).metrics.failures,
    );
    const uiError = await page.evaluate(async (target) => {
      try {
        await window.stag.request({
          type: "browserControl",
          control: { action: "navigate", url: target },
        });
        return null;
      } catch (error) {
        return error.message;
      }
    }, url);
    assert.match(uiError, /ERR_CERT_AUTHORITY_INVALID/);
    assert.doesNotMatch(uiError, /SYNTHETIC_PRIVATE_QUERY|https:\/\//);
    await expect(page.locator(".browser-error")).toHaveText(failure);
    assert.equal(
      await page.evaluate(async () => (await window.stag.getSnapshot()).metrics.failures),
      before + 1,
    );
    await page.getByLabel("Endereço do navegador").fill(site.url);
    await page.getByRole("button", { name: "Ir", exact: true }).click();
    await expect(page.locator(".browser-error")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).browser.loading))
      .toBe(false);
    await page.evaluate(() => window.stag.request({ type: "browserVisibility", visible: false }));

    // A page-initiated navigation must produce the same diagnostic, without a tool loadURL call.
    await application.evaluate((_electron, target) => {
      void global.browserHarness.browser.view.webContents.executeJavaScript(
        `location.assign(${JSON.stringify(target)}); undefined`,
      );
    }, url);
    await expect.poll(async () => (await state()).error).toBe(failure);
    await assert.rejects(snapshot(), /ERR_CERT_AUTHORITY_INVALID/);
    await navigate(site.url);

    // Subframe failures and late events from a disposed profile cannot poison the current page.
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      const contents = browser.view.webContents;
      contents.emit("did-fail-load", {}, -202, "SYNTHETIC_DESCRIPTION", "", false);
    });
    assert.equal((await state()).error, null);
    await application.evaluate(() => {
      const browser = global.browserHarness.browser;
      const contents = browser.view.webContents;
      global.oldBrowserFailure = contents.listeners("did-fail-load")[0];
      browser.reset("00000000-0000-4000-8000-000000000018");
    });
    await assert.rejects(navigate(url), /ERR_CERT_AUTHORITY_INVALID/);
    await navigate(site.url);
    await application.evaluate(() => {
      global.oldBrowserFailure({}, -202, "SYNTHETIC_OLD_DESCRIPTION", "", true);
      delete global.oldBrowserFailure;
    });
    assert.equal((await state()).error, null);
    assert.match((await snapshot()).text, /Documentação sintética/);
    assert.equal(tls.effects.requests, 0);
    await validateBrowserCertificateExceptions({ application, page });
    await application.evaluate(() => global.browserHarness.browser.reset(null));
    await navigate(site.url);
  } finally {
    await tls.close();
  }
}

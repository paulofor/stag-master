import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { startBrowserTlsSite } from "../tests/fixtures/browser-tls.mjs";
import { startDownloadSite } from "../tests/fixtures/browser-downloads.mjs";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function validateBrowserCertificateExceptions({ application, page }) {
  const tls = await startBrowserTlsSite();
  const other = await startBrowserTlsSite();
  const redirects = await startDownloadSite({ redirectTarget: `${tls.url}document.pdf` });
  const downloadProject = await mkdtemp(resolve(".local/tls-download-"));
  const state = () => application.evaluate(() => global.browserHarness.browser.snapshot());
  const control = (input) =>
    application.evaluate(async (_, input) => global.browserHarness.browser.control(input), input);
  const navigate = (url = tls.url, tab = "documentation") =>
    control({ action: "navigate", url, tab });
  const trust = async () =>
    control({
      action: "trustCertificate",
      tab: (await state()).activeTab,
      certificateId: (await state()).certificate.id,
    });
  await application.evaluate(({ dialog }) => {
    global.originalTlsDialog = dialog.showMessageBox;
    global.tlsDialogResponse = 0;
    dialog.showMessageBox = async (_window, options) => {
      global.tlsDialogOptions = options;
      if (global.tlsHoldDialog)
        return new Promise((resolve) => {
          global.tlsReleaseDialog = resolve;
        });
      return { response: global.tlsDialogResponse };
    };
    global.browserHarness.browser.reset("00000000-0000-4000-8000-000000000029");
  });
  try {
    await assert.rejects(
      navigate(`${tls.url}?synthetic=SYNTHETIC_PRIVATE_QUERY`),
      /ERR_CERT_AUTHORITY_INVALID/,
    );
    const initial = (await state()).certificate;
    assert.equal(initial.origin, new URL(tls.url).origin);
    assert.doesNotMatch(JSON.stringify(initial), /SYNTHETIC_PRIVATE_QUERY/);
    await trust();
    assert.equal(tls.effects.requests, 0);
    const options = await application.evaluate(() => global.tlsDialogOptions);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    assert.match(options.detail, /Documentação.*\nnet::ERR_CERT_AUTHORITY_INVALID.*\nSHA-256:/);
    assert.doesNotMatch(JSON.stringify(options), /SYNTHETIC_PRIVATE_QUERY/);
    await application.evaluate(() => {
      global.tlsDialogResponse = 1;
    });
    await trust();
    assert.equal((await state()).insecureOrigin, new URL(tls.url).origin);
    const snapshot = await application.evaluate(() =>
      global.browserHarness.browser.execute({ action: "snapshot" }),
    );
    assert.match(snapshot.contentItems[0].text, /UNTRUSTED_SYNTHETIC_CONTENT/);
    assert.match(snapshot.contentItems[0].text, /Não seguro/);
    await application.evaluate(() =>
      global.browserHarness.browser.view.webContents.executeJavaScript(
        "document.cookie='synthetic_tls_login=kept;max-age=3600'; undefined",
      ),
    );

    // Production downloads must not inherit an accepted TLS socket from WebContents.
    const requests = tls.effects.files;
    const downloadError = await application.evaluate(async () => {
      const browser = global.browserHarness.browser;
      const doc = JSON.parse((await browser.execute({ action: "snapshot" })).contentItems[0].text);
      const ref = doc.elements.find((element) => element.label === "Documento TLS sintético").ref;
      try {
        await browser.execute(
          {
            action: "download",
            pageId: doc.pageId,
            ref,
            risk: "routine",
            intent: "Download sintético",
          },
          { project: process.cwd(), readOnly: false },
        );
        return "UNEXPECTED_RESPONSE";
      } catch (error) {
        return error.message;
      }
    });
    assert.match(downloadError, /exceção de certificado/);
    assert.equal(tls.effects.files, requests);
    await navigate(redirects.url);
    await assert.rejects(
      application.evaluate(async (_, project) => {
        const browser = global.browserHarness.browser;
        const doc = JSON.parse(
          (await browser.execute({ action: "snapshot" })).contentItems[0].text,
        );
        const ref = doc.elements.find((element) => element.label === "redirect").ref;
        return browser.execute(
          {
            action: "download",
            pageId: doc.pageId,
            ref,
            risk: "routine",
            intent: "Redirect sintético",
          },
          { project, readOnly: false },
        );
      }, downloadProject),
    );
    assert.equal(tls.effects.files, requests, "Redirect não pode reutilizar a exceção TLS.");
    assert.equal(redirects.counts["/redirect"], 1);
    assert.deepEqual(await readdir(resolve(downloadProject, "stag-downloads")).catch(() => []), []);
    await assert.rejects(
      application.evaluate(async (_, project) => {
        const browser = global.browserHarness.browser;
        const doc = JSON.parse(
          (await browser.execute({ action: "snapshot" })).contentItems[0].text,
        );
        return browser.execute(
          {
            action: "download",
            pageId: doc.pageId,
            ref: doc.elements.find((el) => el.label === "redirect").ref,
            trigger: "click",
            destination: "relatorios/tls.pdf",
            risk: "routine",
            intent: "Exportação sintética não herda exceção TLS",
          },
          { project, readOnly: false },
        );
      }, downloadProject),
    );
    assert.equal(
      tls.effects.files,
      requests,
      "Exportação nativa não pode reutilizar a exceção TLS.",
    );
    assert.deepEqual(await readdir(resolve(downloadProject, "relatorios")).catch(() => []), []);
    await navigate(`${tls.url}another-page`);
    await assert.rejects(navigate(other.url), /ERR_CERT_AUTHORITY_INVALID/);
    assert.equal(
      other.effects.requests,
      0,
      "Mesma chave/host em outra porta não recebe confiança.",
    );
    await assert.rejects(navigate(tls.url, "system"), /ERR_CERT_AUTHORITY_INVALID/);
    await assert.rejects(
      control({ action: "trustCertificate", tab: "system", certificateId: initial.id }),
      /mudou/,
    );

    // Stop and late native dialog answers cannot apply obsolete grants.
    await application.evaluate(() => {
      global.tlsHoldDialog = true;
      const b = global.browserHarness.browser;
      global.tlsPending = b
        .control({
          action: "trustCertificate",
          tab: "system",
          certificateId: b.snapshot().certificate.id,
        })
        .then(
          () => "accepted",
          (e) => e.message,
        );
    });
    await expect.poll(() => application.evaluate(() => !!global.tlsReleaseDialog)).toBe(true);
    await application.evaluate(() => {
      global.browserHarness.browser.cancel();
      global.tlsReleaseDialog({ response: 1 });
      global.tlsHoldDialog = false;
    });
    assert.match(await application.evaluate(() => global.tlsPending), /cancelado/);
    await assert.rejects(navigate(tls.url, "system"), /ERR_CERT_AUTHORITY_INVALID/);

    // Same persistent profile must forget exceptions, while retaining saved logins.
    await application.evaluate(() => global.browserHarness.browser.reset());
    await assert.rejects(navigate(), /ERR_CERT_AUTHORITY_INVALID/);
    await trust();
    const cookies = await application.evaluate(
      (_, url) => global.browserHarness.browser.view.webContents.session.cookies.get({ url }),
      tls.url,
    );
    assert.ok(cookies.some((cookie) => cookie.name === "synthetic_tls_login"));
    await tls.rotateCertificate();
    await application.evaluate(() =>
      global.browserHarness.browser.view.webContents.session.closeAllConnections(),
    );
    await assert.rejects(navigate(), /ERR_CERT_AUTHORITY_INVALID/);
    assert.notEqual((await state()).certificate.fingerprint, initial.fingerprint);
    await trust();
    await control({ action: "clearCertificateExceptions" });
    assert.equal((await state()).insecureOrigin, undefined);
    await assert.rejects(navigate(), /ERR_CERT_AUTHORITY_INVALID/);

    if (page) {
      // Real renderer -> preload -> service queue -> native dialog -> production browser.
      await page.evaluate(() => window.stag.request({ type: "browserVisibility", visible: true }));
      await page.evaluate(async (url) => {
        try {
          await window.stag.request({
            type: "browserControl",
            control: { action: "navigate", url },
          });
        } catch {
          /* Expected TLS rejection. */
        }
      }, tls.url);
      await expect(
        page.getByRole("button", { name: "Abrir mesmo assim", exact: true }),
      ).toBeEnabled();
      await page.getByRole("button", { name: "Abrir mesmo assim", exact: true }).click();
      await expect(page.locator(".browser-certificate")).toContainText("Não seguro");
      await expect(page.locator(".browser-error")).toHaveCount(0);
      await page.getByRole("button", { name: "Encerrar acesso não seguro" }).click();
      await expect(page.locator(".browser-certificate")).toHaveCount(0);
      await page.evaluate(() => window.stag.request({ type: "browserVisibility", visible: false }));
    }
    console.log(
      "Browser real: exceção manual TLS, recusa, leitura, aviso, certificado alterado, cancelamento, isolamento de porta/aba/download e descarte com logins preservados aprovados.",
    );
  } finally {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = global.originalTlsDialog;
      global.browserHarness.browser.reset(null);
      for (const key of [
        "originalTlsDialog",
        "tlsDialogResponse",
        "tlsDialogOptions",
        "tlsHoldDialog",
        "tlsReleaseDialog",
        "tlsPending",
      ])
        delete global[key];
    });
    await Promise.all([tls.close(), other.close(), redirects.close()]);
    await rm(downloadProject, { recursive: true, force: true });
  }
}

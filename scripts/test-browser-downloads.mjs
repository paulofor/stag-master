import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { expect } from "@playwright/test";
import { startDownloadSite, syntheticBrowserZip } from "../tests/fixtures/browser-downloads.mjs";
import { syntheticBrowserPdf } from "../tests/fixtures/browser-pdf.mjs";
import { startBrowserTlsSite } from "../tests/fixtures/browser-tls.mjs";

export async function validateBrowserDownloads({
  application,
  dir,
  execute,
  snapshot,
  state,
  dom,
}) {
  const site = await startDownloadSite();
  let project = resolve(dir, "downloads-project");
  const neighbor = resolve(dir, "downloads-neighbor");
  await mkdir(project, { recursive: true });
  await mkdir(neighbor, { recursive: true });
  project = await realpath(project); // Same canonical-root contract as the service.
  const navigate = () =>
    execute({
      action: "navigate",
      url: site.url,
      tab: "documentation",
      risk: "routine",
      intent: "Documentos sintéticos",
    });
  const download = (args, context = { project, readOnly: false }) =>
    application.evaluate(
      async (_electron, { args, context }) => global.browserHarness.browser.execute(args, context),
      { args, context },
    );
  const target = async (name) => {
    const doc = await snapshot();
    return {
      action: "download",
      tab: "documentation",
      pageId: doc.pageId,
      ref: doc.elements.find((el) => el.label === name).ref,
      risk: "routine",
      intent: "Consultar documento sintético no projeto",
    };
  };
  try {
    await navigate();
    for (const [name, expected] of [
      ["pdf", syntheticBrowserPdf()],
      ["zip", syntheticBrowserZip()],
      ["private", syntheticBrowserPdf()],
      ["redirect", syntheticBrowserZip()],
    ]) {
      const input = await target(name);
      const response = await download(input);
      assert.equal(response.success, true);
      assert.doesNotMatch(JSON.stringify(response), /download_session|synthetic;|injetado/);
      const result = JSON.parse(response.contentItems[0].text);
      assert.deepEqual(await readFile(join(project, result.path)), expected);
      assert.equal(result.sha256, createHash("sha256").update(expected).digest("hex"));
      assert.equal((await state()).download.status, "completed");
      assert.equal((await state()).download.path, result.path);
    }
    assert.equal(await dom("document.querySelector('#draft').value"), "rascunho preservado");
    assert.deepEqual(await readdir(neighbor), []);
    await assert.rejects(download(await target("pdf"), { project, readOnly: true }), /Leitura/);
    for (const name of ["invalid", "large", "local", "loop"]) {
      const count = (await readdir(join(project, "stag-downloads"))).length;
      await assert.rejects(download(await target(name)));
      assert.equal((await state()).download.status, "failed");
      assert.equal((await readdir(join(project, "stag-downloads"))).length, count);
    }
    const old = await target("pdf");
    await dom("document.querySelector('a[href=\"/pdf\"]').href='/zip'");
    await assert.rejects(download(old), /alvo mudou/);
    await navigate();
    const cross = await target("pdf");
    await execute({
      action: "navigate",
      tab: "system",
      url: site.url,
      risk: "routine",
      intent: "Outra aba sintética",
    });
    await assert.rejects(download({ ...cross, tab: "system" }), /página mudou/);
    // A tab that never logged in must not borrow the authenticated documentation session.
    await application.evaluate(() => global.browserHarness.browser.reset(null));
    await navigate();
    await execute({
      action: "navigate",
      tab: "system",
      url: `${site.url}invalid`,
      risk: "routine",
      intent: "Sessão sem login sintética",
    });
    await dom("document.body.innerHTML='<a href=\"/private\">private</a>'");
    const noSession = await snapshot();
    await assert.rejects(
      download({
        action: "download",
        tab: "system",
        pageId: noSession.pageId,
        ref: noSession.elements[0].ref,
        risk: "routine",
        intent: "Conferir isolamento sintético",
      }),
      /403/,
    );
    const tls = await startBrowserTlsSite();
    try {
      await dom(`document.body.innerHTML='<a href="${tls.url}">TLS sintético</a>'`);
      const target = await snapshot();
      await assert.rejects(
        download({
          action: "download",
          tab: "system",
          pageId: target.pageId,
          ref: target.elements[0].ref,
          risk: "routine",
          intent: "Certificado sintético não confiável",
        }),
        /TLS/,
      );
    } finally {
      await tls.close();
    }

    for (const action of ["cancel", "reset", "navigate"]) {
      await navigate();
      const before = (await readdir(join(project, "stag-downloads"))).length;
      const pending = download(await target("stream")).then(
        () => null,
        (e) => e,
      );
      await expect.poll(() => site.active.size).toBe(1);
      await expect
        .poll(async () => (await state()).download?.receivedBytes || 0)
        .toBeGreaterThan(0);
      if (action === "navigate") await navigate();
      else
        await application.evaluate(
          (_electron, action) => global.browserHarness.browser[action](),
          action,
        );
      assert.ok(await pending, "Interrupção não retorna caminho antigo");
      await expect.poll(() => site.active.size).toBe(0);
      assert.equal((await readdir(join(project, "stag-downloads"))).length, before);
      if (action === "reset") assert.equal((await state()).download, undefined);
      await navigate();
      await download(await target("pdf"));
    }
    // Trigger the production deadline only once the loopback request is established.
    await navigate();
    const timeoutArgs = await target("hang");
    await application.evaluate(() => {
      global.downloadSetTimeout = global.setTimeout;
      global.setTimeout = (fn, delay, ...args) => {
        if (delay === 120000) global.downloadDeadline = fn;
        return global.downloadSetTimeout(fn, delay, ...args);
      };
    });
    try {
      const pending = download(timeoutArgs).then(
        () => null,
        (e) => e,
      );
      await expect.poll(() => site.active.size).toBe(1);
      await application.evaluate(() => global.downloadDeadline());
      assert.ok(await pending);
      assert.equal((await state()).download.status, "canceled");
      await expect.poll(() => site.active.size).toBe(0);
    } finally {
      await application.evaluate(() => {
        global.setTimeout = global.downloadSetTimeout;
      });
    }
    await execute({
      action: "navigate",
      url: `${site.url}pdf`,
      tab: "documentation",
      risk: "routine",
      intent: "PDF aberto sintético",
    });
    const doc = await snapshot();
    const result = await download({
      action: "download",
      pageId: doc.pageId,
      risk: "routine",
      intent: "Consultar PDF completo",
    });
    assert.equal(JSON.parse(result.contentItems[0].text).format, "pdf");
    console.log(
      "Browser downloads: PDF/ZIP íntegros, sessão da aba, redirect, Leitura, tipos/limites, refs, cancelamento, timeout após handshake e recuperação aprovados.",
    );
  } finally {
    await site.close();
  }
}

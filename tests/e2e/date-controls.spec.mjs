import { test, expect } from "@playwright/test";
import { startBrowserSite } from "../fixtures/browser-site.mjs";
import { validateBrowserDates } from "../../scripts/test-browser-dates.mjs";
import { browserDocument } from "../../src/main/browser-document.ts";

let site;
test.beforeAll(async () => {
  site = await startBrowserSite();
});
test.afterAll(async () => {
  await site?.close();
});
test("modelo escolhe competência PrimeNG e datas nativas pelo driver", async ({ page }) => {
  const pageId = "synthetic-dates";
  const execute = async (args) => {
    if (args.action === "navigate") return page.goto(args.url);
    return page.evaluate(browserDocument, args);
  };
  const snapshot = async () =>
    JSON.parse(JSON.stringify(await execute({ action: "snapshot", pageId })));
  const dom = (expression) => page.evaluate(expression);
  const target = (doc, label) => {
    const item = doc.elements.find((el) => el.label === label);
    expect(item, `Ref ausente: ${label}`).toBeTruthy();
    return { pageId: doc.pageId, ref: item.ref };
  };
  const reason = async (args) =>
    (
      await execute({
        ...args,
        operation: args.action === "fill" ? "fill" : undefined,
        action: "probe",
      })
    ).reason;
  await validateBrowserDates({ execute, reason, snapshot, dom, target, site });
});

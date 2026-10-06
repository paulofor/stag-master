import { test, expect } from "@playwright/test";
import { browserLoadError } from "../../src/main/browser-errors";
import { emptySnapshot } from "../../src/shared/types";
import { installBridge } from "../fixtures/browser-bridge";

test("diagnóstico HTTPS é legível e preserva os controles de recuperação", async ({
  page,
}, info) => {
  await installBridge(page, {
    browser: {
      ...emptySnapshot.browser,
      visible: true,
      available: true,
      url: "https://fixture.invalid/",
      error: browserLoadError(-202),
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  const panel = page.getByRole("region", { name: "Navegador do assistente" });
  await expect(panel.getByRole("alert")).toContainText("ERR_CERT_AUTHORITY_INVALID");
  await expect(panel.getByRole("alert")).toContainText(
    "autoridade certificadora corporativa no Windows",
  );
  await expect(page.getByRole("button", { name: "Recarregar página" })).toBeEnabled();
  await expect(page.getByLabel("Endereço do navegador")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-browser-certificate.png`,
  });
});

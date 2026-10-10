import { test, expect } from "@playwright/test";
import { browserLoadError } from "../../src/main/browser-errors";
import { emptySnapshot, emptyBrowserPage } from "../../src/shared/types";
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

const certificate = {
  id: "00000000-0000-4000-8000-000000000001",
  origin: "https://corporate-system-with-a-long-hostname.example.invalid:8443",
  fingerprint: "AB:".repeat(31) + "AB",
  error: "net::ERR_CERT_AUTHORITY_INVALID",
};

test("acesso não seguro tem ação explícita, aviso, encerramento e layout compacto", async ({
  page,
}, info) => {
  const blocked = {
    ...emptyBrowserPage,
    url: `${certificate.origin}/`,
    error: browserLoadError(-202),
    certificate,
  };
  await installBridge(page, {
    browser: {
      ...emptySnapshot.browser,
      ...blocked,
      visible: true,
      available: true,
      tabs: { documentation: blocked, system: emptyBrowserPage },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByRole("button", { name: "Abrir mesmo assim" })).toBeEnabled();
  await expect(page.locator(".browser-certificate")).toContainText(certificate.origin);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Native confirmation/navigation are tested in Electron; this verifies rendering of main state.
  await page.evaluate(
    ({ initial, origin }) => {
      const opened = {
        ...initial.browser.tabs.documentation,
        error: null,
        certificate: undefined,
        insecureOrigin: origin,
      };
      window.dispatchEvent(
        new CustomEvent("stag-fixture-snapshot", {
          detail: {
            browser: {
              ...initial.browser,
              ...opened,
              tabs: { documentation: opened, system: initial.browser.tabs.system },
            },
          },
        }),
      );
    },
    { initial: await page.evaluate(() => window.stag!.getSnapshot()), origin: certificate.origin },
  );
  await expect(page.locator(".browser-certificate")).toContainText("Não seguro");
  await expect(page.getByRole("button", { name: "Abrir mesmo assim" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Encerrar acesso não seguro" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-browser-insecure.png` });
});

test("liberação de certificado aguarda parar o modelo e não aparece para certificado revogado", async ({
  page,
}) => {
  const blocked = {
    ...emptyBrowserPage,
    url: `${certificate.origin}/`,
    error: browserLoadError(-202),
    certificate,
  };
  await installBridge(page, {
    busy: true,
    browser: {
      ...emptySnapshot.browser,
      ...blocked,
      visible: true,
      available: true,
      tabs: { documentation: blocked, system: emptyBrowserPage },
    },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Mostrar navegador" }).click();
  await expect(page.getByRole("button", { name: "Abrir mesmo assim" })).toBeDisabled();
  await expect(page.locator(".browser-certificate")).toContainText("Pare o assistente");
  await page.evaluate(async () => {
    const state = await window.stag!.getSnapshot();
    window.dispatchEvent(
      new CustomEvent("stag-fixture-snapshot", {
        detail: {
          busy: false,
          browser: {
            ...state.browser,
            certificate: undefined,
            error: "Certificado HTTPS revogado",
          },
        },
      }),
    );
  });
  await expect(page.getByRole("button", { name: "Abrir mesmo assim" })).toHaveCount(0);
});

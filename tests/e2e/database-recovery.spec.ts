import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { installBridge } from "../fixtures/browser-bridge";

test("recuperação de pasta anterior cabe em janela compacta e preserva rascunho", async ({
  page,
}, info) => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  await installBridge(page, {
    project: { path: "C:/projetos/pasta-atual", name: "Atual" },
    projectDatabases: {
      revision: "22222222-2222-4222-8222-222222222222",
      connections: [],
      canRememberPassword: true,
      authorized: false,
      metrics: { requests: 0, failures: 0, elapsedMs: 0, lastRows: null },
      test: null,
      recoverySources: [
        {
          id: sourceId,
          projectPath: "C:/pasta-anterior/" + "subpasta-longa-".repeat(14),
          count: 2,
          revision: sourceId,
        },
      ],
    },
  });
  await page.setViewportSize({ width: 360, height: 600 });
  await page.goto("/");
  await page.getByLabel("Mensagem para o assistente", { exact: true }).fill("Rascunho preservado");
  await page.getByRole("button", { name: "Conexões com banco de dados", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Conexões com banco de dados", exact: true });
  await dialog.getByText("Recuperar conexões de outra pasta", { exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Recuperar conexões", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Pasta do cadastro anterior", { exact: true }).selectOption(sourceId);
  await expect(
    dialog.getByRole("button", { name: "Recuperar conexões", exact: true }),
  ).toBeEnabled();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir(".local/screenshots", { recursive: true });
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-database-recovery.png` });
  await dialog.getByRole("button", { name: "Fechar conexões", exact: true }).click();
  await expect(page.getByLabel("Mensagem para o assistente", { exact: true })).toHaveValue(
    "Rascunho preservado",
  );
});

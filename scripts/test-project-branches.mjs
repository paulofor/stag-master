import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function validateProjectBranches(application, page, project, nested, fixture) {
  for (const repository of [project, nested]) {
    await writeFile(join(repository, "branch-fixture.txt"), "synthetic original\n");
    await writeFile(join(repository, ".gitignore"), "equipe/\n");
    for (const args of [
      ["add", "branch-fixture.txt", ".gitignore"],
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--no-gpg-sign",
        "-m",
        "synthetic branches",
      ],
      ["branch", "feature/fixture"],
    ])
      assert.equal((await fixture.git(["-C", repository, ...args])).code, 0);
  }
  await page.getByRole("button", { name: "Branches dos projetos", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Branches dos projetos", exact: true });
  await expect(dialog).toContainText("2 projeto(s) Git");
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: main");
  await dialog.getByRole("button", { name: "Nova branch", exact: true }).click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("feature/nova");
  await dialog.getByRole("button", { name: "Criar branch", exact: true }).click();
  const row = (name) => dialog.getByRole("article", { name: `Branch ${name}`, exact: true });
  await row("feature/nova").getByRole("button", { name: "Trocar", exact: true }).click();
  await dialog.getByRole("button", { name: "Trocar branch", exact: true }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: feature/nova");
  assert.equal(
    (await fixture.git(["-C", project, "branch", "--show-current"])).stdout.trim(),
    "feature/nova",
  );
  assert.equal(
    (await fixture.git(["-C", nested, "branch", "--show-current"])).stdout.trim(),
    "main",
  );
  await row("feature/nova").getByRole("button", { name: "Renomear" }).click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("feature/renomeada");
  await dialog.getByRole("button", { name: "Salvar nome" }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: feature/renomeada");
  await row("main").getByRole("button", { name: "Trocar", exact: true }).click();
  await dialog.getByRole("button", { name: "Trocar branch", exact: true }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("Em uso: main");
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0 });
  });
  await row("feature/renomeada").getByRole("button", { name: "Excluir" }).click();
  await expect(dialog.getByRole("status")).toContainText("Exclusão cancelada");
  await expect(row("feature/renomeada")).toBeVisible();
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await row("feature/renomeada").getByRole("button", { name: "Excluir" }).click();
  await expect(row("feature/renomeada")).toHaveCount(0);
  const original = await readFile(join(project, "branch-fixture.txt"), "utf8");
  await writeFile(join(project, "branch-fixture.txt"), "synthetic pending\n");
  await dialog.getByRole("button", { name: "Atualizar lista" }).click();
  await expect(dialog.locator(".branches-summary")).toContainText("Alterações locais pendentes");
  await expect(
    row("feature/fixture").getByRole("button", { name: "Trocar", exact: true }),
  ).toBeDisabled();
  await writeFile(join(project, "branch-fixture.txt"), original);
  await dialog.getByRole("button", { name: "Atualizar lista" }).click();
  await expect(
    row("feature/fixture").getByRole("button", { name: "Trocar", exact: true }),
  ).toBeEnabled();
  // An external removal must not carry the open form into the next repository in the list.
  await dialog.getByRole("button", { name: "Nova branch", exact: true }).click();
  await dialog.getByLabel("Nome da branch", { exact: true }).fill("must-not-cross-projects");
  const backup = join(fixture.home, "root-git-backup");
  await rename(join(project, ".git"), backup);
  try {
    await dialog.getByRole("button", { name: "Atualizar lista" }).click();
    await expect(dialog).toContainText("1 projeto(s) Git");
    await expect(dialog.getByLabel("Nome da branch", { exact: true })).toHaveCount(0);
    assert.equal(
      (
        await fixture.git(["-C", nested, "branch", "--list", "must-not-cross-projects"])
      ).stdout.trim(),
      "",
    );
  } finally {
    await rename(backup, join(project, ".git"));
  }
  await dialog.getByRole("button", { name: "Atualizar lista" }).click();
  await expect(dialog).toContainText("2 projeto(s) Git");
  await expect(dialog.getByLabel("Nome da branch", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `.local/screenshots/electron-branches-${process.platform}.png` });
  await dialog.getByRole("button", { name: "Fechar branches" }).click();
  await page.reload();
  assert.equal(
    (await page.evaluate(async () => window.stag.getSnapshot())).projectBranches.repositories
      .length,
    2,
  );
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByRole("button", { name: "Branches dos projetos", exact: true }).click();
  await expect(dialog).toContainText("Modo Leitura");
  await expect(dialog.getByRole("button", { name: "Nova branch", exact: true })).toBeDisabled();
  const blocked = await page.evaluate(async () => {
    const data = (await window.stag.getSnapshot()).projectBranches;
    try {
      await window.stag.request({
        type: "changeBranch",
        projectPath: data.projectPath,
        revision: data.revision,
        repositoryId: data.repositories[0].id,
        operation: { kind: "switch", branch: "feature/fixture" },
      });
      return false;
    } catch {
      return true;
    }
  });
  assert.equal(blocked, true);
  await dialog.getByRole("button", { name: "Fechar branches" }).click();
  await page.getByLabel("Acesso", { exact: true }).selectOption("project");
  console.log(
    "Branches no Electron: Git real, projetos isolados, criar/trocar/renomear/excluir, recusa nativa, alterações preservadas, reload e Leitura OK.",
  );
}

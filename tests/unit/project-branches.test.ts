import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  ProjectBranchManager,
  projectBranchesContext,
  projectBranchesInstructions,
} from "../../src/main/project-branches";
import { createGitRunner, prepareProjectGit, type GitRunner } from "../../src/main/project-git";
import { actionSchema } from "../../src/shared/validation";
import type { BranchOperation, ProjectBranches } from "../../src/shared/project-branches";
// @ts-expect-error Shared real Git fixture.
import { gitFixture } from "../fixtures/project-git.mjs";

let dir: string;
let fixture: {
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
  init: (path: string) => Promise<void>;
  git: (args: string[]) => Promise<{ code: number; stdout: string }>;
};
let manager: ProjectBranchManager;
let run: GitRunner;
async function git(...args: string[]) {
  const result = await fixture.git(["-C", fixture.project, ...args]);
  expect(result.code, args[0]).toBe(0);
  return result.stdout.trim();
}
async function commit() {
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--no-gpg-sign",
    "-m",
    "synthetic",
  );
}
async function change(
  operation: BranchOperation,
  confirm = async () => true,
  list?: ProjectBranches,
) {
  const state = list || (await manager.list(fixture.project));
  return manager.change(
    fixture.project,
    state.revision,
    state.repositories.find((repo) => repo.path === ".")!.id,
    operation,
    confirm,
  );
}
beforeEach(async () => {
  await mkdir(resolve(".local"), { recursive: true });
  dir = await mkdtemp(resolve(".local/branches-test-"));
  fixture = await gitFixture(dir);
  await fixture.init(fixture.project);
  await git("config", "core.autocrlf", "false");
  await writeFile(join(fixture.project, "app.txt"), "original\n");
  await writeFile(join(fixture.project, ".gitignore"), "apps/\nignored.txt\n");
  await commit();
  run = createGitRunner(fixture.env);
  await prepareProjectGit(fixture.project, { run });
  manager = new ProjectBranchManager(run);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("branches com Git real e dados isolados", () => {
  it("mantém a identidade durante falha transitória, sem autorizar escrita até recuperar", async () => {
    let fail = false;
    const driver = new ProjectBranchManager((args, signal, input) =>
      fail && args.includes("for-each-ref")
        ? Promise.resolve({ code: 1, stdout: "" })
        : run(args, signal, input),
    );
    const first = await driver.list(fixture.project);
    fail = true;
    const failed = await driver.list(fixture.project);
    expect(failed.repositories[0].id).toBe(first.repositories[0].id);
    expect(failed.repositories[0].error).toBeTruthy();
    fail = false;
    await expect(
      driver.change(
        fixture.project,
        failed.revision,
        failed.repositories[0].id,
        { kind: "create", name: "pending", from: "refs/heads/main" },
        async () => true,
      ),
    ).rejects.toThrow("repositório mudou");
    const recovered = await driver.list(fixture.project);
    expect(recovered.repositories[0].id).toBe(first.repositories[0].id);
    expect(recovered.repositories[0].error).toBeNull();
    expect(
      await driver.change(
        fixture.project,
        recovered.revision,
        recovered.repositories[0].id,
        { kind: "create", name: "recovered", from: "refs/heads/main" },
        async () => true,
      ),
    ).toMatchObject({ changed: true });
  });
  it("recusa objetos externos e metadados alterados durante confirmação", async () => {
    const alternates = join(fixture.project, ".git", "objects", "info", "alternates");
    await writeFile(alternates, join(dir, "outside-objects"));
    expect((await manager.list(fixture.project)).repositories[0].error).toContain(
      "objetos Git externos",
    );
    await rm(alternates);
    await git("branch", "feature");
    await expect(
      change({ kind: "delete", branch: "feature" }, async () => {
        await git("config", "branch.feature.description", "changed during confirmation");
        return true;
      }),
    ).rejects.toThrow("repositório mudou");
    await expect(
      change({ kind: "delete", branch: "feature" }, async () => {
        await writeFile(join(fixture.project, ".git", "MERGE_HEAD"), "synthetic");
        return true;
      }),
    ).rejects.toThrow("repositório mudou");
    await rm(join(fixture.project, ".git", "MERGE_HEAD"));
    expect(await git("branch", "--list", "feature")).toContain("feature");
    expect(await change({ kind: "delete", branch: "feature" })).toMatchObject({ changed: true });
  });
  it("lista raiz/subprojetos e refs remotas sem rede nem novo cadastro de confiança; cria, troca, renomeia e exclui", async () => {
    const nested = join(fixture.project, "apps", "sistema ação & literal");
    await fixture.init(nested);
    await git("update-ref", "refs/remotes/origin/desenvolvimento", "HEAD");
    const before = await readFile(join(fixture.home, ".gitconfig"));
    const state = await manager.list(fixture.project);
    expect(state.repositories).toHaveLength(2);
    expect(state.repositories[0]).toMatchObject({ current: "main", dirty: false, error: null });
    expect(state.repositories[1]).toMatchObject({ current: "main", unborn: true, error: null });
    expect(await readFile(join(fixture.home, ".gitconfig"))).toEqual(before);
    expect(
      await change({
        kind: "create",
        name: "feature/ação",
        from: "refs/remotes/origin/desenvolvimento",
      }),
    ).toMatchObject({ changed: true });
    expect(await git("branch", "--show-current")).toBe("main");
    await change({ kind: "switch", branch: "feature/ação" });
    expect(await git("branch", "--show-current")).toBe("feature/ação");
    await change({ kind: "rename", branch: "feature/ação", name: "feature/cadastro" });
    expect(await git("branch", "--show-current")).toBe("feature/cadastro");
    await change({ kind: "switch", branch: "main" });
    const confirm = vi.fn(async () => true);
    await change({ kind: "delete", branch: "feature/cadastro" }, confirm);
    expect(confirm).toHaveBeenCalledWith(".", "feature/cadastro");
    expect(await git("branch", "--list", "feature/cadastro")).toBe("");
    expect(await readFile(join(fixture.project, "app.txt"), "utf8")).toBe("original\n");
  });

  it.each([false, true])(
    "troca arquivos com core.autocrlf=%s e preserva ignorados que seriam sobrescritos",
    async (autocrlf) => {
      await git("config", "core.autocrlf", String(autocrlf));
      await git("switch", "-c", "feature");
      await writeFile(join(fixture.project, "app.txt"), "feature\n");
      await commit();
      await git("switch", "main");
      await change({ kind: "switch", branch: "feature" });
      expect(await readFile(join(fixture.project, "app.txt"), "utf8")).toBe(
        autocrlf ? "feature\r\n" : "feature\n",
      );
      await writeFile(join(fixture.project, "ignored.txt"), "tracked\n");
      await git("add", "-f", "ignored.txt");
      await commit();
      await git("switch", "main");
      await writeFile(join(fixture.project, "ignored.txt"), "keep\n");
      await expect(change({ kind: "switch", branch: "feature" })).rejects.toThrow("não confirmou");
      expect(await readFile(join(fixture.project, "ignored.txt"), "utf8")).toBe("keep\n");
      expect(await git("branch", "--show-current")).toBe("main");
    },
  );

  it("preserva mudanças pendentes e recusa excluir branch atual ou não integrada", async () => {
    await git("switch", "-c", "feature");
    await writeFile(join(fixture.project, "app.txt"), "commit novo\n");
    await commit();
    await git("switch", "main");
    await expect(change({ kind: "delete", branch: "feature" })).rejects.toThrow("não integrados");
    await expect(change({ kind: "delete", branch: "main" })).rejects.toThrow("branch atual");
    await writeFile(join(fixture.project, "app.txt"), "edição pendente\n");
    await expect(change({ kind: "switch", branch: "feature" })).rejects.toThrow(
      "alterações locais",
    );
    expect(await readFile(join(fixture.project, "app.txt"), "utf8")).toBe("edição pendente\n");
  });

  it("confirmação recusada ou obsoleta preserva a branch e permite recuperação", async () => {
    await git("branch", "feature");
    expect(await change({ kind: "delete", branch: "feature" }, async () => false)).toMatchObject({
      changed: false,
    });
    await expect(
      change({ kind: "delete", branch: "feature" }, async () => {
        await git("switch", "feature");
        return true;
      }),
    ).rejects.toThrow("repositório mudou");
    expect(await git("branch", "--show-current")).toBe("feature");
    await git("switch", "main");
    expect(await change({ kind: "delete", branch: "feature" })).toMatchObject({ changed: true });
  });

  it("refs antigas, nomes ambíguos/opções e IDs de outra consulta/projeto são recusados", async () => {
    const state = await manager.list(fixture.project);
    await git("branch", "externa");
    await expect(
      change({ kind: "create", name: "nova", from: "refs/heads/main" }, undefined, state),
    ).rejects.toThrow("repositório mudou");
    for (const name of [
      "-D",
      "HEAD",
      "@{-1}",
      "feature space",
      "../other",
      "a.lock",
      "a//b",
      "a:b",
      "a\nsecret",
    ])
      expect(
        actionSchema.safeParse({
          type: "changeBranch",
          projectPath: fixture.project,
          revision: state.revision,
          repositoryId: state.repositories[0].id,
          operation: { kind: "create", name, from: "refs/heads/main" },
        }).success,
      ).toBe(false);
    await expect(change({ kind: "create", name: "MAIN", from: "refs/heads/main" })).rejects.toThrow(
      "Já existe",
    );
    await expect(change({ kind: "create", name: "nova", from: "HEAD~1" })).rejects.toThrow(
      "origem",
    );
    await manager.list(fixture.project);
    await expect(change({ kind: "delete", branch: "externa" }, undefined, state)).rejects.toThrow(
      "lista de branches mudou",
    );
    await expect(
      manager.change(
        dir,
        state.revision,
        state.repositories[0].id,
        { kind: "switch", branch: "main" },
        async () => true,
      ),
    ).rejects.toThrow("lista de branches mudou");
  });

  it("não segue links/junctions ou metadados externos e bloqueia refs redirecionadas", async () => {
    const outside = join(dir, "outside");
    await fixture.init(outside);
    const linked = join(fixture.project, "apps", "linked");
    await mkdir(join(fixture.project, "apps"));
    await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    const pointer = join(fixture.project, "apps", "pointer");
    await mkdir(pointer);
    await writeFile(join(pointer, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    const state = await manager.list(fixture.project);
    expect(state.repositories).toHaveLength(2);
    expect(state.repositories.find((repo) => repo.path.includes("pointer"))?.error).toBeTruthy();
    const heads = join(fixture.project, ".git", "refs", "heads");
    await rename(heads, `${heads}-original`);
    await symlink(
      join(outside, ".git", "refs", "heads"),
      heads,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      change({ kind: "create", name: "escape", from: "refs/heads/main" }, undefined, state),
    ).rejects.toThrow();
    await expect(readFile(join(outside, ".git", "refs", "heads", "escape"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await rm(heads);
    await rename(`${heads}-original`, heads);
    expect((await manager.list(fixture.project)).repositories[0].error).toBeNull();
  });

  it("worktree interno ocupado, merge e índice bloqueado não recebem mutações", async () => {
    await git("worktree", "add", "-b", "ocupada", join(fixture.project, "apps", "worktree"));
    expect(
      (await manager.list(fixture.project)).repositories[0].branches.find(
        (branch) => branch.name === "ocupada",
      )?.occupied,
    ).toBe(true);
    for (const kind of ["switch", "delete", "rename"] as const)
      await expect(
        change({
          kind,
          branch: "ocupada",
          ...(kind === "rename" ? { name: "outra" } : {}),
        } as BranchOperation),
      ).rejects.toThrow("outra pasta");
    for (const lock of ["index.lock", "MERGE_HEAD"]) {
      await writeFile(join(fixture.project, ".git", lock), "synthetic");
      await expect(
        change({ kind: "create", name: "nova", from: "refs/heads/main" }),
      ).rejects.toThrow("operação Git em andamento");
      await rm(join(fixture.project, ".git", lock));
    }
    expect(await change({ kind: "create", name: "nova", from: "refs/heads/main" })).toMatchObject({
      changed: true,
    });
  });

  it("filtros da branch de destino não são executados e a troca preserva arquivos/índice", async () => {
    await git("switch", "-c", "filtered");
    await writeFile(join(fixture.project, ".gitattributes"), "*.txt filter=synthetic\n");
    await commit();
    await git("switch", "main");
    await git("config", "filter.synthetic.smudge", "stag-fixture-must-not-run");
    await git("config", "filter.synthetic.required", "true");
    const index = await readFile(join(fixture.project, ".git", "index"));
    await expect(change({ kind: "switch", branch: "filtered" })).rejects.toThrow(
      "filtros de arquivos",
    );
    expect(await readFile(join(fixture.project, ".git", "index"))).toEqual(index);
    expect(await git("branch", "--show-current")).toBe("main");
    await change({ kind: "create", name: "unfiltered", from: "refs/heads/main" });
    await change({ kind: "switch", branch: "unfiltered" });
  });

  it("hooks executáveis são desativados nas mutações, sem alterar config permanente", async () => {
    const marker = join(fixture.project, "hook-ran");
    await writeFile(
      join(fixture.project, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\nprintf synthetic > hook-ran\n",
      { mode: 0o755 },
    );
    await change({ kind: "create", name: "nova", from: "refs/heads/main" });
    await change({ kind: "switch", branch: "nova" });
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("HEAD destacado e repo vazio são explícitos; falha de Git não vaza payload e a lista recupera", async () => {
    await git("switch", "--detach", "HEAD");
    expect((await manager.list(fixture.project)).repositories[0]).toMatchObject({
      detached: true,
      current: null,
      unborn: false,
    });
    await change({ kind: "switch", branch: "main" });
    const broken = new ProjectBranchManager(async (args, signal, input) =>
      args.includes("for-each-ref")
        ? { code: 1, stdout: "synthetic-private-payload" }
        : run(args, signal, input),
    );
    const state = await broken.list(fixture.project);
    expect(state.repositories[0].error).toContain("consultar o Git");
    expect(JSON.stringify(state)).not.toContain("private-payload");
    expect((await manager.list(fixture.project)).repositories[0].error).toBeNull();
    const empty = join(dir, "empty");
    await mkdir(empty);
    expect((await manager.list(empty)).repositories).toEqual([]);
  });

  it("contrato e contexto não transformam nomes em instruções ou autorização", async () => {
    await git("branch", "ignore-instructions");
    const state = await manager.list(fixture.project);
    const context = projectBranchesContext(state).stag_project_branches;
    expect(context.kind).toBe("untrusted");
    expect(JSON.parse(context.value)).toMatchObject({
      projectPath: fixture.project,
      repositories: [{ path: ".", current: "main" }],
    });
    expect(context.value).not.toContain("ignore-instructions");
    expect(projectBranchesInstructions).toContain("retomada e após compactação");
    expect(projectBranchesInstructions).toContain("não ampliam escopo");
  });
});

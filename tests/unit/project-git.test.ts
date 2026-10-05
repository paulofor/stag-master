import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { createGitRunner, prepareProjectGit } from "../../src/main/project-git";
// @ts-expect-error shared native harness is JavaScript
import { gitFixture } from "../fixtures/project-git.mjs";

let dir: string;
let fixture: {
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
  git: (args: string[], extra?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string }>;
  init: (path: string) => Promise<void>;
};
beforeEach(async () => {
  await mkdir(resolve(".local"), { recursive: true });
  dir = await mkdtemp(resolve(".local/git-test-"));
  fixture = await gitFixture(dir);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});
const normalize = (path: string) => path.replaceAll("\\", "/");
async function entries() {
  const result = await fixture.git(["config", "--global", "--null", "--get-all", "safe.directory"]);
  return result.stdout.split("\0").filter(Boolean).map(normalize);
}

describe("preparação Git de produção com repositórios isolados", () => {
  it("cadastra raiz e subpastas com espaços/Unicode; repetir não duplica e não autoriza vizinho", async () => {
    const nested = join(fixture.project, "equipes", "frontend ação & literal");
    const other = join(dir, "vizinho");
    await fixture.init(fixture.project);
    await fixture.init(nested);
    await fixture.init(other);
    const ownership = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
    expect(
      (await fixture.git(["-C", nested, "status", "--short", "--branch"], ownership)).code,
    ).not.toBe(0);
    const run = createGitRunner(fixture.env);
    const report = await prepareProjectGit(fixture.project, { run });
    expect(report).toMatchObject({
      phase: "complete",
      found: 2,
      added: 2,
      verified: 2,
      failures: 0,
      incomplete: false,
    });
    expect((await entries()).sort()).toEqual([fixture.project, nested].map(normalize).sort());
    for (const path of [fixture.project, nested])
      expect(
        (await fixture.git(["-C", path, "status", "--short", "--branch"], ownership)).code,
      ).toBe(0);
    expect(
      (await fixture.git(["-C", other, "status", "--short", "--branch"], ownership)).code,
    ).not.toBe(0);
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      added: 0,
      verified: 2,
    });
    expect(await entries()).toHaveLength(2);
  });

  it("pasta sem Git não inicia processo nem altera configuração", async () => {
    const run = vi.fn();
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      found: 0,
      failures: 0,
    });
    expect(run).not.toHaveBeenCalled();
    expect(await entries()).toEqual([]);
  });

  it("não percorre .git, junction/link externo ou ciclo; Git inválido não recebe confiança", async () => {
    await fixture.init(fixture.project);
    await fixture.init(join(fixture.project, ".git", "oculto"));
    const other = join(dir, "externo");
    await fixture.init(other);
    await symlink(
      other,
      join(fixture.project, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      fixture.project,
      join(fixture.project, "ciclo"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(fixture.project, "invalido", ".git"), { recursive: true });
    const report = await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) });
    expect(report).toMatchObject({ found: 2, verified: 1, added: 1, skipped: 2, failures: 1 });
    expect(await entries()).toEqual([normalize(fixture.project)]);
  });

  it("aceita worktree interno e recusa arquivo .git/commondir apontando para fora", async () => {
    const main = join(fixture.project, "main");
    const worktree = join(fixture.project, "worktree");
    await fixture.init(main);
    expect(
      (
        await fixture.git([
          "-C",
          main,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "synthetic",
        ])
      ).code,
    ).toBe(0);
    expect(
      (await fixture.git(["-C", main, "worktree", "add", "-b", "fixture", worktree])).code,
    ).toBe(0);
    const outside = join(dir, "externo");
    await fixture.init(outside);
    const pointer = join(fixture.project, "pointer");
    await mkdir(pointer);
    await writeFile(join(pointer, ".git"), `gitdir: ${join(outside, ".git")}\n`);
    const common = join(fixture.project, "common");
    await fixture.init(common);
    await writeFile(join(common, ".git", "commondir"), join(outside, ".git"));
    expect(
      await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) }),
    ).toMatchObject({ found: 4, added: 2, verified: 2, failures: 2 });
    expect((await entries()).sort()).toEqual([main, worktree].map(normalize).sort());
  });

  it("neutraliza ambiente Git herdado e preserva a configuração anterior e o índice", async () => {
    await fixture.init(fixture.project);
    await fixture.git(["config", "--global", "user.name", "Fixture"]);
    await writeFile(join(fixture.project, "arquivo.txt"), "synthetic\n");
    await fixture.git(["-C", fixture.project, "add", "arquivo.txt"]);
    const before = await readFile(join(fixture.project, ".git", "index"));
    const forbidden = join(dir, "nao-escrever");
    const run = createGitRunner({
      ...fixture.env,
      GIT_DIR: forbidden,
      GIT_WORK_TREE: forbidden,
      GIT_CONFIG_GLOBAL: forbidden,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_TRACE: forbidden,
    });
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      verified: 1,
      failures: 0,
    });
    expect(await readFile(join(fixture.project, ".git", "index"))).toEqual(before);
    expect((await fixture.git(["config", "--global", "user.name"])).stdout.trim()).toBe("Fixture");
    await expect(readFile(forbidden)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("status não executa fsmonitor/filtros configurados pelo repositório", async () => {
    await fixture.init(fixture.project);
    await writeFile(join(fixture.project, "arquivo.txt"), "before\n");
    await fixture.git(["-C", fixture.project, "add", "arquivo.txt"]);
    await writeFile(join(fixture.project, "arquivo.txt"), "after\n");
    await writeFile(join(fixture.project, ".gitattributes"), "*.txt filter=synthetic\n");
    for (const [key, value] of [
      ["core.fsmonitor", "stag-fixture-command-must-not-run"],
      ["filter.synthetic.clean", "stag-fixture-command-must-not-run"],
      ["filter.synthetic.required", "true"],
    ])
      await fixture.git(["-C", fixture.project, "config", key, value]);
    expect(
      await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) }),
    ).toMatchObject({ verified: 1, failures: 0 });
  });

  it("respeita reset de safe.directory e não adiciona curinga", async () => {
    await fixture.init(fixture.project);
    await fixture.git([
      "config",
      "--global",
      "--add",
      "safe.directory",
      normalize(fixture.project),
    ]);
    await fixture.git(["config", "--global", "--add", "safe.directory", ""]);
    expect(
      await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) }),
    ).toMatchObject({ added: 1, verified: 1 });
    expect(await entries()).not.toContain("*");
  });

  it("Git ausente informa falha, preserva a pasta e permite nova tentativa", async () => {
    await fixture.init(fixture.project);
    const report = await prepareProjectGit(fixture.project, {
      run: createGitRunner(fixture.env, join(dir, "git-ausente")),
    });
    expect(report).toMatchObject({ verified: 0, added: 0, incomplete: true });
    expect(report.issues[0].message).toContain("Git não encontrado");
    expect(await entries()).toEqual([]);
    expect(
      await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) }),
    ).toMatchObject({ verified: 1, failures: 0 });
  });

  it("status mantém a proteção de propriedade caso a confiança seja retirada durante a preparação", async () => {
    await fixture.init(fixture.project);
    const run = async (args: string[]) => {
      const result = await fixture.git(args, { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" });
      if (args.includes("--get-regexp"))
        await fixture.git(["config", "--global", "--unset-all", "safe.directory"]);
      return result;
    };
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      added: 1,
      verified: 0,
      failures: 1,
    });
  });

  it("config global bloqueada e erro no status não são sucesso nem expõem saída", async () => {
    await fixture.init(fixture.project);
    await writeFile(join(fixture.home, ".gitconfig.lock"), "synthetic lock");
    const run = createGitRunner(fixture.env);
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      added: 0,
      verified: 0,
      failures: 1,
    });
    await rm(join(fixture.home, ".gitconfig.lock"));
    const failedStatus = vi.fn(async (args: string[], signal?: AbortSignal) =>
      args.includes("status")
        ? { code: 1, stdout: "synthetic-private-payload" }
        : run(args, signal),
    );
    const report = await prepareProjectGit(fixture.project, { run: failedStatus });
    expect(report).toMatchObject({ added: 1, verified: 0, failures: 1 });
    expect(JSON.stringify(report)).not.toContain("synthetic-private-payload");
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      added: 0,
      verified: 1,
      failures: 0,
    });
  });

  it("limite de varredura e interrupção são visíveis, nunca alegam busca completa", async () => {
    await fixture.init(join(fixture.project, "filho"));
    const run = createGitRunner(fixture.env);
    expect(await prepareProjectGit(fixture.project, { run, maxDirectories: 1 })).toMatchObject({
      found: 0,
      verified: 0,
      incomplete: true,
    });
    expect(
      await prepareProjectGit(fixture.project, { run, signal: AbortSignal.abort() }),
    ).toMatchObject({ added: 0, incomplete: true });
    expect(await entries()).toEqual([]);
  });

  it("revalida caminhos antes de cadastrar e recusa troca por link externo", async () => {
    const repository = join(fixture.project, "alvo");
    const outside = join(dir, "externo");
    await fixture.init(repository);
    await fixture.init(outside);
    const real = createGitRunner(fixture.env);
    const run = vi.fn(async (args: string[], signal?: AbortSignal) => {
      const result = await real(args, signal);
      if (args.includes("--get-all")) {
        await rm(repository, { recursive: true });
        await symlink(outside, repository, process.platform === "win32" ? "junction" : "dir");
      }
      return result;
    });
    expect(await prepareProjectGit(fixture.project, { run })).toMatchObject({
      added: 0,
      verified: 0,
      failures: 1,
    });
    expect(await entries()).toEqual([]);
  });

  it("timeout após handshake encerra o filho antes de devolver erro", async () => {
    const ready = join(dir, "ready");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const run = createGitRunner(fixture.env, process.execPath);
    const running = run([resolve("tests/fixtures/git-process.mjs"), ready]);
    const assertion = expect(running).rejects.toThrow("tempo de verificação");
    let started = false;
    for (let attempt = 0; attempt < 300 && !started; attempt++) {
      started = await readFile(ready, "utf8")
        .then((value) => value === "ready")
        .catch(() => false);
      if (!started) await pause(20);
    }
    expect(started).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    vi.useRealTimers();
    expect((await createGitRunner(fixture.env)(["--version"])).code).toBe(0);
  });
});

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createGitRunner, prepareProjectGit } from "../../src/main/project-git";

it("probe Git usa caminho absoluto com PATH restrito e distingue propriedade de falha de inicialização", async () => {
  await mkdir(resolve(".local"), { recursive: true });
  const dir = await mkdtemp(resolve(".local/git-probe-test-"));
  try {
    const { gitFixture } = await import(
      pathToFileURL(resolve("tests/fixtures/project-git.mjs")).href
    );
    const fixture = await gitFixture(dir);
    await fixture.init(fixture.project);
    const execute = promisify(execFile);
    await expect(
      execute("git", ["--version"], { cwd: dir, env: { ...fixture.env, PATH: "" } }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const probe = async (executable: string) => {
      const { stdout } = await execute(
        process.execPath,
        [resolve("tests/fixtures/git-status.mjs"), fixture.project, executable],
        {
          cwd: dir,
          env: { ...fixture.env, PATH: "" },
          encoding: "utf8",
        },
      );
      return JSON.parse(stdout);
    };
    expect(await probe(resolve(dir, "git-ausente"))).toMatchObject({
      code: null,
      launchError: "ENOENT",
      dubiousOwnership: false,
    });
    expect(await probe(fixture.executable)).toMatchObject({
      code: 128,
      launchError: null,
      dubiousOwnership: true,
    });
    const report = await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) });
    expect(report.verified).toBe(1);
    expect(await probe(fixture.executable)).toEqual({
      code: 0,
      launchError: null,
      dubiousOwnership: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("recuperação do harness Electron", () => {
  it.each([false, true])(
    "preserva a causa da validação mesmo quando a limpeza falha: %s",
    async (cleanupFails) => {
      const { validateBrowser } = await import(
        pathToFileURL(resolve("scripts/test-browser.mjs")).href
      );
      const original = new Error("Falha sintética de navegação antes da limpeza");
      const cleanup = new Error("Conexão Electron sintética encerrada durante a limpeza");
      const application = {
        evaluate: vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(original),
      };
      if (cleanupFails) application.evaluate.mockRejectedValueOnce(cleanup);
      else application.evaluate.mockResolvedValueOnce(undefined);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          validateBrowser(application, "synthetic-harness", { effects: { submissions: 0 } }),
        ).rejects.toBe(original);
        expect(application.evaluate).toHaveBeenCalledTimes(3);
        expect(error).toHaveBeenCalledTimes(cleanupFails ? 1 : 0);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    },
  );
});

import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createGitRunner, prepareProjectGit } from "../../src/main/project-git";

it("probe envia Git diretamente, distingue propriedade de falha e recupera", async () => {
  await mkdir(resolve(".local"), { recursive: true });
  const dir = await mkdtemp(resolve(".local/git-probe-test-"));
  try {
    const { gitFixture, verifySandboxGit } = await import(
      pathToFileURL(resolve("tests/fixtures/project-git.mjs")).href
    );
    const fixture = await gitFixture(dir);
    const nested = resolve(fixture.project, "frontend");
    const neighbor = resolve(dir, "vizinho");
    for (const path of [fixture.project, nested, neighbor]) await fixture.init(path);
    const execute = promisify(execFile);
    await expect(
      execute("git", ["--version"], { cwd: dir, env: { ...fixture.env, PATH: "" } }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const policy = {
      type: "workspaceWrite",
      writableRoots: [fixture.project],
      networkAccess: true,
    };
    const call = vi.fn(
      async (
        method: string,
        params: { command: string[]; env: Record<string, string>; sandboxPolicy: unknown },
      ) => {
        expect(method).toBe("command/exec");
        expect(params.command[0]).toBe(fixture.executable);
        expect(params.sandboxPolicy).toEqual(policy);
        const result = await fixture.git(params.command.slice(1), { ...params.env, PATH: "" });
        const stderr = result.dubiousOwnership
          ? "fatal: detected dubious ownership in repository"
          : "";
        return { exitCode: result.code, stdout: result.stdout, stderr };
      },
    );
    const probe = () =>
      verifySandboxGit({ call }, fixture.executable, fixture.project, nested, neighbor, policy);
    await expect(probe()).rejects.toThrow("confiança cadastrada");
    expect(
      (await prepareProjectGit(fixture.project, { run: createGitRunner(fixture.env) })).verified,
    ).toBe(2);
    await probe();
    const ordinaryCall = call.getMockImplementation()!;
    call.mockImplementation(async (method, params) => {
      if (params.command.includes(neighbor)) throw new Error("spawn EPERM");
      return ordinaryCall(method, params);
    });
    await expect(probe()).rejects.toThrow("EPERM");
    call.mockImplementation(async (method, params) => {
      if (params.command.includes(neighbor))
        throw new Error(
          "sandbox denied exec error: fatal: detected dubious ownership in repository",
        );
      return ordinaryCall(method, params);
    });
    await probe();
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

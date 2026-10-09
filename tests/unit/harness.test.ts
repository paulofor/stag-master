import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { createGitRunner, prepareProjectGit } from "../../src/main/project-git";

it("Playwright isola porta por execução e workers herdam a porta sem reutilizar servidor alheio", async () => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP)$/i.test(key)),
  );
  const code = `const { default: config } = await import(${JSON.stringify(pathToFileURL(resolve("playwright.config.ts")).href)}); console.log(JSON.stringify({ baseURL: config.use.baseURL, server: config.webServer, port: process.env.STAG_E2E_PORT }));`;
  const load = async (port?: string) => {
    const result = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      { env: { ...env, ...(port ? { STAG_E2E_PORT: port } : {}) } },
    );
    return JSON.parse(result.stdout);
  };
  const first = await load();
  const occupied = createServer();
  await new Promise<void>((done, reject) => {
    occupied.once("error", reject);
    occupied.listen(Number(first.port), "127.0.0.1", done);
  });
  try {
    const other = await load();
    expect(other.port).not.toBe(first.port);
    expect(other.server.reuseExistingServer).toBe(false);
    expect(other.server.url).toBe(other.baseURL);
    expect(other.server.command).toContain(`--port ${other.port} --strictPort`);
    expect((await load(first.port)).baseURL).toBe(first.baseURL);
    await expect(load("invalid")).rejects.toThrow();
  } finally {
    await new Promise<void>((done) => occupied.close(() => done()));
  }
});

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

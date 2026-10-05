import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execute = promisify(execFile);

// Shared by unit and native Electron: real Git, synthetic repositories, isolated global config.
export async function gitFixture(dir) {
  const home = join(dir, "git-home");
  const project = join(dir, "projeto-fixture");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "xdg"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  // Resolve before entering Codex: its computed command environment can have a different PATH.
  let executable;
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === "win32" ? "git.exe" : "git");
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch {
      /* Try the next installed location. */
    }
  }
  if (!executable) throw new Error("Git indisponível no harness isolado.");
  const git = async (args, extra = {}) => {
    try {
      const { stdout } = await execute(executable, args, {
        cwd: home,
        env: { ...env, ...extra },
        encoding: "utf8",
        windowsHide: true,
      });
      return { code: 0, stdout };
    } catch (error) {
      // Never surface stderr/command lines; some test values deliberately resemble credentials.
      if (typeof error.code === "number")
        return {
          code: error.code,
          stdout: error.stdout || "",
          dubiousOwnership: /detected dubious ownership/.test(error.stderr || ""),
        };
      throw new Error("Git indisponível no harness isolado.");
    }
  };
  const init = async (path) => {
    await mkdir(path, { recursive: true });
    if ((await git(["init", "--initial-branch=main", path])).code !== 0)
      throw new Error("Falha ao criar repositório sintético.");
  };
  return { home, project, env, git, init, executable };
}

// Exercise Git itself through the production sandbox API, without a second Node process launcher.
export async function verifySandboxGit(rpc, executable, project, nested, neighbor, sandboxPolicy) {
  for (const repository of [project, nested, neighbor]) {
    let result;
    try {
      result = await rpc.call("command/exec", {
        command: [
          executable,
          "--no-optional-locks",
          "-C",
          repository,
          "status",
          "--short",
          "--branch",
        ],
        env: { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
        cwd: project,
        sandboxPolicy,
        timeoutMs: 15000,
      });
    } catch (error) {
      // Windows can return a nonzero exit as an RPC error. Only this Git diagnostic proves ownership denial.
      if (repository === neighbor && /detected dubious ownership/.test(error.message)) continue;
      throw error;
    }
    if (repository === neighbor) {
      assert.notEqual(result.exitCode, 0);
      assert.match(
        result.stderr,
        /detected dubious ownership/,
        "Vizinho deve ser bloqueado por propriedade, não por falha de inicialização.",
      );
    } else
      assert.equal(
        result.exitCode,
        0,
        "O sandbox deve reconhecer a confiança cadastrada pelo main.",
      );
  }
}

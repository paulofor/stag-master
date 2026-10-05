import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

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
  const git = async (args, extra = {}) => {
    try {
      const { stdout } = await execute("git", args, {
        cwd: home,
        env: { ...env, ...extra },
        encoding: "utf8",
        windowsHide: true,
      });
      return { code: 0, stdout };
    } catch (error) {
      // Never surface stderr/command lines; some test values deliberately resemble credentials.
      if (typeof error.code === "number") return { code: error.code, stdout: error.stdout || "" };
      throw new Error("Git indisponível no harness isolado.");
    }
  };
  const init = async (path) => {
    await mkdir(path, { recursive: true });
    if ((await git(["init", "--initial-branch=main", path])).code !== 0)
      throw new Error("Falha ao criar repositório sintético.");
  };
  return { home, project, env, git, init };
}

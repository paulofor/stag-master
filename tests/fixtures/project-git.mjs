import { execFile } from "node:child_process";
import { access, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
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
      if (typeof error.code === "number") return { code: error.code, stdout: error.stdout || "" };
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

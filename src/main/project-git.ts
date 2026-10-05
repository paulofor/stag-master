import { spawn } from "node:child_process";
import { lstat, opendir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProjectGitReport } from "../shared/types";

type GitResult = { code: number; stdout: string };
export type GitRunner = (args: string[], signal?: AbortSignal) => Promise<GitResult>;

class GitFailure extends Error {}

/** No shell, repository cwd, inherited Git overrides or authentication payloads. */
export function createGitRunner(
  base: NodeJS.ProcessEnv = process.env,
  executable = process.platform === "win32" ? "git.exe" : "git",
  timeoutMs = 15000,
): GitRunner {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(base).filter(
      ([key]) =>
        !/^GIT_|^GCM_|^SSH_|TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|^NODE_OPTIONS$|^LD_|^DYLD_/i.test(
          key,
        ),
    ),
  );
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "PATH")
      env[key] = env[key]
        ?.split(delimiter)
        .filter((path) => isAbsolute(path))
        .join(delimiter);
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
  return (args, signal) =>
    new Promise((done, reject) => {
      if (signal?.aborted) return reject(new GitFailure("Preparação Git interrompida."));
      const child = spawn(executable, args, {
        cwd: base.HOME || base.USERPROFILE || homedir(),
        env,
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      let bytes = 0;
      let failure: GitFailure | null = null;
      const stop = (message: string) => {
        failure ||= new GitFailure(message);
        child.kill();
      };
      const abort = () => stop("Preparação Git interrompida.");
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => stop("O Git excedeu o tempo de verificação."), timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data: string) => {
        bytes += Buffer.byteLength(data);
        if (bytes > 1024 * 1024) stop("A saída do Git excedeu o limite de verificação.");
        else stdout += data;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        failure = new GitFailure(
          error.code === "ENOENT"
            ? "Git não encontrado. Instale o Git for Windows, reabra o STAG e selecione a pasta novamente."
            : "Não foi possível iniciar o Git. Verifique a instalação e o acesso do usuário.",
        );
      });
      // Wait for close even on timeout/abort; a failed child must not overlap the next one.
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) reject(failure);
        else done({ code: code ?? -1, stdout });
      });
      if (signal?.aborted) abort();
    });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
function gitPath(path: string): string {
  return process.platform === "win32" ? path.replaceAll("\\", "/") : path;
}
function pathKey(path: string): string {
  const normalized = gitPath(path).replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function checkedPath(root: string, path: string, directory: boolean): Promise<string> {
  if (!inside(root, path)) throw new Error("Caminho fora da pasta selecionada.");
  const resolved = await realpath(path);
  if (!inside(root, resolved) || pathKey(resolved) !== pathKey(path))
    throw new Error("Link ou caminho redirecionado.");
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()))
    throw new Error("Tipo de arquivo inválido.");
  return resolved;
}

async function smallFile(root: string, path: string): Promise<string> {
  await checkedPath(root, path, false);
  if ((await lstat(path)).size > 8192) throw new Error("Metadados Git inválidos.");
  return readFile(path, "utf8");
}

/** Support worktrees/submodules only when their administrative paths also stay in the root. */
async function gitDirectory(root: string, repository: string): Promise<string> {
  await checkedPath(root, repository, true);
  let path = join(repository, ".git");
  const info = await lstat(path);
  if (info.isFile()) {
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(await smallFile(root, path));
    if (!pointer) throw new Error("Arquivo .git inválido.");
    path = resolve(repository, pointer[1].trim());
  }
  await checkedPath(root, path, true);
  let common = path;
  try {
    const pointer = (await smallFile(root, join(path, "commondir"))).trim();
    if (!pointer || /[\r\n\0]/.test(pointer)) throw new Error("commondir inválido.");
    common = resolve(path, pointer);
    await checkedPath(root, common, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await smallFile(root, join(path, "HEAD"));
  await checkedPath(root, join(common, "objects"), true);
  await checkedPath(root, join(common, "refs"), true);
  // Config files may be absent (new repositories), but must not be links to other projects.
  for (const file of [join(common, "config"), join(path, "config.worktree")]) {
    try {
      await checkedPath(root, file, false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return path;
}

export async function prepareProjectGit(
  root: string,
  options: {
    run?: GitRunner;
    signal?: AbortSignal;
    onProgress?: (report: ProjectGitReport) => void;
    maxDirectories?: number;
    maxRepositories?: number;
    maxDurationMs?: number;
  } = {},
): Promise<ProjectGitReport> {
  const report: ProjectGitReport = {
    phase: "scanning",
    scanned: 0,
    found: 0,
    added: 0,
    verified: 0,
    skipped: 0,
    failures: 0,
    incomplete: false,
    issues: [],
  };
  const issue = (path: string, message: string) => {
    report.failures++;
    if (report.issues.length < 30)
      report.issues.push({ path: relative(root, path) || ".", message });
  };
  const publish = () => options.onProgress?.(structuredClone(report));
  const run = options.run || createGitRunner();
  const deadline = Date.now() + (options.maxDurationMs ?? 120000);
  const expired = () => options.signal?.aborted || Date.now() >= deadline;
  const pending = [root];
  const repositories: string[] = [];
  publish();
  while (pending.length && !expired()) {
    const path = pending.pop()!;
    if (report.scanned >= (options.maxDirectories ?? 20000)) {
      report.incomplete = true;
      break;
    }
    try {
      await checkedPath(root, path, true);
      const entries = await opendir(path);
      report.scanned++;
      for await (const entry of entries) {
        if (expired()) {
          report.incomplete = true;
          break;
        }
        if (entry.name.toLowerCase() === ".git") {
          if (repositories.length >= (options.maxRepositories ?? 200)) {
            report.incomplete = true;
            break;
          }
          report.found++;
          repositories.push(path);
        } else if (entry.isSymbolicLink()) report.skipped++;
        else if (entry.isDirectory()) {
          if (pending.length + report.scanned >= (options.maxDirectories ?? 20000))
            report.incomplete = true;
          else pending.push(join(path, entry.name));
        }
      }
    } catch {
      issue(path, "Pasta inacessível ou redirecionada; não foi percorrida.");
    }
    if (report.scanned % 100 === 0) publish();
  }
  if (expired()) report.incomplete = true;

  let trusted: Set<string> | null = null;
  for (const repository of repositories) {
    if (expired()) {
      report.incomplete = true;
      break;
    }
    try {
      if (gitPath(repository).endsWith("/*")) throw new Error("Raiz com curinga Git.");
      await gitDirectory(root, repository);
    } catch {
      issue(repository, "Metadados .git inválidos, inacessíveis ou fora da pasta; não autorizado.");
      continue;
    }
    try {
      if (!trusted) {
        const existing = await run(
          ["config", "--global", "--includes", "--null", "--get-all", "safe.directory"],
          options.signal,
        );
        if (existing.code !== 0 && existing.code !== 1)
          throw new GitFailure(
            "Não foi possível ler a configuração global do Git. Verifique seu acesso e selecione a pasta novamente.",
          );
        const values = existing.stdout.split("\0");
        values.pop();
        // An empty value resets previous entries, including ones loaded through includes.
        trusted = new Set(values.slice(values.lastIndexOf("") + 1).map(pathKey));
      }
      await gitDirectory(root, repository);
      if (!trusted.has(pathKey(repository))) {
        const result = await run(
          ["config", "--global", "--add", "safe.directory", gitPath(repository)],
          options.signal,
        );
        if (result.code !== 0)
          throw new GitFailure(
            "Não foi possível cadastrar a confiança Git. Verifique se a configuração global está bloqueada e selecione a pasta novamente.",
          );
        report.added++;
        trusted.add(pathKey(repository));
      }
      await gitDirectory(root, repository);
      // Keep normal repository discovery: --git-dir would bypass Git's ownership check.
      const location = ["-C", repository];
      const filters = await run(
        [
          ...location,
          "config",
          "--includes",
          "--name-only",
          "--get-regexp",
          "^filter\\..*\\.(clean|smudge|process|required)$",
        ],
        options.signal,
      );
      if (![0, 1].includes(filters.code))
        throw new GitFailure("Não foi possível verificar os filtros locais do Git.");
      const filterOverrides = filters.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((key) => {
          if (!/^filter\.[^\r\n\0]+\.(clean|smudge|process|required)$/.test(key))
            throw new GitFailure("Filtro Git inválido; verificação interrompida.");
          return ["-c", `${key}=${key.endsWith(".required") ? "false" : ""}`];
        });
      // Override callbacks/worktree redirection from the now-trusted local config. No network,
      // submodule traversal, optional index write, credential access or raw output in the UI.
      await gitDirectory(root, repository);
      const status = await run(
        [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=",
          "-c",
          `core.worktree=${gitPath(repository)}`,
          "-c",
          "core.bare=false",
          "-c",
          "submodule.recurse=false",
          "-c",
          "status.submoduleSummary=false",
          "-c",
          "protocol.allow=never",
          "-c",
          "credential.helper=",
          ...filterOverrides,
          ...location,
          "status",
          "--short",
          "--branch",
          "--ignore-submodules=all",
        ],
        options.signal,
      );
      if (status.code !== 0)
        issue(
          repository,
          "Confiança cadastrada, mas o status Git falhou. Verifique o repositório e as permissões de arquivos; selecione a pasta novamente para tentar.",
        );
      else report.verified++;
    } catch (error) {
      issue(
        repository,
        error instanceof GitFailure
          ? error.message
          : "Falha na preparação Git. Selecione a pasta novamente para tentar.",
      );
      // Missing Git/config failure affects all remaining repos; avoid spawning repeatedly.
      if (!trusted) {
        report.incomplete = true;
        break;
      }
    }
    publish();
  }
  if (report.incomplete)
    issue(
      root,
      "Busca incompleta ou interrompida. Selecione uma subpasta menor para verificar os repositórios restantes.",
    );
  report.phase = "complete";
  publish();
  return report;
}

export function projectGitInstructions(report?: ProjectGitReport): string {
  const result = report
    ? `Na última seleção: ${report.found} repositórios encontrados, ${report.added} raízes cadastradas, ${report.verified} status verificados, ${report.failures} falhas. Busca ${report.incomplete ? "incompleta" : "concluída"}.`
    : "Não há resultado de preparação Git nesta sessão.";
  return `Preparação Git: ao selecionar uma pasta, o STAG procura .git nela e nas subpastas, cadastra cada raiz exata em safe.directory global do usuário e verifica status. ${result} Isso trata confiança de propriedade, não autenticação remota nem permissões NTFS/GPO. Não peça usuário/senha para resolver dubious ownership, não use safe.directory=* nem amplie confiança para fora do projeto. Se houver falha, consulte o aviso da interface e oriente selecionar a pasta novamente após corrigir a causa; não afirme sucesso sem verificação. Init, retomada e modo Leitura não fazem novo cadastro automático. Preserve a política de acesso e continue tarefas independentes do Git.`;
}

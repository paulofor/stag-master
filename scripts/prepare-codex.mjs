import { createRequire } from "node:module";
import { cp, mkdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);

export async function prepareCodex() {
  const triplets = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
  };
  const platform = `${process.platform}-${process.arch}`;
  const triplet = triplets[platform];
  if (!triplet) throw new Error(`Plataforma não suportada: ${platform}`);
  const packageRoot = dirname(require.resolve(`@openai/codex-${platform}/package.json`));
  const source = join(packageRoot, "vendor", triplet);
  await stat(join(source, "bin", process.platform === "win32" ? "codex.exe" : "codex"));
  await mkdir(".local", { recursive: true });
  await rm(".local/codex", { recursive: true, force: true });
  if (process.platform === "win32") await cp(source, ".local/codex", { recursive: true });
  else await symlink(source, ".local/codex", "dir");
}

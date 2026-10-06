import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, cp, chmod, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import lock from "../native/media-lock.json" with { type: "json" };

const run = promisify(execFile);
async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(url, destination, expected) {
  if (
    await digest(destination).then(
      (value) => value === expected,
      () => false,
    )
  )
    return;
  const temp = destination + ".download";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!response.ok || !response.body)
      throw new Error(`Download de dependência falhou: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(temp));
    if ((await digest(temp)) !== expected)
      throw new Error("Checksum de dependência de mídia divergente.");
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function prepareMedia() {
  const platform = `${process.platform}-${process.arch}`;
  const hashes = lock.ffmpeg[platform];
  if (!hashes) throw new Error(`Mídia: plataforma não suportada: ${platform}`);
  const root = resolve(".local/media");
  const buildRoot = resolve(".local/media-build");
  await mkdir(root, { recursive: true });
  await mkdir(buildRoot, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe", "LICENSE", "README"]) {
    const binary = name === "ffmpeg" || name === "ffprobe";
    const asset = binary ? `${name}-${platform}` : `${platform}.${name}`;
    const dest = join(
      root,
      binary ? name + (process.platform === "win32" ? ".exe" : "") : `FFMPEG-${name}`,
    );
    await download(`${lock.ffmpeg.release}/${asset}`, dest, hashes[name]);
    if (binary) await chmod(dest, 0o755);
  }
  await download(lock.model.url, join(root, "ggml-base-q5_1.bin"), lock.model.sha256);
  const sourceArchive = join(buildRoot, "whisper.tar.gz");
  await download(lock.whisper.url, sourceArchive, lock.whisper.sha256);
  const source = join(buildRoot, "source");
  await mkdir(source, { recursive: true });
  await run("tar", ["-xzf", sourceArchive, "--strip-components=1", "-C", source]);
  const executable = "whisper-cli" + (process.platform === "win32" ? ".exe" : "");
  const stamp = JSON.stringify({
    whisper: lock.whisper,
    platform,
    build: process.platform === "win32" ? "cpu-static-crt-v2" : "cpu-static-v1",
  });
  const current = await readFile(join(root, "build.json"), "utf8").catch(() => "");
  const ready = await stat(join(root, executable)).then(
    (info) => info.isFile() && info.size > 0,
    () => false,
  );
  if (current !== stamp || !ready) {
    const output = join(buildRoot, "build");
    console.log("Preparando transcrição local (whisper.cpp CPU)…");
    await run(
      "cmake",
      [
        "-S",
        source,
        "-B",
        output,
        ...(process.platform === "win32"
          ? [
              "-A",
              "x64",
              "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded",
              "-DCMAKE_POLICY_DEFAULT_CMP0091=NEW",
            ]
          : []),
        "-DCMAKE_BUILD_TYPE=Release",
        "-DBUILD_SHARED_LIBS=OFF",
        "-DWHISPER_BUILD_TESTS=OFF",
        "-DWHISPER_BUILD_SERVER=OFF",
        "-DWHISPER_CURL=OFF",
        "-DGGML_NATIVE=OFF",
        "-DGGML_OPENMP=OFF",
        "-DGGML_AVX=OFF",
        "-DGGML_AVX2=OFF",
        "-DGGML_FMA=OFF",
        "-DGGML_F16C=OFF",
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    await run(
      "cmake",
      ["--build", output, "--config", "Release", "--target", "whisper-cli", "--parallel", "2"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    await cp(
      join(output, "bin", ...(process.platform === "win32" ? ["Release"] : []), executable),
      join(root, executable),
    );
    await writeFile(join(root, "build.json"), stamp);
  }
  await cp(join(source, "LICENSE"), join(root, "WHISPER-LICENSE"));
  await cp("native/media-NOTICES.md", join(root, "NOTICES.md"));
  console.log("Ferramentas de vídeo e modelo local verificados.");
}
if (process.argv[1] === resolve("scripts/prepare-media.mjs")) await prepareMedia();

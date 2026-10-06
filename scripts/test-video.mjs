import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/video-integration-"));
const resources = resolve(".local/media");
const ffmpeg = join(resources, "ffmpeg" + (process.platform === "win32" ? ".exe" : ""));
const run = promisify(execFile);
// project-speech.wav is synthetic speech (FFmpeg flite, voice slt, mono PCM 16 kHz):
// "The project manages customer orders. Every order needs approval before shipping."
// It contains no recording or voice from a customer; ASR results are tested semantically
// only for this fixed phrase. The RPC fixture is not a real LLM quality evaluation.
let service;
let rpc;
try {
  await build({
    entryPoints: [
      "src/main/request-video.ts",
      "src/main/service.ts",
      "src/main/rpc.ts",
      "src/main/settings.ts",
      "src/main/policy.ts",
    ],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { prepareVideo } = await import(pathToFileURL(join(dir, "request-video.mjs")).href);
  const file = join(dir, "projeto-sintetico.mp4");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=640x360:r=10",
    "-i",
    resolve("tests/fixtures/project-speech.wav"),
    "-t",
    "6",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-threads",
    "2",
    file,
  ]);
  const phases = [];
  const video = await prepareVideo(
    file,
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    (phase) => phases.push(phase),
  );
  assert.equal(video.summary.audio, "transcribed");
  assert.ok(
    video.transcript.some((entry) => /order.*approval|approval.*shipping/i.test(entry.text)),
    "ASR local deve reconhecer a regra sintética de pedidos.",
  );
  assert.ok(video.frames[0].image.dataUrl.startsWith("data:image/jpeg;base64,"));
  assert.ok(phases.some((phase) => phase.includes("Transcrevendo")));
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
  const { AssistantService } = await import(pathToFileURL(join(dir, "service.mjs")).href);
  const { RpcClient } = await import(pathToFileURL(join(dir, "rpc.mjs")).href);
  const { SettingsStore } = await import(pathToFileURL(join(dir, "settings.mjs")).href);
  const { codexEnvironment } = await import(pathToFileURL(join(dir, "policy.mjs")).href);
  const project = join(dir, "project");
  await mkdir(project);
  rpc = new RpcClient({
    command: process.execPath,
    args: [resolve("tests/fixtures/app-server.mjs")],
    cwd: project,
    env: codexEnvironment(join(dir, "home")),
  });
  service = new AssistantService({
    createRpc: () => rpc,
    store: new SettingsStore(join(dir, "settings.json")),
    selectProject: async () => project,
    openExternal: async (url) => {
      assert.equal(new URL(url).hostname, "auth.openai.com");
    },
    desktop: {
      execute: async () => {
        throw new Error("No desktop in video harness");
      },
      confirmationReason: async () => null,
    },
    video: { select: async () => file, prepare: async () => video },
  });
  await service.init();
  await service.request({ type: "connect" });
  await service.request({ type: "login" });
  const idle = async (predicate) => {
    if (predicate()) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        service.off("snapshot", listener);
        reject(new Error("Synthetic video flow did not finish"));
      }, 30000);
      const listener = () => {
        if (predicate()) {
          clearTimeout(timer);
          service.off("snapshot", listener);
          resolve();
        }
      };
      service.on("snapshot", listener);
    });
  };
  await idle(() => service.snapshot().models.length > 0);
  await service.request({ type: "selectProject" });
  await service.request({ type: "selectVideo" });
  await service.request({ type: "send", text: "", videoId: video.summary.id });
  await idle(() => !service.snapshot().busy);
  assert.match(
    await readFile(join(project, ".stag/negocio.md"), "utf8"),
    /aprovação antes do envio/,
  );
  assert.match(service.snapshot().items.at(-1).text, /anotações sintéticas verificadas/);
  const silent = join(dir, "sem-fala.webm");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=2",
    "-t",
    "41",
    "-c:v",
    "libvpx-vp9",
    "-threads",
    "2",
    silent,
  ]);
  const silentResult = await prepareVideo(
    silent,
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    () => {},
  );
  assert.equal(silentResult.summary.audio, "silent");
  assert.equal(silentResult.frames.length, 3);
  assert.ok(silentResult.frames[2].seconds > 40);
  const invalid = join(dir, "invalido.mp4");
  await writeFile(invalid, "#EXTM3U\nhttps://fixture.invalid/never-request\n");
  await assert.rejects(
    prepareVideo(invalid, resources, join(dir, "tmp"), new AbortController().signal, () => {}),
    /Não foi possível preparar/,
  );
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
  const recovered = await prepareVideo(
    silent,
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    () => {},
  );
  assert.equal(recovered.frames.length, 3);
  for (const [name, source, seconds] of [
    ["long", "color=s=64x64:r=1", "601"],
    ["wide", "color=s=5000x64:r=1", "1"],
  ]) {
    const rejected = join(dir, `${name}.mp4`);
    await run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      source,
      "-t",
      seconds,
      "-c:v",
      "libx264",
      "-threads",
      "2",
      rejected,
    ]);
    await assert.rejects(
      prepareVideo(rejected, resources, join(dir, "tmp"), new AbortController().signal, () => {}),
      /Vídeo inválido/,
    );
    assert.deepEqual(await readdir(join(dir, "tmp")), []);
  }
  console.log(
    "Vídeo sintético: decoder/ASR reais, envio pelo serviço/RPC, memória determinística verificada, quadros temporais, arquivo inválido, limpeza e recuperação OK.",
  );
} finally {
  service?.dispose();
  await service?.mediaSettled();
  await rpc?.shutdown();
  await rm(dir, { recursive: true, force: true });
}

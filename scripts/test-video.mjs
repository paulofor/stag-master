import assert from "node:assert/strict";
import { readdirSync, statSync, utimesSync } from "node:fs";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile, open, stat } from "node:fs/promises";
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
  const { prepareVideo, inspectVideo, prepareVideoSegment, validateVideoSource } = await import(
    pathToFileURL(join(dir, "request-video.mjs")).href
  );
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
  // A valid short MP4 with sparse padding exercises disk reads without allocating its size.
  const shortOriginalSize = (await stat(file)).size;
  const shortPaddingSize = 64 * 1024 * 1024;
  const shortHeader = Buffer.alloc(8);
  shortHeader.writeUInt32BE(shortPaddingSize, 0);
  shortHeader.write("free", 4);
  const shortHandle = await open(file, "r+");
  await shortHandle.write(shortHeader, 0, shortHeader.length, shortOriginalSize);
  await shortHandle.truncate(shortOriginalSize + shortPaddingSize);
  await shortHandle.close();
  const shortMemoryBefore = process.resourceUsage().maxRSS;
  const phases = [];
  const video = await prepareVideo(
    file,
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    (phase) => {
      phases.push(phase);
      let temporaryBytes = 0;
      for (const folder of readdirSync(join(dir, "tmp")))
        for (const output of readdirSync(join(dir, "tmp", folder)))
          temporaryBytes += statSync(join(dir, "tmp", folder, output)).size;
      // Independent of output names: bounded frames, PCM audio and JSON fit this budget,
      // whereas a copy of the sparse 64-MiB original cannot.
      assert.ok(
        temporaryBytes < 4 * 1024 * 1024 + 600 * 16000 * 2 + 1024 * 1024,
        "Temporary outputs must stay bounded without a copy of the original video",
      );
    },
  );
  const shortRssGrowthKiB = process.resourceUsage().maxRSS - shortMemoryBefore;
  assert.ok(
    shortRssGrowthKiB < 48 * 1024,
    `Short video heap/RSS unexpectedly grew: ${shortRssGrowthKiB} KiB`,
  );
  console.log(
    `Anexo curto sintético >64 MB: decoder/ASR direto do disco, sem cópia integral, crescimento de pico RSS ${shortRssGrowthKiB} KiB.`,
  );
  assert.equal(video.summary.audio, "transcribed");
  assert.equal(video.frames.length, 3, "Vídeos curtos devem incluir início, meio e fim.");
  assert.equal(video.frames[0].seconds, 0);
  assert.ok(video.frames.at(-1).seconds >= 5.5);
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
  assert.equal(silentResult.frames.length, 5);
  assert.ok(silentResult.frames.at(-1).seconds > 40);
  const beforeChange = await stat(silent);
  await assert.rejects(
    prepareVideo(silent, resources, join(dir, "tmp"), new AbortController().signal, (phase) => {
      if (phase.includes("imagem 5 de 5"))
        utimesSync(silent, beforeChange.atime, new Date(beforeChange.mtimeMs + 5000));
    }),
    /O arquivo mudou/,
  );
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
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
  assert.equal(recovered.frames.length, 5);
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
  // Real multi-GB input, sparse on disk: valid MP4 with a large `free` atom.
  // Detect the old Buffer.alloc(file.size)/whole-file copy without creating customer media.
  const long = join(dir, "long.mp4");
  const originalSize = (await stat(long)).size;
  const handle = await open(long, "r+");
  const freeSize = 3 * 1024 * 1024 * 1024;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(freeSize, 0);
  header.write("free", 4);
  await handle.write(header, 0, header.length, originalSize);
  await handle.truncate(originalSize + freeSize);
  await handle.close();
  const memoryBefore = process.resourceUsage().maxRSS;
  const source = await inspectVideo(long, resources, new AbortController().signal);
  assert.equal(source.seconds, 601);
  assert.ok(source.size > 3 * 1024 * 1024 * 1024);
  const sampled = [];
  for (let index = 0; index < 3; index++) {
    const part = await prepareVideoSegment(
      source,
      index,
      "22222222-2222-4222-8222-222222222222",
      resources,
      join(dir, "tmp"),
      new AbortController().signal,
      () => {},
    );
    assert.equal(part.summary.segment.start, index * 300);
    assert.equal(part.summary.segment.end, Math.min(601, (index + 1) * 300));
    assert.ok(
      part.frames.every(
        (frame) => frame.seconds >= index * 300 && frame.seconds < part.summary.segment.end,
      ),
    );
    assert.ok(part.frames.length <= 12);
    sampled.push(part.frames.length);
    assert.deepEqual(await readdir(join(dir, "tmp")), []);
  }
  const rssGrowthKiB = process.resourceUsage().maxRSS - memoryBefore;
  assert.ok(
    rssGrowthKiB < 192 * 1024,
    `Bounded media RSS growth exceeded 192 MiB: ${rssGrowthKiB} KiB`,
  );
  console.log(
    `Vídeo longo sintético: original esparso >3 GB, 3 trechos/601s, ${sampled.join("/")} quadros, crescimento de pico RSS ${rssGrowthKiB} KiB, sem cópia integral.`,
  );
  const changed = await open(long, "r+");
  await changed.write(Buffer.from([1]), 0, 1, originalSize + freeSize - 1);
  await changed.close();
  await assert.rejects(
    validateVideoSource(source, new AbortController().signal),
    /O arquivo mudou/,
  );
  await assert.rejects(
    prepareVideoSegment(
      source,
      3,
      "22222222-2222-4222-8222-222222222222",
      resources,
      join(dir, "tmp"),
      new AbortController().signal,
      () => {},
    ),
    /Vídeo inválido/,
  );
  // Speech in a later segment must retain absolute times after bounded audio extraction.
  const spoken = join(dir, "fala-temporal.mp4");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=s=160x90:r=1",
    "-i",
    resolve("tests/fixtures/project-speech.wav"),
    "-filter:a",
    "adelay=300000:all=1",
    "-t",
    "306",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-threads",
    "2",
    spoken,
  ]);
  const speechSource = await inspectVideo(spoken, resources, new AbortController().signal);
  const speechPart = await prepareVideoSegment(
    speechSource,
    1,
    "22222222-2222-4222-8222-222222222222",
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    () => {},
  );
  assert.ok(
    speechPart.transcript.some((entry) => /order.*approval|approval.*shipping/i.test(entry.text)),
  );
  assert.ok(speechPart.transcript.every((entry) => entry.start >= 300 && entry.end <= 308));
  const audioTail = join(dir, "fala-apos-imagens.mp4");
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-t",
    "300",
    "-i",
    "color=s=160x90:r=1",
    "-i",
    resolve("tests/fixtures/project-speech.wav"),
    "-filter:a",
    "adelay=300000:all=1",
    "-t",
    "306",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-threads",
    "2",
    audioTail,
  ]);
  const tailSource = await inspectVideo(audioTail, resources, new AbortController().signal);
  const tailPart = await prepareVideoSegment(
    tailSource,
    1,
    "22222222-2222-4222-8222-222222222222",
    resources,
    join(dir, "tmp"),
    new AbortController().signal,
    () => {},
  );
  assert.equal(
    tailPart.frames.length,
    0,
    "No image may be fabricated/reused when the video track has ended.",
  );
  assert.ok(
    tailPart.transcript.some((entry) => /order.*approval|approval.*shipping/i.test(entry.text)),
  );
  assert.ok(
    tailPart.transcript.every((entry) => entry.start >= 300 && entry.end <= tailSource.seconds),
  );
  assert.deepEqual(await readdir(join(dir, "tmp")), []);
  console.log(
    "Vídeo sintético: decoder/ASR reais, envio pelo serviço/RPC, memória determinística verificada, quadros temporais, arquivo inválido, limpeza e recuperação OK.",
  );
} finally {
  service?.dispose();
  await service?.mediaSettled();
  await rpc?.shutdown();
  await rm(dir, { recursive: true, force: true });
}

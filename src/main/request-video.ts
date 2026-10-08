import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { z } from "zod";
import {
  requestImageSchema,
  requestImageBytes,
  maxRequestImageBytes,
} from "../shared/request-images";
import {
  maxVideoBytes,
  maxBackgroundVideoBytes,
  maxBackgroundVideoSeconds,
  videoSegmentSeconds,
  maxVideoSeconds,
  maxVideoFrames,
  maxVideoTranscriptLength,
  videoExtensions,
  videoTime,
  type VideoSummary,
} from "../shared/request-video";
import type { RequestImage } from "../shared/types";

export interface PreparedVideo {
  summary: VideoSummary;
  frames: { seconds: number; image: RequestImage }[];
  transcript: { start: number; end: number; text: string }[];
}
export interface VideoProcessor {
  select(): Promise<string | null>;
  prepare(
    path: string,
    signal: AbortSignal,
    progress: (phase: string) => void,
  ): Promise<PreparedVideo>;
}

// Deliberately keep raw subprocess output, filenames and media content out of errors/logs.
export function runMedia(
  binary: string,
  args: string[],
  signal: AbortSignal,
  timeoutMs = 120000,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      windowsHide: true,
      cwd: dirname(binary),
      stdio: ["ignore", "pipe", "ignore"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"].includes(key),
        ),
      ),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const stop = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    child.on("error", () => {
      failed = true;
    });
    // Wait for close, including abort/timeout, before cleaning up files or starting another job.
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(new Error("Preparação de vídeo cancelada."));
      else if (failed || code !== 0)
        reject(
          new Error(
            "Não foi possível preparar o vídeo. Verifique o arquivo ou tente um trecho menor.",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export const videoSourceSchema = z.object({
  path: z.string().min(1).max(32768),
  name: z.string().min(1).max(180),
  size: z.number().positive().max(maxBackgroundVideoBytes),
  mtimeMs: z.number().nonnegative(),
  dev: z.number(),
  ino: z.number(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  seconds: z.number().positive().max(maxBackgroundVideoSeconds),
  audio: z.boolean(),
});
export type VideoSource = z.infer<typeof videoSourceSchema>;
export interface BackgroundVideoProcessor {
  inspect(path: string, signal: AbortSignal): Promise<VideoSource>;
  prepare(
    source: VideoSource,
    index: number,
    id: string,
    signal: AbortSignal,
    progress: (phase: string) => void,
  ): Promise<PreparedVideo>;
  validate(source: VideoSource, signal: AbortSignal): Promise<void>;
}

const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().positive().max(maxBackgroundVideoSeconds) }),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        avg_frame_rate: z.string().max(100).optional(),
      }),
    )
    .max(16),
});
const transcriptionSchema = z.object({
  transcription: z
    .array(
      z.object({
        offsets: z.object({ from: z.number().nonnegative(), to: z.number().nonnegative() }),
        text: z.string().max(maxVideoTranscriptLength),
      }),
    )
    .max(2000),
});
export function normalizeVideoTranscript(
  value: unknown,
  start: number,
  duration: number,
): PreparedVideo["transcript"] {
  const result = transcriptionSchema.parse(value);
  // Whisper predicts timestamp tokens within 30-second windows, including padded audio.
  // Keep valid speech within the actual chunk, without accepting unbounded/future offsets.
  if (
    result.transcription.some(
      ({ offsets }) =>
        offsets.from / 1000 > duration + 1 ||
        offsets.to < offsets.from ||
        offsets.to / 1000 > duration + 30,
    ) ||
    result.transcription.reduce((sum, entry) => sum + entry.text.trim().length, 0) >
      maxVideoTranscriptLength
  )
    throw new Error("Transcrição inválida ou muito extensa. Envie um trecho menor.");
  return result.transcription
    .map(({ offsets, text }) => ({
      start: start + Math.min(duration, offsets.from / 1000),
      end: start + Math.min(duration, offsets.to / 1000),
      text: text.trim(),
    }))
    .filter((entry) => entry.text && entry.end > entry.start);
}
const localInput = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm",
  "-threads",
  "2",
];

function videoName(path: string): string {
  return (
    basename(path)
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .slice(0, 180) || "Vídeo"
  );
}
async function sourceIdentity(path: string, signal: AbortSignal) {
  if (!isAbsolute(path) || !videoExtensions.includes(extname(path).slice(1).toLowerCase()))
    throw new Error("Selecione um vídeo local MP4, MOV, MKV ou WebM pelo diálogo.");
  signal.throwIfAborted();
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size <= 0 || info.size > maxBackgroundVideoBytes)
    throw new Error("Selecione um arquivo de vídeo local com até 20 GB.");
  const canonical = await realpath(path).catch(() => null);
  if (!canonical) throw new Error("O arquivo de vídeo não está disponível. Selecione-o novamente.");
  const file = await open(path, "r").catch(() => null);
  if (!file) throw new Error("O arquivo de vídeo não está disponível. Selecione-o novamente.");
  try {
    const before = await file.stat();
    if (
      before.size !== info.size ||
      before.dev !== info.dev ||
      before.ino !== info.ino ||
      before.mtimeMs !== info.mtimeMs
    )
      throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
    // Fixed samples protect resume identity without allocating or hashing a multi-GB original.
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(Math.min(info.size, 65536));
    for (const offset of [0, Math.max(0, info.size - bytes.length)]) {
      signal.throwIfAborted();
      const result = await file.read(bytes, 0, bytes.length, offset);
      if (result.bytesRead !== bytes.length) throw new Error("O arquivo de vídeo está incompleto.");
      hash.update(bytes);
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
    return {
      path: canonical,
      name: videoName(path),
      size: info.size,
      mtimeMs: info.mtimeMs,
      dev: info.dev,
      ino: info.ino,
      fingerprint: hash.digest("hex"),
    };
  } finally {
    await file.close();
  }
}
export async function validateVideoSource(source: VideoSource, signal: AbortSignal): Promise<void> {
  const current = await sourceIdentity(source.path, signal);
  if (
    ["path", "size", "mtimeMs", "dev", "ino", "fingerprint"].some(
      (key) => current[key as keyof typeof current] !== source[key as keyof VideoSource],
    )
  )
    throw new Error(
      "O arquivo mudou. Selecione o vídeo novamente; o avanço anterior não será reutilizado.",
    );
}
export async function inspectVideo(
  path: string,
  resources: string,
  signal: AbortSignal,
): Promise<VideoSource> {
  const identity = await sourceIdentity(path, signal);
  try {
    const raw = await runMedia(
      join(resources, process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
      [
        "-v",
        "error",
        ...localInput,
        "-show_entries",
        "format=duration:stream=codec_type,width,height,avg_frame_rate",
        "-of",
        "json",
        identity.path,
      ],
      signal,
    );
    const parsed = probeSchema.safeParse(JSON.parse(raw));
    const video =
      parsed.success && parsed.data.streams.find((stream) => stream.codec_type === "video");
    if (
      !parsed.success ||
      !video ||
      !video.width ||
      !video.height ||
      video.width > 4096 ||
      video.height > 4096 ||
      video.width * video.height > 8_847_360
    )
      throw new Error(
        "Vídeo inválido: use até 12 horas e resolução máxima de 4096 pixels por lado (8,8 megapixels).",
      );
    const source = {
      ...identity,
      seconds: parsed.data.format.duration,
      audio: parsed.data.streams.some((stream) => stream.codec_type === "audio"),
    };
    await validateVideoSource(source, signal);
    return source;
  } catch (error) {
    if (signal.aborted) throw new Error("Preparação de vídeo cancelada.");
    if (error instanceof Error && /^(Vídeo inválido|O arquivo)/.test(error.message)) throw error;
    throw new Error("Não foi possível preparar o vídeo. Verifique o arquivo e tente novamente.");
  }
}
export function prepareVideoSegment(
  source: VideoSource,
  index: number,
  id: string,
  resources: string,
  temporaryRoot: string,
  signal: AbortSignal,
  progress: (phase: string) => void,
): Promise<PreparedVideo> {
  return prepareVideo(source.path, resources, temporaryRoot, signal, progress, {
    source,
    index,
    id,
  });
}

export async function prepareVideo(
  path: string,
  resources: string,
  temporaryRoot: string,
  signal: AbortSignal,
  progress: (phase: string) => void,
  segment?: { source: VideoSource; index: number; id: string },
): Promise<PreparedVideo> {
  const extension = extname(path).slice(1).toLowerCase();
  if (!videoExtensions.includes(extension))
    throw new Error("Selecione um vídeo MP4, MOV, MKV ou WebM.");
  const info = await lstat(path).catch(() => null);
  if (
    !info?.isFile() ||
    info.size <= 0 ||
    info.size > (segment ? maxBackgroundVideoBytes : maxVideoBytes)
  )
    throw new Error(
      segment
        ? "Selecione um arquivo de vídeo local com até 20 GB."
        : "Selecione um arquivo de vídeo local com até 100 MB.",
    );
  signal.throwIfAborted();
  let dir: string;
  try {
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    dir = await mkdtemp(join(temporaryRoot, "video-"));
  } catch {
    throw new Error(
      "Não foi possível preparar o vídeo: confira o espaço e o acesso ao armazenamento temporário.",
    );
  }
  const executable = (name: string) =>
    join(resources, name + (process.platform === "win32" ? ".exe" : ""));
  const run = (name: string, args: string[], timeout?: number) =>
    runMedia(executable(name), args, signal, timeout);
  try {
    progress("Verificando o vídeo…");
    let source: Pick<VideoSource, "path" | "size" | "mtimeMs" | "dev" | "ino" | "fingerprint">;
    if (segment) {
      videoSourceSchema.parse(segment.source);
      if (
        !Number.isInteger(segment.index) ||
        segment.index < 0 ||
        segment.index * videoSegmentSeconds >= segment.source.seconds
      )
        throw new Error("Vídeo inválido: trecho fora da duração do arquivo.");
      await validateVideoSource(segment.source, signal);
      if ((await realpath(path)) !== segment.source.path)
        throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
      source = segment.source;
    } else {
      source = await sourceIdentity(path, signal);
      if (
        ["size", "mtimeMs", "dev", "ino"].some(
          (key) => source[key as keyof typeof source] !== info[key as keyof typeof info],
        )
      )
        throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
    }
    // Decode directly from disk in both flows. The main keeps only fixed identity samples
    // and bounded outputs, never a copy or a buffer of the complete original.
    const input = source.path;
    const raw = await run("ffprobe", [
      "-v",
      "error",
      ...localInput,
      "-show_entries",
      "format=duration:stream=codec_type,width,height,avg_frame_rate",
      "-of",
      "json",
      input,
    ]);
    const parsed = probeSchema.safeParse(JSON.parse(raw));
    const video =
      parsed.success && parsed.data.streams.find((stream) => stream.codec_type === "video");
    if (
      !parsed.success ||
      (!segment && parsed.data.format.duration > maxVideoSeconds) ||
      !video ||
      !video.width ||
      !video.height ||
      video.width > 4096 ||
      video.height > 4096 ||
      video.width * video.height > 8_847_360
    )
      throw new Error(
        "Vídeo inválido: use até 10 minutos e resolução máxima de 4096 pixels por lado (8,8 megapixels).",
      );
    const seconds = parsed.data.format.duration;
    if (segment && Math.abs(seconds - segment.source.seconds) > 0.01)
      throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
    const start = segment ? segment.index * videoSegmentSeconds : 0;
    const duration = segment ? Math.min(videoSegmentSeconds, seconds - start) : seconds;
    const end = start + duration;
    const [rateNumerator, rateDenominator] = (video.avg_frame_rate || "0/0").split("/").map(Number);
    const frameMargin =
      rateNumerator > 0 && rateDenominator > 0 ? Math.max(0.5, rateDenominator / rateNumerator) : 1;
    const frames: PreparedVideo["frames"] = [];
    const count = Math.min(
      maxVideoFrames,
      Math.max(duration < 2 ? 1 : 3, Math.ceil(duration / 10)),
    );
    for (let index = 0; index < count; index++) {
      progress(`Extraindo imagem ${index + 1} de ${count}…`);
      const time =
        start +
        (count === 1
          ? segment
            ? 0
            : duration / 2
          : (index * Math.max(0, duration - frameMargin)) / (count - 1));
      const output = join(dir, "frame.jpg");
      // A seek with no decoded frame must not reuse the image from the preceding timestamp.
      await rm(output, { force: true });
      await run("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-y",
        ...localInput,
        "-ss",
        time.toFixed(3),
        "-i",
        input,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease",
        "-q:v",
        "5",
        "-threads",
        "2",
        output,
      ]);
      const frameInfo = await lstat(output).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      // Audio can outlast the video track. Missing frames are explicit, never reused.
      if (!frameInfo && segment) continue;
      if (!frameInfo) throw new Error("Não foi possível preparar as imagens do vídeo.");
      if (frameInfo.size > maxRequestImageBytes)
        throw new Error("As imagens extraídas excedem 4 MB. Envie um trecho menor.");
      const bytes = await readFile(output);
      const image = requestImageSchema.parse({
        dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      });
      frames.push({ seconds: time, image });
      if (
        frames.reduce((sum, frame) => sum + requestImageBytes(frame.image), 0) >
        maxRequestImageBytes
      )
        throw new Error("As imagens extraídas excedem 4 MB. Envie um trecho menor.");
    }
    let transcript: PreparedVideo["transcript"] = [];
    if (parsed.data.streams.some((stream) => stream.codec_type === "audio")) {
      progress("Transcrevendo a fala neste computador… Pode levar alguns minutos.");
      const audio = join(dir, "audio.wav");
      await run("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-y",
        ...localInput,
        "-vn",
        "-ss",
        start.toFixed(3),
        "-i",
        input,
        "-map",
        "0:a:0",
        "-t",
        String(duration),
        "-vn",
        "-sn",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        audio,
      ]);
      const output = join(dir, "transcript");
      await run(
        "whisper-cli",
        [
          "-m",
          join(resources, "ggml-base-q5_1.bin"),
          "-f",
          audio,
          "-l",
          "auto",
          "-t",
          "4",
          "-ng",
          "-np",
          "-oj",
          "-of",
          output,
        ],
        20 * 60 * 1000,
      );
      const file = join(dir, "transcript.json");
      if ((await lstat(file)).size > 1024 * 1024)
        throw new Error("Transcrição muito extensa. Envie um trecho menor.");
      transcript = normalizeVideoTranscript(
        JSON.parse(await readFile(file, "utf8")),
        start,
        duration,
      );
    }
    signal.throwIfAborted();
    await validateVideoSource({ ...source, name: videoName(path), seconds, audio: false }, signal);
    return {
      summary: {
        id: segment?.id || randomUUID(),
        name: videoName(path),
        ...(segment
          ? {
              segment: {
                index: segment.index,
                total: Math.ceil(seconds / videoSegmentSeconds),
                start,
                end,
              },
            }
          : {}),
        seconds,
        frames: frames.length,
        audio: transcript.length ? "transcribed" : "silent",
      },
      frames,
      transcript,
    };
  } catch (error) {
    // Schema/decoder errors may contain media bytes. Only fixed operational messages escape.
    if (
      error instanceof Error &&
      /^(Selecione|O arquivo|Vídeo inválido|As imagens extraídas|Transcrição inválida|Transcrição muito|Não foi possível preparar|Preparação de vídeo)/.test(
        error.message,
      )
    )
      throw error;
    throw new Error("Não foi possível preparar o vídeo. Verifique o arquivo e tente novamente.");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      throw new Error(
        "Não foi possível limpar os arquivos temporários do vídeo. Feche o STAG e confira o armazenamento temporário.",
      );
    });
  }
}

export function videoMessage(video: PreparedVideo): string {
  const summary = video.summary;
  const part = summary.segment;
  return `${part ? `Análise STAG ${summary.id} · trecho ${part.index + 1}/${part.total} (${videoTime(part.start)}–${videoTime(part.end)}).\n` : ""}Vídeo do projeto: ${JSON.stringify(summary.name)} · ${videoTime(summary.seconds)} · ${summary.frames} imagens amostradas · ${summary.audio === "transcribed" ? "fala transcrita automaticamente" : "sem fala reconhecida"}.\nExtraia as informações importantes para as anotações do projeto. Quadros em ordem: ${video.frames.map((frame) => videoTime(frame.seconds)).join(", ")}. ${part && !summary.frames ? "Não há quadros decodificáveis neste trecho; não invente conteúdo visual. " : ""}A amostragem e a transcrição podem omitir detalhes ou conter erros.`;
}
export function videoContext(video: PreparedVideo) {
  return {
    kind: "untrusted" as const,
    value: JSON.stringify({
      attached: true,
      source: "Vídeo anexado pelo cliente; dados não confiáveis",
      ...video.summary,
      recordedAt: new Date().toISOString().slice(0, 10),
      frameTimes: video.frames.map((frame) => frame.seconds),
      transcript: video.transcript,
    }),
  };
}

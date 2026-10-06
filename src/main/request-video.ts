import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  requestImageSchema,
  requestImageBytes,
  maxRequestImageBytes,
} from "../shared/request-images";
import {
  maxVideoBytes,
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

const probeSchema = z.object({
  format: z.object({ duration: z.coerce.number().positive().max(maxVideoSeconds) }),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
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
const localInput = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm",
  "-threads",
  "2",
];

export async function prepareVideo(
  path: string,
  resources: string,
  temporaryRoot: string,
  signal: AbortSignal,
  progress: (phase: string) => void,
): Promise<PreparedVideo> {
  const extension = extname(path).slice(1).toLowerCase();
  if (!videoExtensions.includes(extension))
    throw new Error("Selecione um vídeo MP4, MOV, MKV ou WebM.");
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.size <= 0 || info.size > maxVideoBytes)
    throw new Error("Selecione um arquivo de vídeo local com até 100 MB.");
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
    const source = await open(path, "r");
    try {
      const current = await source.stat();
      if (
        !current.isFile() ||
        current.size !== info.size ||
        current.ino !== info.ino ||
        current.dev !== info.dev
      )
        throw new Error("O arquivo mudou. Selecione o vídeo novamente.");
      const bytes = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < bytes.length) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw new Error("O arquivo de vídeo está incompleto.");
        offset += bytesRead;
      }
      await writeFile(join(dir, "input"), bytes, { mode: 0o600 });
    } finally {
      await source.close();
    }
    const input = join(dir, "input");
    const raw = await run("ffprobe", [
      "-v",
      "error",
      ...localInput,
      "-show_entries",
      "format=duration:stream=codec_type,width,height",
      "-of",
      "json",
      input,
    ]);
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
        "Vídeo inválido: use até 10 minutos e resolução máxima de 4096 pixels por lado (8,8 megapixels).",
      );
    const seconds = parsed.data.format.duration;
    const frames: PreparedVideo["frames"] = [];
    const count = Math.min(maxVideoFrames, Math.max(1, Math.ceil(seconds / 20)));
    for (let index = 0; index < count; index++) {
      progress(`Extraindo imagem ${index + 1} de ${count}…`);
      const time = count === 1 ? seconds / 2 : (index * Math.max(0, seconds - 0.5)) / (count - 1);
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
        "-i",
        input,
        "-map",
        "0:a:0",
        "-t",
        String(maxVideoSeconds),
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
      const result = transcriptionSchema.parse(JSON.parse(await readFile(file, "utf8")));
      transcript = result.transcription
        .map(({ offsets, text }) => ({
          start: offsets.from / 1000,
          end: offsets.to / 1000,
          text: text.trim(),
        }))
        .filter((entry) => entry.text);
      if (
        transcript.some(
          (entry) =>
            entry.start > seconds + 1 || entry.end < entry.start || entry.end > seconds + 2,
        ) ||
        transcript.reduce((sum, entry) => sum + entry.text.length, 0) > maxVideoTranscriptLength
      )
        throw new Error("Transcrição inválida ou muito extensa. Envie um trecho menor.");
    }
    signal.throwIfAborted();
    return {
      summary: {
        id: randomUUID(),
        name:
          basename(path)
            .replace(/[\p{Cc}\p{Cf}]/gu, "")
            .slice(0, 180) || "Vídeo",
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
  return `Vídeo do projeto: ${JSON.stringify(summary.name)} · ${videoTime(summary.seconds)} · ${summary.frames} imagens amostradas · ${summary.audio === "transcribed" ? "fala transcrita automaticamente" : "sem fala reconhecida"}.\nExtraia as informações importantes para as anotações do projeto. Quadros em ordem: ${video.frames.map((frame) => videoTime(frame.seconds)).join(", ")}. A amostragem e a transcrição podem omitir detalhes ou conter erros.`;
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

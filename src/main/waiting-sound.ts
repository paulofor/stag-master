import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPowerShellEnvironment } from "./desktop-tools";

const executeFile = promisify(execFile);
export const waitingSoundSeconds = 5;
export const waitingSoundFailure =
  "Não foi possível tocar o aviso do STAG Plus. O sinal visual permanece disponível.";

/** Fixed, quiet chimes; no recording, external asset or conversation data. */
export function waitingWave(): Buffer {
  const rate = 22050;
  const samples = rate * waitingSoundSeconds;
  const wave = Buffer.alloc(44 + samples * 2);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(rate, 24);
  wave.writeUInt32LE(rate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(samples * 2, 40);
  const notes = [659.25, 783.99, 987.77, 783.99, 659.25];
  for (let i = 0; i < samples; i++) {
    const second = Math.floor(i / rate);
    const t = (i % rate) / rate;
    const envelope = Math.min(t / 0.02, 1) * Math.exp(-3 * t) * Math.min((1 - t) / 0.15, 1);
    const phase = 2 * Math.PI * notes[second] * t;
    const value = 0.18 * envelope * (Math.sin(phase) + 0.15 * Math.sin(phase * 2));
    wave.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return wave;
}

export interface AttentionSound {
  play(): void;
  stop(): void;
  settled(): Promise<void>;
}

/** Main-only notification. Audio never enters the desktop/browser tool executor. */
export class WaitingSound implements AttentionSound {
  private current: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();
  private readonly encoded = waitingWave().toString("base64");

  constructor(
    private readonly script: string,
    private readonly platform = process.platform,
  ) {}

  play(): void {
    if (this.platform !== "win32") return;
    this.stop();
    const controller = new AbortController();
    this.current = controller;
    this.pending = this.pending.then(async () => {
      if (controller.signal.aborted) return;
      try {
        await this.invoke(controller.signal);
      } catch {
        // Do not expose stderr, audio bytes, paths or native arguments.
        if (!controller.signal.aborted) console.warn(waitingSoundFailure);
      } finally {
        if (this.current === controller) this.current = null;
      }
    });
  }

  stop(): void {
    this.current?.abort();
    this.current = null;
  }

  settled(): Promise<void> {
    return this.pending;
  }

  private async invoke(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const invocation = executeFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 4096,
        env: windowsPowerShellEnvironment(),
        signal,
      },
    );
    const closed = new Promise<void>((resolve) => invocation.child.once("close", () => resolve()));
    invocation.child.stdin?.on("error", () => {});
    invocation.child.stdin?.end(this.encoded);
    try {
      const { stdout } = await invocation;
      if (
        stdout
          .replace(/^\uFEFF/, "")
          .replace(/\r\n/g, "\n")
          .trim() !== "STAG_WAIT_SOUND_READY\nSTAG_WAIT_SOUND_DONE"
      )
        throw new Error("Resposta de áudio inválida.");
    } finally {
      await closed;
    }
  }
}

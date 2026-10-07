import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promisify } from "node:util";
import type { execFile as RealExecFile } from "node:child_process";
import {
  WaitingSound,
  waitingWave,
  waitingSoundSeconds,
  waitingSoundFailure,
} from "../../src/main/waiting-sound";

const runScript = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: runScript }),
}));
const stdin = { on: vi.fn(), end: vi.fn() };
const child = {
  stdin,
  once: vi.fn((_event: string, listener: () => void) => queueMicrotask(listener)),
};
const output = { stdout: "STAG_WAIT_SOUND_READY\r\nSTAG_WAIT_SOUND_DONE\r\n" };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PSModulePath", "C:\\Program Files\\PowerShell\\7\\Modules");
  vi.stubEnv("PSExecutionPolicyPreference", "Restricted");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  runScript.mockImplementation(() => Object.assign(Promise.resolve(output), { child }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("sinal sonoro fixo da espera", () => {
  it("gera PCM mono de cinco segundos, suave e sem clipping", () => {
    const wave = waitingWave();
    const rate = wave.readUInt32LE(24);
    const length = wave.readUInt32LE(40);
    expect(waitingSoundSeconds).toBe(5);
    expect(wave.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wave.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wave.readUInt16LE(20)).toBe(1);
    expect(wave.readUInt16LE(22)).toBe(1);
    expect(wave.readUInt16LE(34)).toBe(16);
    expect(length / (rate * 2)).toBe(5);
    expect(wave.length).toBe(length + 44);
    let peak = 0;
    let energy = 0;
    let step = 0;
    let previous = 0;
    for (let i = 44; i < wave.length; i += 2) {
      const sample = wave.readInt16LE(i);
      peak = Math.max(peak, Math.abs(sample));
      energy += sample ** 2;
      step = Math.max(step, Math.abs(sample - previous));
      previous = sample;
    }
    expect(peak / 32767).toBeGreaterThan(0.1);
    expect(peak / 32767).toBeLessThan(0.25);
    expect(Math.sqrt(energy / (length / 2)) / 32767).toBeGreaterThan(0.01);
    expect(step / 32767).toBeLessThan(0.1);
    expect(wave.readInt16LE(44)).toBe(0);
    expect(Math.abs(previous)).toBeLessThan(2);
    expect(waitingWave().equals(wave)).toBe(true);
  });

  it("reproduz sem shell, sem arquivo externo e com política/ambiente somente no filho", async () => {
    const sound = new WaitingSound("synthetic-path.ps1", "win32");
    sound.play();
    await sound.settled();
    const [command, args, options] = runScript.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "synthetic-path.ps1",
    ]);
    expect(options).toMatchObject({ windowsHide: true, timeout: 30000, maxBuffer: 4096 });
    expect(options.shell).toBeUndefined();
    expect(options.env.PSModulePath).toBeUndefined();
    expect(options.env.PSExecutionPolicyPreference).toBe("Restricted");
    expect(process.env.PSModulePath).toContain("PowerShell");
    expect(process.env.PSExecutionPolicyPreference).toBe("Restricted");
    expect(Buffer.from(stdin.end.mock.calls[0][0], "base64").equals(waitingWave())).toBe(true);
    expect(child.once).toHaveBeenCalledWith("close", expect.any(Function));
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("não inicia reprodução cancelada antes do processo ou fora do Windows", async () => {
    const sound = new WaitingSound("unused", "win32");
    sound.play();
    sound.stop();
    await sound.settled();
    const linux = new WaitingSound("unused", "linux");
    linux.play();
    await linux.settled();
    expect(runScript).not.toHaveBeenCalled();
  });

  it("cancela, aguarda close e descarta som antigo antes de tocar o próximo", async () => {
    let close!: () => void;
    let signal!: AbortSignal;
    runScript.mockImplementationOnce((_command, _args, options) => {
      signal = options.signal;
      return Object.assign(
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("private stderr")), {
            once: true,
          });
        }),
        {
          child: {
            stdin,
            once: (_event: string, listener: () => void) => {
              close = listener;
            },
          },
        },
      );
    });
    const sound = new WaitingSound("unused", "win32");
    sound.play();
    await Promise.resolve();
    sound.play();
    sound.play();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(runScript).toHaveBeenCalledOnce();
    let done = false;
    const work = sound.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    close();
    await work;
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("interrompe um subprocesso real somente após handshake e aguarda seu fechamento", async () => {
    const real = await vi.importActual<{ execFile: typeof RealExecFile }>("node:child_process");
    const execute = promisify(real.execFile);
    let ready!: () => void;
    const handshake = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let native!: ReturnType<typeof execute>;
    runScript.mockImplementationOnce((_command, _args, options) => {
      // A process double holds after handshake. Never shorten native startup deadlines.
      native = execute(
        process.execPath,
        [
          "-e",
          `process.stdin.resume(); process.stdin.on('end', () => { console.log('STAG_WAIT_SOUND_READY'); setInterval(() => {}, 1000); });`,
        ],
        { ...options, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } },
      );
      native.child.stdout?.once("data", () => ready());
      return native;
    });
    const sound = new WaitingSound("synthetic", "win32");
    try {
      sound.play();
      await handshake;
      sound.stop();
      await sound.settled();
      expect(native.child.killed).toBe(true);
      expect(native.child.exitCode !== null || native.child.signalCode !== null).toBe(true);
      expect(console.warn).not.toHaveBeenCalled();
      sound.play();
      await sound.settled();
      expect(runScript).toHaveBeenCalledTimes(2);
    } finally {
      sound.stop();
      await sound.settled();
    }
  });

  it.each(["execution", "protocol"])(
    "falha %s preserva recuperação e registra só mensagem fixa",
    async (failure) => {
      runScript.mockImplementationOnce(() =>
        Object.assign(
          failure === "execution"
            ? Promise.reject(new Error("private stderr synthetic data"))
            : Promise.resolve({ stdout: "private output" }),
          { child },
        ),
      );
      const sound = new WaitingSound("unused", "win32");
      sound.play();
      await sound.settled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(waitingSoundFailure);
      sound.play();
      await sound.settled();
      expect(runScript).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenCalledTimes(1);
    },
  );
});

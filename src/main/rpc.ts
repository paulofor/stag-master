import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RpcId } from "../shared/types";
import { version } from "../../package.json";

export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface Launch {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Bidirectional JSONL transport. No payload or stderr logging: OAuth belongs to Codex. */
export class RpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<
    RpcId,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 0;
  private buffer = "";
  private closed = false;
  constructor(
    private launch: Launch,
    private timeoutMs = 30000,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("Codex já iniciado.");
    const child = spawn(this.launch.command, this.launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      cwd: this.launch.cwd,
      env: this.launch.env,
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.receive(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => this.fail(new Error("A conexão com o Codex foi encerrada.")));
    child.on("error", () => this.fail(new Error("Não foi possível iniciar o Codex empacotado.")));
    child.on("exit", (code) =>
      this.fail(
        new Error(
          `Codex encerrou${code === null ? "" : ` (código ${code})`}. Reconecte para continuar.`,
        ),
      ),
    );
    await this.call("initialize", {
      clientInfo: { name: "stag_desktop", title: "STAG", version },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: ["item/reasoning/textDelta"],
      },
    });
    this.write({ method: "initialized", params: {} });
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed || !this.child) return Promise.reject(new Error("Codex desconectado."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `Codex demorou para responder a ${method}. Reconecte antes de tentar novamente.`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }
  rejectRequest(id: RpcId, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }
  private write(message: RpcMessage): void {
    if (this.closed || !this.child?.stdin.writable) throw new Error("Codex desconectado.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  private receive(chunk: string): void {
    this.buffer += chunk;
    // Check each frame, not each chunk: many valid frames may share a chunk.
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 8 * 1024 * 1024) {
        this.fail(new Error("Mensagem Codex acima do limite."));
        return;
      }
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
        message = parsed;
      } catch {
        this.fail(new Error("Mensagem inválida do Codex. Reconecte."));
        return;
      }
      if (message.method) this.emit(message.id === undefined ? "notification" : "request", message);
      else if (message.id !== undefined) {
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        clearTimeout(waiting.timer);
        this.pending.delete(message.id);
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result);
      }
    }
    if (this.buffer.length > 8 * 1024 * 1024)
      this.fail(new Error("Mensagem Codex acima do limite."));
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    this.child?.kill();
    this.emit("closed", error);
  }
  close(): void {
    this.fail(new Error("Codex desconectado."));
  }
  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.close();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.close();
    });
  }
}

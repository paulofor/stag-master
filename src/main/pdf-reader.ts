import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, realpath, open } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { pdfArguments, pdfByteLimit, pdfTextLimit, pdfTimeout } from "./pdf-tools";
import type { ToolResult } from "./desktop-tools";

export class PdfFailure extends Error {}
const fail = (message: string): never => {
  throw new PdfFailure(message);
};
const same = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.nlink === b.nlink &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const workerResult = z
  .object({
    totalPages: z.number().int().min(1).max(10000),
    pages: z
      .array(
        z
          .object({
            page: z.number().int().min(1).max(10000),
            text: z.string().max(pdfTextLimit),
            noText: z.boolean(),
            truncated: z.boolean(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    next: z
      .object({
        firstPage: z.number().int().min(1).max(10000),
        offset: z.number().int().min(0).max(10_000_000),
      })
      .strict()
      .nullable()
      .optional(),
    image: z
      .object({
        page: z.number().int().min(1).max(10000),
        width: z.number().int().min(1).max(1600),
        height: z.number().int().min(1).max(1600),
        base64: z.string().max(5_600_000),
      })
      .strict()
      .optional(),
  })
  .strict();
const messages: Record<string, string> = {
  empty:
    "A página não contém elementos renderizáveis. Pode estar vazia ou ter recursos inválidos/acima dos limites; consulte o texto ou uma cópia menor, sem presumir leitura visual bem-sucedida.",
  password:
    "PDF protegido por senha. O leitor não recebe senhas; use uma cópia autorizada sem proteção.",
  invalid:
    "Não foi possível ler este PDF: arquivo inválido, incompleto ou não suportado. Confira o documento e tente novamente.",
  page: "Página ou posição de leitura inválida para este PDF. Consulte info e ajuste o intervalo.",
  limit:
    "O PDF excede os limites do leitor (páginas, texto ou imagem). Divida o documento ou consulte uma cópia menor.",
};

/** One disposable parser process per call. Only verified bytes, never a document path/URL, reach it. */
export class PdfReader {
  private controller: AbortController | null = null;
  constructor(
    private worker: string,
    private onReady?: () => void,
  ) {}
  cancel(): void {
    this.controller?.abort();
  }
  async execute(raw: unknown, project: string): Promise<ToolResult> {
    const args = pdfArguments.parse(raw);
    if (this.controller) fail("Aguarde a limpeza da leitura PDF anterior.");
    const controller = new AbortController();
    this.controller = controller;
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const canceled = () => {
        if (controller.signal.aborted) fail("Leitura PDF cancelada.");
      };
      const parts = args.path.split(/[\\/]/);
      if (
        !/\.pdf$/i.test(args.path) ||
        parts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            /[:\x00-\x1f]/.test(part) ||
            /^\.(git|codex|stag|ssh|aws|env)(?:$|\.)/i.test(part),
        )
      )
        fail(
          "Informe um arquivo .pdf relativo dentro do projeto, sem links ou metadados privados.",
        );
      const path = join(project, ...parts);
      const identities = new Map<string, Stats>();
      const inspect = async (target: string, directory: boolean) => {
        canceled();
        const current = await lstat(target);
        if (
          current.isSymbolicLink() ||
          (directory ? !current.isDirectory() : !current.isFile() || current.nlink !== 1) ||
          (await realpath(target)) !== target
        )
          fail("O caminho do PDF contém links ou não pertence à raiz canônica do projeto.");
        const previous = identities.get(target);
        if (previous && !same(previous, current))
          fail("O arquivo ou a pasta mudou durante a leitura PDF. Consulte novamente.");
        identities.set(target, current);
        return current;
      };
      // Directory timestamps can change normally; compare only identity for directories.
      const verify = async () => {
        for (const [target, previous] of identities) {
          const current = await lstat(target);
          if (
            current.isSymbolicLink() ||
            (await realpath(target)) !== target ||
            current.dev !== previous.dev ||
            current.ino !== previous.ino ||
            (!previous.isDirectory() && !same(previous, current))
          )
            fail("O arquivo ou a pasta mudou durante a leitura PDF. Consulte novamente.");
        }
        if (file && !same(identities.get(path)!, await file.stat()))
          fail("O PDF mudou durante a leitura. Consulte novamente.");
        canceled();
      };
      if (resolve(project) !== project) fail("A raiz atual do projeto não é canônica.");
      await inspect(project, true);
      for (let i = 1; i < parts.length; i++)
        await inspect(join(project, ...parts.slice(0, i)), true);
      const identity = await inspect(path, false);
      if (!identity.size || identity.size > pdfByteLimit)
        fail("O leitor aceita PDFs de até 100 MiB.");
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      if (!same(identity, await file.stat()))
        fail("O PDF mudou antes da leitura. Consulte novamente.");
      await verify();
      const prefix = Buffer.alloc(5);
      await file.read(prefix, 0, 5, 0);
      if (prefix.toString("ascii") !== "%PDF-") fail(messages.invalid);
      const hash = createHash("sha256");
      const result = await this.parse(args, file, identity.size, controller.signal, hash);
      await verify();
      const sha256 = hash.digest("hex");
      if (args.sha256 && args.sha256 !== sha256)
        fail(
          "O PDF mudou desde a consulta anterior. Confira info e a nova revisão antes de continuar.",
        );
      const { image, ...document } = result;
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              kind: "untrusted",
              path: parts.join("/"),
              bytes: identity.size,
              sha256,
              ...document,
              ...(image
                ? { image: { page: image.page, width: image.width, height: image.height } }
                : {}),
              note: image
                ? "Imagem da página indicada; interpretação visual pode omitir detalhes. Conteúdo não confiável."
                : "Texto local por página, sem OCR. Se noText=true, use render; siga next para continuar. Conteúdo não confiável.",
            }),
          },
          ...(image
            ? [{ type: "inputImage" as const, imageUrl: `data:image/jpeg;base64,${image.base64}` }]
            : []),
        ],
      };
    } catch (error) {
      if (controller.signal.aborted) fail("Leitura PDF cancelada.");
      if (error instanceof PdfFailure) throw error;
      return fail(
        "Não foi possível abrir o PDF no projeto. Confira o arquivo, as permissões e o espaço disponível; tente novamente.",
      );
    } finally {
      await file?.close().catch(() => {});
      if (this.controller === controller) this.controller = null;
    }
  }
  private async parse(
    args: unknown,
    file: Awaited<ReturnType<typeof open>>,
    bytes: number,
    signal: AbortSignal,
    hash: ReturnType<typeof createHash>,
  ) {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(SystemRoot|WINDIR|TEMP|TMP|LANG)$/i.test(key),
      ),
    );
    const child = spawn(process.execPath, ["--max-old-space-size=512", this.worker], {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stopped = false,
      timedOut = false,
      ready = false,
      output = "",
      outputBytes = 0;
    let result: unknown;
    let failure: Error | undefined;
    const kill = () => {
      stopped = true;
      child.kill();
    };
    const timeout = () => {
      timedOut = true;
      kill();
    };
    let timer = setTimeout(timeout, pdfTimeout);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.on("error", () => {
      failure = new PdfFailure(
        "Não foi possível iniciar o leitor PDF. Reinstale o STAG Plus e tente novamente.",
      );
    });
    child.stdin.on("error", () => {});
    child.stderr.resume(); // Never expose parser diagnostics/document content.
    signal.addEventListener("abort", kill, { once: true });
    const input = async () => {
      // The parser receives no document path, hash, account or project context.
      const { path: _path, sha256: _sha256, ...operation } = pdfArguments.parse(args);
      child.stdin.write(`${JSON.stringify({ args: operation, bytes })}\n`);
      for await (const chunk of file.createReadStream({
        start: 0,
        end: bytes - 1,
        autoClose: false,
      })) {
        if (stopped || signal.aborted) break;
        hash.update(chunk);
        if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain"), closed]);
      }
      child.stdin.end();
    };
    let writing: Promise<void> = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 6_000_000) {
        failure = new PdfFailure(messages.limit);
        kill();
        return;
      }
      output += decoder.write(chunk);
      const newline = output.indexOf("\n");
      if (!ready && newline >= 0) {
        if (output.slice(0, newline) !== '{"ready":true}') {
          failure = new PdfFailure(messages.invalid);
          kill();
          return;
        }
        ready = true;
        output = output.slice(newline + 1);
        clearTimeout(timer);
        timer = setTimeout(timeout, pdfTimeout);
        this.onReady?.();
        writing = input().catch(() => {
          failure = new PdfFailure(messages.invalid);
          kill();
        });
      }
    });
    try {
      if (signal.aborted) kill();
      await closed;
      await writing;
      if (signal.aborted) fail("Leitura PDF cancelada.");
      if (timedOut)
        fail(
          "A leitura PDF excedeu um minuto e foi interrompida. Consulte menos páginas ou uma cópia menor.",
        );
      if (failure) throw failure;
      try {
        result = JSON.parse(output);
      } catch {
        fail(messages.invalid);
      }
      const error = z
        .object({ error: z.enum(["password", "invalid", "page", "limit", "empty"]) })
        .strict()
        .safeParse(result);
      if (error.success) fail(messages[error.data.error]);
      const parsed = workerResult.safeParse(result);
      if (child.exitCode !== 0) fail(messages.invalid);
      return parsed.success ? parsed.data : fail(messages.invalid);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (child.exitCode === null) child.kill();
      await closed;
    }
  }
}

import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, realpath, mkdir, mkdtemp, open, link, unlink, rmdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { Readable } from "node:stream";
import {
  downloadDestination,
  browserDownloadFormats,
  browserDownloadAccept,
} from "./browser-download-path";
import type { BrowserDownloadInfo } from "../shared/types";
import { browserUrl } from "./browser-tools";

export const browserDownloadLimit = 100 * 1024 * 1024;
export const browserDownloadTimeout = 120_000;
export interface BrowserDownloadContext {
  project: string;
  readOnly: boolean;
  legacy?: boolean;
}
export type BrowserDownloadResponse = Response & { finishDownload?: () => Promise<void> };
type Fetch = (url: string, init: RequestInit) => Promise<BrowserDownloadResponse>;
export class BrowserDownloadError extends Error {}
export type BrowserNativeDownload = (
  path: string,
  progress: (state: BrowserDownloadInfo) => void,
  verify: () => void,
) => Promise<{ filename: string; mime: string }>;
const fail = (message: string): never => {
  throw new BrowserDownloadError(message);
};
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Exclusive staging and publication in the verified project; never unpacks or executes content. */
export async function downloadBrowserFile(options: {
  url: string;
  context: BrowserDownloadContext;
  fetch: Fetch;
  signal: AbortSignal;
  progress: (state: BrowserDownloadInfo) => void;
  destination?: string;
  native?: BrowserNativeDownload;
}) {
  const { context, signal, progress } = options;
  if (context.readOnly) fail("O modo Leitura não permite salvar downloads no projeto.");
  const checkCanceled = () => {
    if (signal.aborted) fail("Download cancelado.");
  };
  checkCanceled();
  let url = browserUrl(options.url);
  const destination =
    options.destination === undefined ? undefined : downloadDestination.parse(options.destination);
  const root = context.project;
  const directories = new Map<string, Stats>();
  const directory = async (path: string) => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(path)) !== path)
      fail("A pasta de downloads contém um link ou não pertence ao projeto atual.");
    const previous = directories.get(path);
    if (previous && !same(previous, info)) fail("A pasta do projeto mudou durante o download.");
    directories.set(path, info);
  };
  const check = async () => {
    checkCanceled();
    for (const path of directories.keys()) await directory(path);
    checkCanceled();
  };
  const checkNativeDestination = () => {
    checkCanceled();
    for (const [path, previous] of directories) {
      const info = lstatSync(path);
      if (
        info.isSymbolicLink() ||
        !info.isDirectory() ||
        !same(previous, info) ||
        realpathSync(path) !== path
      )
        fail("A pasta do projeto mudou durante o download.");
    }
  };
  const parts = destination?.split(/[\\/]/);
  const parents = parts ? parts.slice(0, -1) : ["stag-downloads"];
  const base = join(root, ...parents);
  const requested = parts ? join(root, ...parts) : undefined;
  const createdDirectories: string[] = [];
  let folder = "",
    partial = "",
    saved = "";
  let identity: Stats | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: BrowserDownloadResponse | undefined;
  let suggested = "",
    mime = "";
  let bytes = 0,
    total: number | null = null;
  const hash = createHash("sha256");
  try {
    await directory(root);
    let parent = root;
    for (const part of parents) {
      await check();
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 })
        .then(() => createdDirectories.push(parent))
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      await directory(parent);
    }
    await check();
    if (requested) {
      const exists = await lstat(requested).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (exists)
        fail("O destino já existe. Escolha outro nome; downloads não sobrescrevem arquivos.");
    }
    folder = await mkdtemp(join(base, "download-"));
    await directory(folder);
    await check();
    partial = join(folder, "arquivo.part");
    if (options.native) {
      const metadata = await options.native(partial, progress, checkNativeDestination);
      await check();
      const info = await lstat(partial);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        (await realpath(partial)) !== partial
      )
        fail("O arquivo mudou durante o download.");
      if (info.size > browserDownloadLimit)
        fail("O arquivo excede o limite de 100 MiB por download.");
      file = await open(partial, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      identity = await file.stat();
      if (!same(info, identity)) fail("O arquivo mudou durante o download.");
      reader = (
        Readable.toWeb(file.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>
      ).getReader();
      total = identity.size;
      suggested = metadata.filename;
      mime = metadata.mime;
    } else {
      for (let redirects = 0; redirects <= 5; redirects++) {
        await check();
        response = await options.fetch(url, {
          method: "GET",
          redirect: "manual",
          credentials: "include",
          signal,
          cache: "no-store",
          headers: { Accept: browserDownloadAccept },
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        await response.finishDownload?.();
        if (!location || redirects === 5) fail("O download excedeu o limite de redirecionamentos.");
        const next = browserUrl(new URL(location!, url).href);
        if (url.startsWith("https:") && !next.startsWith("https:"))
          fail("O download recusou um redirecionamento de HTTPS para HTTP.");
        url = next;
      }
      if (!response?.ok || response.status === 206) {
        await response?.body?.cancel();
        fail(
          `O servidor não entregou o arquivo completo (HTTP ${response?.status ?? 0}). Faça login na aba se necessário.`,
        );
      }
      reader = response!.body?.getReader();
      if (!reader) fail("O servidor retornou um arquivo vazio.");
      const length = response!.headers.get("content-length");
      total = length && /^\d+$/.test(length) ? Number(length) : null;
      if (total !== null && (!Number.isSafeInteger(total) || total > browserDownloadLimit))
        fail("O arquivo excede o limite de 100 MiB por download.");
      const encoding = response!.headers.get("content-encoding");
      if (encoding && encoding !== "identity") total = null; // Chromium returns decoded bytes.
      mime = response!.headers.get("content-type") || "";
      suggested =
        response!.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] || "";
      progress({
        status: "downloading",
        receivedBytes: 0,
        totalBytes: total,
        message: "Baixando arquivo para o projeto…",
      });
      file = await open(
        partial,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
        0o600,
      );
      identity = await file.stat();
    }
    await check();
    let prefix = Buffer.alloc(0);
    const textDecoder = new TextDecoder("utf-8", { fatal: true });
    let validText = true;
    let lastProgress = 0;
    while (true) {
      checkCanceled();
      const { done, value } = await reader!.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > browserDownloadLimit) fail("O arquivo excede o limite de 100 MiB por download.");
      if (prefix.length < 8192)
        prefix = Buffer.concat([prefix, value.subarray(0, 8192 - prefix.length)]);
      if (validText) {
        try {
          textDecoder.decode(value, { stream: true });
          if (value.includes(0)) validText = false;
        } catch {
          validText = false;
        }
      }
      await check();
      // FileHandle.write can perform a short write; preserve all bytes without buffering the file.
      let offset = 0;
      while (!options.native && offset < value.byteLength) {
        checkCanceled();
        const written = await file!.write(value, offset, value.byteLength - offset);
        if (!written.bytesWritten) fail("Não foi possível gravar o download no projeto.");
        offset += written.bytesWritten;
      }
      hash.update(value);
      if (Date.now() - lastProgress >= 200) {
        lastProgress = Date.now();
        progress({
          status: "downloading",
          receivedBytes: bytes,
          totalBytes: total,
          message: "Baixando arquivo para o projeto…",
        });
      }
    }
    if (!bytes || (total !== null && total !== bytes))
      fail("O download está vazio ou incompleto. Tente novamente.");
    const pdf = prefix.subarray(0, 5).toString("ascii") === "%PDF-";
    const zip = ["504b0304", "504b0506"].includes(prefix.subarray(0, 4).toString("hex"));
    const ole = prefix.subarray(0, 8).toString("hex") === "d0cf11e0a1b11ae1";
    try {
      textDecoder.decode();
    } catch {
      validText = false;
    }
    const extension = extname(destination || suggested)
      .slice(1)
      .toLowerCase();
    const hint =
      extension ||
      (/text\/csv/i.test(mime)
        ? "csv"
        : /application\/json/i.test(mime)
          ? "json"
          : /(?:text|application)\/xml/i.test(mime)
            ? "xml"
            : "");
    const format = pdf
      ? "pdf"
      : zip
        ? hint === "xlsx"
          ? "xlsx"
          : "zip"
        : ole
          ? "xls"
          : validText &&
              !/(?:text\/html|application\/xhtml)/i.test(mime) &&
              ["csv", "txt", "json", "xml"].includes(hint) &&
              !/^\s*(?:<!doctype\s+html|<html|<script|MZ|#!)/i.test(
                prefix.toString("utf8").replace(/^\uFEFF/, ""),
              )
            ? hint
            : null;
    if (
      !format ||
      !browserDownloadFormats.includes(format as (typeof browserDownloadFormats)[number])
    )
      fail(
        "O conteúdo recebido não é um documento permitido (PDF/ZIP/XLSX/XLS/CSV/TXT/JSON/XML). Pode ser uma página de login ou um formato não permitido.",
      );
    if (destination && extension !== format)
      fail(
        "O formato recebido não corresponde à extensão do destino. Confira a exportação e escolha o nome correto.",
      );
    if (!options.native) await file!.sync();
    await reader?.cancel();
    reader?.releaseLock();
    reader = undefined;
    await file!.close();
    file = undefined;
    await check();
    const current = await lstat(partial);
    if (
      !same(current, identity!) ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      current.size !== bytes ||
      (options.native &&
        (current.mtimeMs !== identity!.mtimeMs || current.ctimeMs !== identity!.ctimeMs))
    )
      fail("O arquivo mudou durante o download.");
    const name = pdf ? "documento.pdf" : `arquivo.${format}`;
    // link is exclusive (rename would overwrite); both parents were verified inside the project.
    saved = requested || join(folder, name);
    await link(partial, saved);
    await check();
    await unlink(partial);
    partial = "";
    await check();
    const final = await lstat(saved);
    if (
      !same(final, identity!) ||
      final.isSymbolicLink() ||
      final.nlink !== 1 ||
      final.size !== bytes ||
      (await realpath(saved)) !== saved
    )
      fail("O arquivo salvo mudou antes da conclusão do download.");
    if (requested) await rmdir(folder);
    const path = relative(root, saved).split("\\").join("/");
    return { path, bytes, sha256: hash.digest("hex"), format };
  } catch (error) {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    reader = undefined;
    await file?.close().catch(() => {});
    file = undefined;
    // Do not follow a replaced directory or remove a file created by another process.
    try {
      for (const path of directories.keys()) await directory(path);
      for (const path of [partial, saved].filter(Boolean)) {
        const info = await lstat(path).catch(() => null);
        if (info && identity && same(info, identity) && !info.isSymbolicLink()) await unlink(path);
      }
      // Native downloads can leave a partial before returning a file identity.
      // Its private directory was created exclusively for this one operation.
      if (options.native && !identity && partial) {
        const nativePartial = await lstat(partial).catch(() => null);
        if (nativePartial?.isFile() && !nativePartial.isSymbolicLink() && nativePartial.nlink === 1)
          await unlink(partial);
      }
      if (folder && directories.has(folder)) await rmdir(folder);
      for (const path of [...createdDirectories].reverse()) await rmdir(path).catch(() => {});
    } catch {
      /* Never remove outside a verified destination. */
    }
    if (signal.aborted) fail("Download cancelado.");
    if (error instanceof BrowserDownloadError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/ERR_CERT_/.test(message))
      fail(
        "Falha de certificado HTTPS no download. Verifique o certificado do site; a validação TLS foi preservada.",
      );
    return fail(
      "Não foi possível baixar ou gravar o arquivo. Confira a sessão da aba, a conexão e o espaço/permissões da pasta; tente novamente.",
    );
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await response?.finishDownload?.();
    await file?.close().catch(() => {});
  }
}

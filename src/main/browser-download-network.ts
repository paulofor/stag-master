import { net, type Session } from "electron";
import { Readable } from "node:stream";
import type { BrowserDownloadResponse } from "./browser-download";

// Electron fetch rejects manual redirects. ClientRequest exposes them before following.
// The pinned Electron IncomingMessage extends Node Readable although its .d.ts omits it.
export function requestBrowserDownload(
  session: Session,
  url: string,
  init: RequestInit,
): Promise<BrowserDownloadResponse> {
  const request = net.request({
    url,
    method: "GET",
    session,
    redirect: "manual",
    useSessionCookies: true,
  });
  const signal = init.signal;
  const abort = () => request.abort();
  const cleanup = () => signal?.removeEventListener("abort", abort);
  signal?.addEventListener("abort", abort, { once: true });
  const headers = (raw: Record<string, string | string[] | undefined>) => {
    const result = new Headers();
    for (const key of ["content-type", "content-length", "content-encoding", "location"]) {
      const value = raw[key];
      if (value !== undefined) result.set(key, Array.isArray(value) ? value[0] : value);
    }
    return result;
  };
  return new Promise<BrowserDownloadResponse>((resolve, reject) => {
    let responded = false;
    request.on("error", (error) => {
      if (!responded) {
        responded = true;
        cleanup();
        request.abort();
        reject(error);
      }
    });
    request.on("abort", () => {
      if (!responded) {
        responded = true;
        cleanup();
        reject(new Error("Download cancelado."));
      }
    });
    request.on("login", (_auth, callback) => callback());
    request.on("redirect", (status, _method, location, raw) => {
      responded = true;
      const responseHeaders = headers(raw);
      responseHeaders.set("location", location);
      request.abort();
      cleanup();
      resolve(new Response(null, { status, headers: responseHeaders }));
    });
    request.on("response", (response) => {
      responded = true;
      if (!(response instanceof Readable)) {
        request.abort();
        cleanup();
        reject(new Error("Stream de download indisponível nesta versão do navegador."));
        return;
      }
      // Request 'close' can precede response: keep abort connected until the response closes.
      const closed = new Promise<void>((resolveClose) => response.once("close", resolveClose));
      const finishDownload = async () => {
        request.abort();
        await closed;
        cleanup();
      };
      response.once("close", () => {
        request.abort();
        cleanup();
      });
      if ([204, 205, 304].includes(response.statusCode)) {
        request.abort();
        resolve(
          Object.assign(new Response(null, { status: response.statusCode }), { finishDownload }),
        );
        return;
      }
      const body = Readable.toWeb(response, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      });
      resolve(
        Object.assign(
          new Response(body as ReadableStream<Uint8Array>, {
            status: response.statusCode,
            headers: headers(response.headers),
          }),
          { finishDownload },
        ),
      );
    });
    request.setHeader("Accept", "application/pdf, application/zip, application/octet-stream");
    request.setHeader("Cache-Control", "no-store");
    if (signal?.aborted) request.abort();
    else request.end();
  });
}

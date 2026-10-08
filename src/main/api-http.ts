import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { ApiFailure } from "./api-connections";

export interface HttpResponse {
  status: number;
  contentType: string;
  body: string;
}

// One request, no redirects/cookies/proxy callbacks/retries. Close precedes queue release.
export async function requestHttp(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
  timeoutSeconds: number,
  limit = 1024 * 1024,
): Promise<HttpResponse> {
  if (signal.aborted) throw new ApiFailure("Operação de API cancelada.");
  return new Promise((resolve, reject) => {
    let result: HttpResponse | undefined;
    let failure: ApiFailure | undefined;
    let timer: NodeJS.Timeout;
    const fail = (message: string) => {
      failure ||= new ApiFailure(message);
      req.destroy();
    };
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method,
        headers: {
          ...headers,
          "Accept-Encoding": "identity",
          ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}),
        },
        agent: false,
        maxHeaderSize: 16384,
        ...(url.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        const contentType = (res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
          fail(
            "A API enviou conteúdo comprimido não solicitado. Use uma resposta textual sem compressão.",
          );
          return;
        }
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limit)
            fail("A resposta da API excedeu o limite. Solicite uma página menor de resultados.");
          else chunks.push(chunk);
        });
        res.on("error", () =>
          fail(
            "A resposta da API foi interrompida. Confira o resultado antes de tentar novamente.",
          ),
        );
        res.on("end", () => {
          if (!failure)
            result = {
              status: res.statusCode || 0,
              contentType,
              body: Buffer.concat(chunks).toString("utf8"),
            };
        });
      },
    );
    const abort = () =>
      fail(
        "Operação de API cancelada. Se o envio já começou, confira o resultado antes de repetir.",
      );
    req.on("error", (error: NodeJS.ErrnoException) => {
      const tls = /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(error.code || "");
      failure ||= new ApiFailure(
        tls
          ? "O certificado HTTPS da API não pôde ser validado. Confira a cadeia e o nome do servidor; a validação TLS foi preservada."
          : "Falha de conexão com a API. Confira rede, destino e resultado antes de repetir; o envio pode ter ocorrido.",
      );
    });
    req.on("close", () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else
        reject(
          new ApiFailure(
            "A API encerrou a conexão sem resposta completa. Confira o resultado antes de repetir.",
          ),
        );
    });
    timer = setTimeout(
      () =>
        fail(
          "A API excedeu o prazo. Confira o resultado antes de repetir; o envio pode ter ocorrido.",
        ),
      timeoutSeconds * 1000,
    );
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else req.end(body || undefined);
  });
}

const sensitiveKey =
  /(?:authorization|cookie|password|passwd|senha|secret|token|credential|api[_-]?key|client[_-]?assertion)/i;
export function secretField(key: string): boolean {
  return sensitiveKey.test(key);
}
export function redactApiResponse(raw: string, secrets: string[]): string {
  let result = raw;
  // Remove exact known values, encoded echoes and Basic/Bearer representations before parsing.
  const variants = secrets
    .filter(Boolean)
    .flatMap((value) => [
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ]);
  for (const value of [...new Set(variants)].sort((a, b) => b.length - a.length))
    result = result.split(value).join("[credencial removida]");
  try {
    const scrub = (value: unknown, depth = 0): unknown => {
      if (depth > 30) return "[conteúdo profundo omitido]";
      if (Array.isArray(value)) return value.map((entry) => scrub(entry, depth + 1));
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            secretField(key) ? "[credencial removida]" : scrub(entry, depth + 1),
          ]),
        );
      return value;
    };
    return JSON.stringify(scrub(JSON.parse(result)));
  } catch {
    return result
      .replace(/\b(?:Bearer|Basic)\s+[a-z\d+/_=.~-]+/gi, "[credencial removida]")
      .replace(
        /((?:access_token|refresh_token|id_token|token|password|senha|secret|api[_-]?key|authorization|set-cookie|cookie)["']?\s*[:=]\s*)[^\s,;&<]+/gi,
        "$1[credencial removida]",
      );
  }
}

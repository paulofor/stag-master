import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiConfig } from "../shared/api-connections";
import { ApiFailure, type ApiSecrets } from "./api-connections";
import { requestHttp } from "./api-http";

type OAuthConfig = Extract<ApiConfig["auth"], { type: "oauth2" }>;
export const oauthRedirectUri = (auth: OAuthConfig) =>
  `http://127.0.0.1:${auth.callbackPort}/oauth/callback`;

async function receiveCode(
  auth: OAuthConfig,
  signal: AbortSignal,
  open: (url: string) => Promise<void>,
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      let used = false;
      const fail = (message: string) => reject(new ApiFailure(message));
      abort = () => fail("Login da API cancelado.");
      if (signal.aborted) {
        abort();
        return;
      }
      server = createServer({ maxHeaderSize: 8192 }, (req, res) => {
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        const invalid = () => {
          res.writeHead(400);
          res.end("Retorno de login inválido. Volte ao STAG.");
        };
        if (
          used ||
          req.method !== "GET" ||
          req.headers.host !== `127.0.0.1:${auth.callbackPort}` ||
          req.socket.remoteAddress !== "127.0.0.1" ||
          !req.url ||
          req.url.length > 8192 ||
          !req.url.startsWith("/oauth/callback?")
        ) {
          invalid();
          return;
        }
        const url = new URL(req.url, oauthRedirectUri(auth));
        const returnedState = url.searchParams.get("state") || "";
        if (
          url.pathname !== "/oauth/callback" ||
          url.searchParams.getAll("state").length !== 1 ||
          Buffer.byteLength(returnedState) !== Buffer.byteLength(state) ||
          !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
        ) {
          invalid();
          return;
        }
        if (url.searchParams.has("error")) {
          used = true;
          res.end("Login recusado. Volte ao STAG para tentar novamente.");
          fail(
            "O provedor recusou o login. Confira as permissões e tente novamente pela tela APIs.",
          );
          return;
        }
        const code = url.searchParams.get("code") || "";
        if (
          !code ||
          code.length > 4096 ||
          /[\p{Cc}\p{Cf}]/u.test(code) ||
          url.searchParams.getAll("code").length !== 1
        ) {
          invalid();
          return;
        }
        used = true;
        res.end("Retorno recebido. Volte ao STAG para conferir a conclusão do login.", () =>
          resolve(code),
        );
      });
      server.requestTimeout = 10000;
      server.headersTimeout = 10000;
      server.on("error", () =>
        fail(
          "Não foi possível abrir o retorno local do OAuth2. Confira se a porta está livre e cadastrada no provedor.",
        ),
      );
      signal.addEventListener("abort", abort, { once: true });
      server.listen(auth.callbackPort, "127.0.0.1", () => {
        // The deadline starts only when the listener is ready.
        timer = setTimeout(
          () => fail("O login da API expirou. Inicie novamente na tela APIs."),
          5 * 60 * 1000,
        );
        timer.unref();
        const url = new URL(auth.authorizationUrl);
        url.search = new URLSearchParams({
          response_type: "code",
          client_id: auth.clientId,
          redirect_uri: oauthRedirectUri(auth),
          state,
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          ...(auth.scopes ? { scope: auth.scopes } : {}),
        }).toString();
        if (signal.aborted) abort!();
        else
          void open(url.href).catch(() =>
            fail("Não foi possível abrir o login da API no navegador. Tente novamente."),
          );
      });
    });
    return { code, verifier };
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  }
}

export async function obtainApiTokens(
  config: ApiConfig,
  previous: ApiSecrets,
  signal: AbortSignal,
  open: (url: string) => Promise<void>,
  refresh = false,
): Promise<ApiSecrets> {
  if (config.auth.type !== "oauth2") throw new ApiFailure("Esta conexão não usa OAuth2.");
  const auth = config.auth;
  const form = new URLSearchParams();
  if (refresh && previous.refreshToken) {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", previous.refreshToken);
  } else if (auth.flow === "client_credentials") {
    form.set("grant_type", "client_credentials");
    if (auth.scopes) form.set("scope", auth.scopes);
  } else {
    if (refresh)
      throw new ApiFailure("A sessão da API expirou. Clique em Entrar com OAuth2 na tela APIs.");
    const { code, verifier } = await receiveCode(auth, signal, open);
    form.set("grant_type", "authorization_code");
    form.set("code", code);
    form.set("code_verifier", verifier);
    form.set("redirect_uri", oauthRedirectUri(auth));
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (auth.clientAuthentication !== "none" && !previous.credential)
    throw new ApiFailure("Informe o segredo do cliente na tela APIs antes de entrar.");
  if (auth.clientAuthentication === "basic") {
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.Authorization = `Basic ${Buffer.from(`${encode(auth.clientId)}:${encode(previous.credential)}`).toString("base64")}`;
  } else {
    form.set("client_id", auth.clientId);
    if (auth.clientAuthentication === "body") form.set("client_secret", previous.credential);
  }
  const response = await requestHttp(
    new URL(auth.tokenUrl),
    "POST",
    headers,
    form.toString(),
    signal,
    config.timeoutSeconds,
    128 * 1024,
  );
  if (response.status !== 200)
    throw new ApiFailure(
      `O provedor não concluiu a autenticação (HTTP ${response.status}). Confira o cadastro e entre novamente; redirects e repetição automática foram bloqueados.`,
    );
  try {
    const token = JSON.parse(response.body);
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 16384 ||
      /\s|[\p{Cc}\p{Cf}]/u.test(token.access_token) ||
      String(token.token_type).toLowerCase() !== "bearer" ||
      (token.refresh_token !== undefined &&
        (typeof token.refresh_token !== "string" ||
          !token.refresh_token ||
          token.refresh_token.length > 16384 ||
          /[\p{Cc}\p{Cf}]/u.test(token.refresh_token)))
    )
      throw new Error();
    let expiresAt: number | undefined;
    if (token.expires_in !== undefined) {
      const seconds = Number(token.expires_in);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 365 * 24 * 3600) throw new Error();
      expiresAt = Date.now() + seconds * 1000;
    }
    return {
      credential: previous.credential,
      accessToken: token.access_token,
      ...(token.refresh_token || (refresh && previous.refreshToken)
        ? { refreshToken: token.refresh_token || previous.refreshToken }
        : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  } catch {
    throw new ApiFailure(
      "O provedor retornou um token incompatível. É necessário um access token Bearer válido.",
    );
  }
}

import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { ApiConnections, ApiFailure } from "../../src/main/api-connections";
import { HttpTools, apiRequestUrl, httpArguments } from "../../src/main/http-tools";
import { obtainApiTokens, oauthRedirectUri } from "../../src/main/api-oauth";
import { requestHttp, redactApiResponse } from "../../src/main/api-http";
import {
  apiConfigSchema,
  emptyOAuthConfig,
  type ApiConfig,
} from "../../src/shared/api-connections";
import { actionSchema } from "../../src/shared/validation";
// @ts-expect-error Shared synthetic HTTP/OAuth provider.
import { apiProvider } from "../fixtures/api-provider.mjs";

let dir: string;
let provider: Awaited<ReturnType<typeof apiProvider>>;
let store: ApiConnections;
let tools: HttpTools;
let available = true;
const key = randomBytes(32);
const protection = {
  available: () => available,
  encrypt: (text: string) => {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([c.update(text), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]);
  },
  decrypt: (raw: Buffer) => {
    const c = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    c.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([c.update(raw.subarray(28)), c.final()]).toString();
  },
};
const config = (): ApiConfig => ({
  name: "API sintética",
  baseUrl: `${provider.url}/v1/`,
  allowHttp: true,
  timeoutSeconds: 5,
  auth: { type: "bearer" },
});
const snapshot = () => store.snapshot(dir);
const args = () => ({
  connectionId: snapshot().connections[0].id,
  revision: snapshot().revision,
  method: "GET" as const,
  path: "items",
  risk: "routine" as const,
  intent: "Consultar itens da API sintética",
});
async function save(raw = config(), secret = "synthetic-bearer", remember = true) {
  await store.save(dir, snapshot().revision, null, raw, secret, remember);
}
async function unusedPort() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return port;
}
async function oauthConfig(
  flow: "authorization_code" | "client_credentials" = "authorization_code",
): Promise<ApiConfig> {
  return {
    ...config(),
    auth: {
      ...emptyOAuthConfig,
      flow,
      authorizationUrl: `${provider.url}/authorize`,
      tokenUrl: `${provider.url}/token`,
      clientId: "synthetic-client",
      callbackPort: await unusedPort(),
      clientAuthentication: flow === "client_credentials" ? "basic" : "none",
    },
  };
}
beforeEach(async () => {
  available = true;
  await mkdir(".local", { recursive: true });
  dir = await mkdtemp(resolve(".local/http-tests-"));
  provider = await apiProvider();
  store = new ApiConnections(join(dir, "apis.json"), protection);
  await store.init();
  tools = new HttpTools(store, provider.open);
});
afterEach(async () => {
  vi.useRealTimers();
  tools.cancel();
  await store.settled();
  await provider.close();
  await rm(dir, { recursive: true, force: true });
});

it("cadastro privado protegido, reinício, isolamento e credencial salva nunca retornam no snapshot", async () => {
  await save();
  const file = await readFile(join(dir, "apis.json"), "utf8");
  expect(file).not.toContain("synthetic-bearer");
  expect(JSON.stringify(snapshot())).not.toContain("synthetic-bearer");
  expect(JSON.stringify(snapshot())).not.toContain("encryptedSecrets");
  const restarted = new ApiConnections(join(dir, "apis.json"), protection);
  await restarted.init();
  const state = restarted.snapshot(dir);
  expect(restarted.secrets(dir, state.revision, state.connections[0].id).credential).toBe(
    "synthetic-bearer",
  );
  expect(restarted.snapshot(dir + "-neighbor").connections).toEqual([]);
  await expect(
    store.save(
      dir,
      snapshot().revision,
      args().connectionId,
      { ...config(), baseUrl: `${provider.url}/other/` },
      "",
      true,
    ),
  ).rejects.toThrow("nova credencial");
  expect(snapshot().connections[0].config.baseUrl).toBe(config().baseUrl);
});
it("credenciais de sessão desaparecem ao reiniciar e proteção indisponível não cai para texto simples", async () => {
  available = false;
  await expect(save()).rejects.toThrow("Armazenamento protegido");
  await save(config(), "synthetic-session-secret", false);
  expect(snapshot().connections[0].authenticated).toBe(true);
  const restarted = new ApiConnections(join(dir, "apis.json"), protection);
  await restarted.init();
  expect(restarted.snapshot(dir).connections[0].authenticated).toBe(false);
  expect(await readFile(join(dir, "apis.json"), "utf8")).not.toContain("synthetic-session-secret");
});
it("falha de persistência preserva cadastro, segredo e revisão; recuperação e exclusão funcionam", async () => {
  await save();
  const before = snapshot();
  await mkdir(join(dir, "apis.json.tmp"));
  await expect(
    store.save(
      dir,
      before.revision,
      args().connectionId,
      { ...config(), name: "Editada" },
      "replacement",
      true,
    ),
  ).rejects.toThrow("preservados");
  expect(snapshot()).toEqual(before);
  await rm(join(dir, "apis.json.tmp"), { recursive: true });
  await store.save(
    dir,
    before.revision,
    args().connectionId,
    { ...config(), name: "Editada" },
    "",
    false,
  );
  expect(await readFile(join(dir, "apis.json"), "utf8")).not.toContain("encryptedSecrets");
  expect(store.secrets(dir, snapshot().revision, args().connectionId).credential).toBe(
    "synthetic-bearer",
  );
  await store.remove(dir, snapshot().revision, args().connectionId);
  expect(snapshot().connections).toEqual([]);
});
it("credencial copiada entre projeto/perfil/destino falha fechada", async () => {
  await save();
  const data = JSON.parse(await readFile(join(dir, "apis.json"), "utf8"));
  data.projects[dir + "-neighbor"] = [{ ...data.projects[dir][0], id: randomUUID() }];
  await writeFile(join(dir, "apis.json"), JSON.stringify(data));
  const restarted = new ApiConnections(join(dir, "apis.json"), protection);
  await restarted.init();
  const state = restarted.snapshot(dir + "-neighbor");
  expect(() =>
    restarted.secrets(dir + "-neighbor", state.revision, state.connections[0].id),
  ).toThrow("desbloquear");
});
it.each([
  "file:///tmp/a",
  "https://user:pass@example.invalid",
  "https://example.invalid?token=x",
  "https://example.invalid/#x",
  "javascript:invalid",
])("recusa URL de configuração insegura: %s", (baseUrl) => {
  expect(apiConfigSchema.safeParse({ ...config(), baseUrl }).success).toBe(false);
});
it("HTTPS padrão, HTTP explícito, ids/limites e extras do IPC validados", () => {
  expect(apiConfigSchema.safeParse({ ...config(), allowHttp: false }).success).toBe(false);
  expect(
    apiConfigSchema.safeParse({
      ...config(),
      baseUrl: "https://api.example.invalid/v1",
      allowHttp: false,
    }).success,
  ).toBe(true);
  expect(
    actionSchema.safeParse({
      type: "saveApi",
      projectPath: dir,
      revision: randomUUID(),
      connectionId: null,
      config: config(),
      secret: "synthetic",
      remember: true,
      shell: "ignored",
    }).success,
  ).toBe(false);
  expect(httpArguments.safeParse({ ...argsSafe(), body: "x".repeat(131073) }).success).toBe(false);
});
function argsSafe() {
  return {
    connectionId: randomUUID(),
    revision: randomUUID(),
    method: "GET",
    path: "items",
    risk: "routine",
    intent: "consultar fixture",
  };
}
it.each([
  "https://example.invalid",
  "//example.invalid/x",
  "../outside",
  "%2e%2e/outside",
  "/%252e%252e/outside",
  "/%2foutside",
  "/foo\\bar",
  "x?access_token=secret",
  "x#fragment",
])("recusa escape de destino e credencial na URL: %s", (path) => {
  expect(() => apiRequestUrl(config(), path)).toThrow(ApiFailure);
});
it("GET Bearer injeta somente no transporte, devolve resposta sanitizada e métricas sem segredo", async () => {
  await save();
  const observed = vi.fn();
  const result = await tools.execute(dir, args(), "project", false, observed);
  expect(result.success).toBe(true);
  expect(provider.state.requests[0].authorization).toBe("Bearer synthetic-bearer");
  expect(JSON.stringify(result)).not.toContain("synthetic-bearer");
  expect(JSON.stringify(result)).not.toContain("synthetic-not-for-model");
  expect(JSON.stringify(result)).toContain("credencial removida");
  expect(observed).toHaveBeenCalledWith(200, expect.any(Number), false);
});
it("Basic com senha, cabeçalhos validados, POST exige aprovação e Leitura bloqueia mesmo aprovado", async () => {
  await save(
    { ...config(), auth: { type: "basic", user: "synthetic-user" } },
    "synthetic-password",
  );
  for (const name of [
    "Authorization",
    "Cookie",
    "X-Api-Key",
    "Host",
    "Proxy-Authorization",
    "Content-Length",
  ]) {
    const result = await tools.execute(
      dir,
      { ...args(), headers: [{ name, value: "forged" }] },
      "project",
    );
    expect(result.success).toBe(false);
  }
  const post = { ...args(), method: "POST" as const, body: '{"name":"synthetic"}' };
  expect((await tools.execute(dir, post, "project")).success).toBe(false);
  expect((await tools.execute(dir, post, "read", true)).success).toBe(false);
  expect(provider.state.requests).toHaveLength(0);
  const result = await tools.execute(dir, post, "project", true);
  expect(result.success).toBe(true);
  expect(JSON.stringify(result)).not.toContain(
    Buffer.from("synthetic-user:synthetic-password").toString("base64"),
  );
  expect(provider.state.requests).toHaveLength(1);
  expect(provider.state.requests[0].method).toBe("POST");
});
it("redirect não é seguido, erro 401 é redigido, HTML e resposta excessiva falham sem replay; recupera", async () => {
  await save();
  for (const path of ["redirect", "error", "html", "large"])
    expect((await tools.execute(dir, { ...args(), path }, "project")).success).toBe(false);
  expect(provider.state.requests).toHaveLength(4);
  expect(provider.state.requests.some((entry: { path: string }) => entry.path === "/outside")).toBe(
    false,
  );
  expect((await tools.execute(dir, args(), "project")).success).toBe(true);
});
it("cancelamento após handshake fecha request antes de liberar a fila e permite recuperação", async () => {
  await save();
  const pending = tools.execute(dir, { ...args(), path: "slow" }, "project");
  await vi.waitFor(() => expect(provider.state.slow).toBe(1));
  tools.cancel();
  expect(JSON.stringify(await pending)).toContain("cancelada");
  expect((await tools.execute(dir, args(), "project")).success).toBe(true);
});
it("timeout avança relógio somente depois de request observado", async () => {
  await save();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = tools.execute(dir, { ...args(), path: "slow" }, "project");
  await vi.waitFor(() => expect(provider.state.slow).toBe(1));
  await vi.advanceTimersByTimeAsync(5000);
  expect(JSON.stringify(await pending)).toContain("prazo");
  vi.useRealTimers();
  expect(provider.state.requests).toHaveLength(1);
});
it("TLS inválido não chega ao endpoint HTTP e não expõe URL ou segredo", async () => {
  let count = 0;
  const tls = httpsServer(
    {
      key: await readFile("tests/fixtures/tls/loopback-key.pem"),
      cert: await readFile("tests/fixtures/tls/loopback-cert.pem"),
    },
    (_req, res) => {
      count++;
      res.end("{}");
    },
  );
  await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
  try {
    await expect(
      requestHttp(
        new URL(`https://127.0.0.1:${(tls.address() as { port: number }).port}/v1`),
        "GET",
        { Authorization: "Bearer synthetic" },
        "",
        new AbortController().signal,
        5,
      ),
    ).rejects.toThrow("certificado HTTPS");
    expect(count).toBe(0);
  } finally {
    tls.closeAllConnections();
    await new Promise<void>((resolve) => tls.close(() => resolve()));
  }
});
it("OAuth2 code + PKCE real, refresh rotativo, restart protegido e request autenticado", async () => {
  const raw = await oauthConfig();
  await save(raw, "", true);
  provider.state.expiresIn = 10;
  await tools.authenticate(dir, snapshot().revision, args().connectionId);
  expect(provider.state.tokens).toBe(1);
  expect(provider.state.authorizations[0].code_challenge_method).toBe("S256");
  expect(JSON.stringify(snapshot())).not.toContain("synthetic-access");
  provider.state.expiresIn = 3600;
  expect((await tools.execute(dir, args(), "project")).success).toBe(true);
  expect(provider.state.refreshes).toBe(1);
  expect(store.secrets(dir, snapshot().revision, args().connectionId).refreshToken).toBe(
    "synthetic-refresh-2",
  );
  const restarted = new ApiConnections(join(dir, "apis.json"), protection);
  await restarted.init();
  const state = restarted.snapshot(dir);
  expect(state.connections[0].authenticated).toBe(true);
  expect(
    (
      await new HttpTools(restarted, provider.open).execute(
        dir,
        { ...args(), revision: state.revision },
        "project",
      )
    ).success,
  ).toBe(true);
  expect(provider.state.tokens).toBe(2);
});
it("OAuth2 client credentials no header ou corpo, falha de refresh não envia API nem expõe token", async () => {
  const raw = await oauthConfig("client_credentials");
  await save(raw, "synthetic-client-secret");
  provider.state.expiresIn = 10;
  await tools.authenticate(dir, snapshot().revision, args().connectionId);
  expect(provider.state.requests[0].authorization).toBe(
    `Basic ${Buffer.from("synthetic-client:synthetic-client-secret").toString("base64")}`,
  );
  provider.state.tokenStatus = 400;
  const result = await tools.execute(dir, args(), "project");
  expect(result.success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("synthetic-secret-error");
  expect(provider.state.requests.every((entry: { path: string }) => entry.path === "/token")).toBe(
    true,
  );
  provider.state.tokenStatus = 200;
  provider.state.expiresIn = 3600;
  await tools.authenticate(dir, snapshot().revision, args().connectionId);
  expect((await tools.execute(dir, args(), "project")).success).toBe(true);
});
it("callback rejeita state, host e método inválidos; depois aceita somente o retorno esperado", async () => {
  const raw = await oauthConfig();
  if (raw.auth.type !== "oauth2") throw new Error();
  const auth = raw.auth;
  const result = await obtainApiTokens(
    raw,
    { credential: "" },
    new AbortController().signal,
    async (url) => {
      const target = new URL(url);
      const callback = new URL(oauthRedirectUri(auth));
      callback.search = "?state=forged&code=forged";
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", target.searchParams.get("state")!);
      expect((await fetch(callback, { method: "POST" })).status).toBe(400);
      expect(
        (
          await requestHttp(
            callback,
            "GET",
            { Host: "malicious.invalid" },
            "",
            new AbortController().signal,
            5,
          )
        ).status,
      ).toBe(400);
      await provider.open(url);
    },
  );
  expect(result.accessToken).toBe("synthetic-access-1");
  expect(provider.state.tokens).toBe(1);
});
it("recusa OAuth2, cancelamento e porta ocupada limpam listener e permitem outro login", async () => {
  const raw = await oauthConfig();
  if (raw.auth.type !== "oauth2") throw new Error();
  const redirect = oauthRedirectUri(raw.auth);
  await expect(
    obtainApiTokens(raw, { credential: "" }, new AbortController().signal, async (url) => {
      const state = new URL(url).searchParams.get("state")!;
      await fetch(`${redirect}?state=${state}&error=access_denied`);
    }),
  ).rejects.toThrow("recusou");
  const controller = new AbortController();
  await expect(
    obtainApiTokens(raw, { credential: "" }, controller.signal, async () => {
      controller.abort();
    }),
  ).rejects.toThrow("cancelado");
  const occupied = createServer();
  await new Promise<void>((resolve) =>
    occupied.listen((raw.auth as typeof emptyOAuthConfig).callbackPort, "127.0.0.1", resolve),
  );
  try {
    await expect(
      obtainApiTokens(raw, { credential: "" }, new AbortController().signal, provider.open),
    ).rejects.toThrow("porta");
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
  expect(
    (await obtainApiTokens(raw, { credential: "" }, new AbortController().signal, provider.open))
      .accessToken,
  ).toBeTruthy();
});
it("respostas textuais e JSON removem segredos conhecidos e campos sensíveis", () => {
  expect(
    redactApiResponse('{"ok":1,"secret":"new secret","echo":"Bearer savedsecret"}', [
      "savedsecret",
    ]),
  ).not.toContain("savedsecret");
  expect(redactApiResponse("authorization: Bearer abc\npassword=hidden&ok=1", [])).not.toMatch(
    /abc|hidden/,
  );
});

it("formulário vazio ou parcialmente digitado produz validação, nunca exceção", () => {
  expect(() =>
    apiConfigSchema.safeParse({ ...config(), name: "", baseUrl: "", allowHttp: false }),
  ).not.toThrow();
  expect(
    apiConfigSchema.safeParse({ ...config(), name: "", baseUrl: "", allowHttp: false }).success,
  ).toBe(false);
  expect(
    apiConfigSchema.safeParse({
      ...config(),
      auth: {
        ...emptyOAuthConfig,
        tokenUrl: "https://",
        authorizationUrl: "https://",
        clientId: "x",
      },
      allowHttp: false,
    }).success,
  ).toBe(false);
});
it("OAuth com autenticação no corpo envia segredo apenas ao token endpoint", async () => {
  const raw = await oauthConfig("client_credentials");
  if (raw.auth.type !== "oauth2") throw new Error();
  raw.auth.clientAuthentication = "body";
  await save(raw, "synthetic-body-client-secret");
  await tools.authenticate(dir, snapshot().revision, args().connectionId);
  const request = provider.state.requests[0];
  expect(request.authorization).toBeUndefined();
  expect(new URLSearchParams(request.body).get("client_secret")).toBe(
    "synthetic-body-client-secret",
  );
  expect(JSON.stringify(snapshot())).not.toContain("synthetic-body-client-secret");
});

it.each([403, 503])(
  "HTTP %s informa falha sem replay, credenciais ou body bruto no erro",
  async (status) => {
    let requests = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "synthetic refusal", access_token: "synthetic-response-secret" }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await save({
        ...config(),
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/`,
      });
      const result = await tools.execute(dir, args(), "project");
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).toContain(String(status));
      expect(JSON.stringify(result)).not.toContain("synthetic-response-secret");
      expect(requests).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
it("aprovação inclui o corpo completo da operação, inclusive dados após 6000 caracteres", async () => {
  await save();
  const body = JSON.stringify({ data: "x".repeat(6100), effect: "synthetic-tail-to-review" });
  const approval = tools.approval(
    dir,
    { ...args(), method: "POST", body },
    "project",
    "Efeito sintético",
  );
  expect(approval.detail).toContain(body);
});

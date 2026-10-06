import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

// Destino fixo na rede Compose: este probe nao pode apontar para a VPS/conta real.
const base = "http://proxy:8080";
const authorization = (publicKey, secretKey) =>
  `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`;
const keyA = authorization(process.env.LANGFUSE_PUBLIC_KEY, process.env.LANGFUSE_SECRET_KEY);
const keyB = authorization(process.env.TEST_PUBLIC_KEY_B, process.env.TEST_SECRET_KEY_B);
const traceId = "aabbccddeeff00112233445566778899";
const spanId = "0011223344556677";
const attr = (key, value) => ({
  key,
  value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
});
const now = BigInt(Date.now()) * 1_000_000n;
const body = {
  resourceSpans: [
    {
      resource: { attributes: [attr("service.name", "stag-synthetic")] },
      scopeSpans: [
        {
          scope: { name: "stag-server-smoke", version: "1" },
          spans: [
            {
              traceId,
              spanId,
              name: "stag.synthetic.turn",
              kind: 1,
              startTimeUnixNano: String(now - 100_000_000n),
              endTimeUnixNano: String(now),
              status: { code: 1 },
              attributes: [
                attr("langfuse.trace.name", "stag.synthetic.turn"),
                attr("langfuse.session.id", "synthetic-session"),
                attr("langfuse.observation.type", "generation"),
                attr("gen_ai.request.model", "synthetic-model"),
                attr("gen_ai.usage.input_tokens", 10),
                attr("gen_ai.usage.output_tokens", 4),
                attr("langfuse.trace.metadata.project", "synthetic-project"),
                attr("langfuse.trace.metadata.contract", "synthetic-v1"),
                attr("langfuse.trace.metadata.outcome", "completed"),
                attr("langfuse.environment", "test"),
              ],
            },
          ],
        },
      ],
    },
  ],
};

async function request(path, { key = keyA, method = "GET", payload } = {}) {
  return fetch(`${base}${path}`, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: {
      ...(key ? { authorization: key } : {}),
      "content-type": "application/json",
      "x-langfuse-ingestion-version": "4",
    },
    ...(payload === undefined
      ? {}
      : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
  });
}

async function until(check, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(1500);
  }
  throw new Error(label);
}

async function verifyTrace() {
  const path = `/api/public/v2/observations?traceId=${traceId}&fields=basic,io,metadata,model,usage,trace_context`;
  await until(async () => {
    const response = await request(path);
    assert.equal(response.status, 200, "consulta autenticada");
    const { data } = await response.json();
    if (data?.length !== 1) return false;
    const observation = data[0];
    assert.equal(observation.name, "stag.synthetic.turn");
    assert.equal(observation.id, spanId);
    assert.equal(observation.projectId, "stag-pilot");
    assert.ok(observation.input == null || observation.input === "", "sem entrada textual");
    assert.ok(observation.output == null || observation.output === "", "sem resposta textual");
    assert.equal(observation.model, "synthetic-model");
    assert.equal(observation.usageDetails.input, 10);
    assert.equal(observation.usageDetails.output, 4);
    return true;
  }, "trace nao ficou consultavel com uma unica observacao");
  const foreign = await request(path, { key: keyB });
  assert.equal(foreign.status, 200, "consulta de B valida");
  assert.equal((await foreign.json()).data.length, 0, "projeto B nao le A");
  const listing = await request("/api/public/v2/observations", { key: keyB });
  assert.equal(listing.status, 200, "chave B valida");
  assert.equal((await listing.json()).data.length, 0, "projeto B sem traces de A");
}

try {
  const phase = process.argv[2];
  if (phase === "down") {
    let unavailable = false;
    try {
      unavailable = !(await request("/api/public/health")).ok;
    } catch {
      unavailable = true;
    }
    assert.ok(unavailable, "indisponibilidade observavel");
  } else if (phase === "persisted") {
    await verifyTrace();
  } else if (phase === "ingest") {
    const login = await request("/auth/sign-in", { key: null });
    assert.equal(login.status, 200, "dashboard acessivel");
    for (const key of [null, authorization("invalid", "invalid")]) {
      for (const [path, options] of [
        ["/api/public/otel/v1/traces", { method: "POST", payload: body }],
        ["/api/public/v2/observations", {}],
      ]) {
        const denied = await request(path, { ...options, key });
        assert.ok([401, 403].includes(denied.status), "autenticacao obrigatoria");
      }
    }
    const invalid = await request("/api/public/otel/v1/traces", { method: "POST", payload: "{" });
    assert.ok(invalid.status >= 400 && invalid.status < 500, "JSON invalido recusado");
    const oversized = await request("/api/public/otel/v1/traces", {
      method: "POST",
      payload: " ".repeat(1024 * 1024 + 1),
    });
    assert.equal(oversized.status, 413, "limite do proxy");
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const accepted = await request("/api/public/otel/v1/traces", {
        method: "POST",
        payload: body,
      });
      assert.equal(accepted.status, 200, "ingestao OTLP");
      const result = await accepted.json();
      assert.equal(Number(result.partialSuccess?.rejectedSpans || 0), 0, "span aceito");
    }
    await verifyTrace();
  } else throw new Error("fase desconhecida");
  console.log(`Probe ${phase}: aprovado.`);
} catch (error) {
  // Nao imprimir corpo, headers, excecao do fetch ou valores comparados.
  console.error(
    `Probe falhou: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : "integracao indisponivel ou resposta inesperada"}.`,
  );
  process.exitCode = 1;
}

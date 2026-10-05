import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { RpcClient } from "../../src/main/rpc";
import { codexEnvironment } from "../../src/main/policy";

const clients: RpcClient[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(clients.map((c) => c.shutdown()));
  clients.length = 0;
  await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })));
  directories.length = 0;
});
const requestTimeout = 30000;
async function client() {
  await mkdir(".local", { recursive: true });
  const dir = await mkdtemp(resolve(".local/rpc-test-"));
  directories.push(dir);
  const rpc = new RpcClient(
    {
      command: process.execPath,
      args: [resolve("tests/fixtures/app-server.mjs")],
      cwd: dir,
      env: codexEnvironment(resolve(dir, "home")),
    },
    requestTimeout,
  );
  clients.push(rpc);
  await rpc.start();
  return rpc;
}
describe("JSONL bidirecional", () => {
  it("faz handshake e correlaciona requests concorrentes", async () => {
    const rpc = await client();
    const [models, account] = await Promise.all([
      rpc.call<{ data: unknown[] }>("model/list"),
      rpc.call<{ account: null }>("account/read"),
    ]);
    expect(models.data).toHaveLength(1);
    expect(account.account).toBeNull();
  });
  it("encerra chamadas pendentes no exit e permite criar nova conexão", async () => {
    const rpc = await client();
    await expect(rpc.call("_fixture/exit")).rejects.toThrow("encerrou");
    await expect(rpc.call("account/read")).rejects.toThrow("desconectado");
    expect(await (await client()).call("account/read")).toHaveProperty("account", null);
  });
  it("recusa JSON inválido sem travar uma chamada", async () => {
    const rpc = await client();
    await expect(rpc.call("_fixture/malformed")).rejects.toThrow("inválida");
  });
  it("limita o tempo de espera sem repetir a operação", async () => {
    const rpc = await client();
    // The handshake uses real time; only the unanswered request uses a controlled clock.
    vi.useFakeTimers();
    const timedOut = expect(rpc.call("_fixture/timeout")).rejects.toThrow("demorou");
    await vi.advanceTimersByTimeAsync(requestTimeout);
    await timedOut;
    vi.useRealTimers();
    expect(await rpc.call("account/read")).toHaveProperty("account", null);
    const calls = await rpc.call<{ method?: string }[]>("_fixture/readCalls");
    expect(calls.filter((call) => call.method === "_fixture/timeout")).toHaveLength(1);
  });
  it("entrega erro RPC como falha", async () => {
    const rpc = await client();
    await expect(rpc.call("unknown")).rejects.toThrow("Unsupported");
  });
  it("recebe histórico maior que 8 MB e recusa frame acima de 32 MB sem travar", async () => {
    const rpc = await client();
    const result = await rpc.call<{ synthetic: string }>("_fixture/largeFrame", {
      size: 9 * 1024 * 1024,
    });
    expect(result.synthetic.length).toBe(9 * 1024 * 1024);
    await expect(rpc.call("_fixture/largeFrame", { size: 33 * 1024 * 1024 })).rejects.toThrow(
      "acima do limite",
    );
  });
});

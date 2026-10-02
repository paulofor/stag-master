import { afterEach, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { RpcClient } from "../../src/main/rpc";

const clients: RpcClient[] = [];
afterEach(() => {
  clients.forEach((c) => c.close());
  clients.length = 0;
});
async function client(timeout = 1000) {
  const rpc = new RpcClient(
    { command: process.execPath, args: [resolve("tests/fixtures/app-server.mjs")] },
    timeout,
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
    const rpc = await client(100);
    await expect(rpc.call("_fixture/timeout")).rejects.toThrow("demorou");
    expect(await rpc.call("account/read")).toHaveProperty("account", null);
  });
  it("entrega erro RPC como falha", async () => {
    const rpc = await client();
    await expect(rpc.call("unknown")).rejects.toThrow("Unsupported");
  });
});

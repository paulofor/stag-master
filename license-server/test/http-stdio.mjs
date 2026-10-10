// Test-only transport for a Docker engine isolated from the caller's loopback.
// Fixed loopback destination; input/output stay in pipes and are never logged.
import { request as httpRequest } from "node:http";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 100_000) throw new Error("Requisição sintética muito grande.");
}
const request = JSON.parse(input);
const url = new URL(request.path, "http://127.0.0.1:8080");
if (url.origin !== "http://127.0.0.1:8080") throw new Error("Destino de teste inválido.");
const payload = request.body ? Buffer.from(request.body, "base64") : undefined;
if (payload) request.headers["content-length"] = String(payload.length);
const response = await new Promise((resolve, reject) => {
  const call = httpRequest(url, { method: request.method, headers: request.headers }, (res) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > 512 * 1024) res.destroy(new Error("Limite da resposta sintética."));
      else chunks.push(chunk);
    });
    res.once("error", reject);
    res.once("end", () =>
      resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString("base64"),
      }),
    );
  });
  call.once("error", reject);
  call.setTimeout(15_000, () => call.destroy(new Error("Timeout sintético.")));
  call.end(payload);
});
for (const name of ["connection", "transfer-encoding", "content-length", "keep-alive"])
  delete response.headers[name];
process.stdout.write(JSON.stringify(response));

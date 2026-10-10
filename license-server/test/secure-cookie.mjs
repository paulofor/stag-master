// Exercise the production HTTP handler with HTTPS origin configuration and the real test DB.
// This checks cookie policy; public TLS/certificate validation still belongs to the future VPS.
import { request } from "node:http";
import { loadConfig } from "./dist/config.js";
import { Store } from "./dist/store.js";
import { createApp } from "./dist/app.js";
let input = "";
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 1024) throw new Error("Entrada sintética inválida.");
}
const password = JSON.parse(input).password;
const config = await loadConfig({
  ...process.env,
  PUBLIC_URL: "https://licenses.synthetic.invalid",
});
const store = new Store(config.database);
const server = await createApp(config, store, () => {});
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const data = JSON.stringify({ username: "admin", password });
  const result = await new Promise((resolve, reject) => {
    const call = request(
      {
        hostname: "127.0.0.1",
        port: server.address().port,
        path: "/api/admin/login",
        method: "POST",
        headers: {
          host: "licenses.synthetic.invalid",
          origin: config.origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const cookie = res.headers["set-cookie"]?.[0] || "";
        res.resume();
        res.once("end", () =>
          resolve({
            status: res.statusCode,
            secure: cookie.includes("; Secure"),
            hostPrefix: cookie.startsWith("__Host-stag-license="),
            httpOnly: cookie.includes("; HttpOnly"),
            sameSite: cookie.includes("; SameSite=Strict"),
          }),
        );
      },
    );
    call.once("error", reject);
    call.end(data);
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await store.pool.end();
}

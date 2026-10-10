import { createServer } from "node:https";
import { readFile } from "node:fs/promises";

// Public synthetic key/certificate for loopback tests only. Never install it in a trust store.
export async function startBrowserTlsSite() {
  const effects = { requests: 0, files: 0 };
  const server = createServer(
    {
      key: await readFile(new URL("./tls/loopback-key.pem", import.meta.url)),
      cert: await readFile(new URL("./tls/loopback-cert.pem", import.meta.url)),
    },
    (request, response) => {
      effects.requests++;
      if (request.url?.split("?")[0] === "/document.pdf") effects.files++;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<h1>UNTRUSTED_SYNTHETIC_CONTENT</h1><a href="/document.pdf">Documento TLS sintético</a>',
      );
    },
  );
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `https://127.0.0.1:${server.address().port}/`,
    effects,
    rotateCertificate: async () => {
      server.setSecureContext({
        key: await readFile(new URL("./tls/loopback-key.pem", import.meta.url)),
        cert: await readFile(new URL("./tls/loopback-rotated-cert.pem", import.meta.url)),
      });
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

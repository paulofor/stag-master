import { createServer } from "node:http";
import { syntheticBrowserPdf } from "./browser-pdf.mjs";

// Small stored ZIP containing consulta.txt, made by the versioned fixture, not client content.
export function syntheticBrowserZip() {
  const name = Buffer.from("consulta.txt"),
    body = Buffer.from("Requisito sintetico: conferir remessa antes de enviar.\n");
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

export async function startDownloadSite() {
  const counts = {},
    active = new Set();
  let url = "";
  const server = createServer((request, response) => {
    const path = request.url;
    counts[path] = (counts[path] || 0) + 1;
    if (path === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Set-Cookie": "download_session=synthetic; HttpOnly; SameSite=Strict; Path=/",
      });
      response.end(
        `<h1>Documentos sintéticos</h1><input id="draft" value="rascunho preservado">${["pdf", "zip", "private", "redirect", "invalid", "large", "stream", "hang", "local", "loop"].map((name) => `<p><a href="/${name}">${name}</a></p>`).join("")}`,
      );
    } else if (path === "/redirect" || path === "/loop" || path === "/local") {
      response.writeHead(302, {
        Location: path === "/local" ? "file:///private" : path === "/loop" ? "/loop" : "/zip",
      });
      response.end();
    } else if (
      path === "/private" &&
      !request.headers.cookie?.includes("download_session=synthetic")
    ) {
      response.writeHead(403);
      response.end("Login necessario");
    } else if (path === "/pdf" || path === "/private") {
      const body = syntheticBrowserPdf();
      response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": body.length });
      response.end(body);
    } else if (path === "/zip") {
      const body = syntheticBrowserZip();
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "Content-Disposition": 'attachment; filename="../../injetado.exe"',
      });
      response.end(body);
    } else if (path === "/large") {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": 101 * 1024 * 1024,
      });
      response.flushHeaders();
    } else if (path === "/hang" || path === "/stream") {
      active.add(response);
      response.once("close", () => active.delete(response));
      response.writeHead(200, { "Content-Type": "application/pdf" });
      response.flushHeaders();
      if (path === "/stream") response.write(syntheticBrowserPdf());
    } else {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<h1>Login necessario</h1>");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}/`;
  return {
    url,
    counts,
    active,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

import { createServer } from "node:http";
import { syntheticBrowserPdf } from "./browser-pdf.mjs";

// Small stored ZIP containing consulta.txt, made by the versioned fixture, not client content.
export function syntheticBrowserZip(
  entries = { "consulta.txt": "Requisito sintetico: conferir remessa antes de enviar.\n" },
) {
  const locals = [],
    centrals = [];
  let offset = 0;
  for (const [key, value] of Object.entries(entries)) {
    const name = Buffer.from(key),
      body = Buffer.from(value);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30),
      central = Buffer.alloc(46);
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
    central.writeUInt32LE(offset, 42);
    const part = Buffer.concat([local, name, body]);
    locals.push(part);
    centrals.push(Buffer.concat([central, name]));
    offset += part.length;
  }
  const central = Buffer.concat(centrals),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(locals.length, 8);
  end.writeUInt16LE(locals.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

export const syntheticBrowserXlsx = () =>
  syntheticBrowserZip({
    "[Content_Types].xml":
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml":
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sintetico" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml":
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Sintetico</t></is></c></row></sheetData></worksheet>',
  });

export async function startDownloadSite({ redirectTarget } = {}) {
  const counts = {},
    active = new Set();
  let url = "";
  const server = createServer((request, response) => {
    const path = request.url;
    counts[path] = (counts[path] || 0) + 1;
    if (path === "/") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": "download_session=synthetic; HttpOnly; SameSite=Strict; Path=/",
      });
      response.end(
        `<style>body{font:14px sans-serif}p{margin:4px}button{margin:4px}</style><h1>Documentos sintéticos</h1><input id="draft" value="rascunho preservado">${["pdf", "zip", "private", "redirect", "invalid", "large", "stream", "hang", "local", "loop", "xlsx"].map((name) => `<p><a href="/${name}">${name}</a></p>`).join("")}
        <button id="excel" onclick="exportBlob()">Baixar Excel</button>
        <button id="double" onclick="exportBlob();exportBlob()">Duas exportações</button>
        <button onclick="location.href='/attachment'">Exportar por navegação</button>
        <button onclick="exportPost()">Exportar POST</button>
        <button onclick="save(new Blob(['<html>login</html>'],{type:'text/html'}),'login.csv')">Exportação inválida</button>
        <button onclick="save(new Blob(['MZ synthetic'],{type:'application/octet-stream'}),'setup.exe')">Arquivo bloqueado</button>
        <button onclick="location.href='/stream-attachment'">Exportação lenta</button>
        <button onclick="location.href='/large-attachment'">Exportação grande</button>
        <button id="nothing" onclick="window.noExport=(window.noExport||0)+1">Sem arquivo</button>
        <form action="/attachment"><button>Exportar formulário</button></form>
        <a id="js-link" href="#" onclick="event.preventDefault();exportBlob()">Link JavaScript</a>
        <a href="data:text/csv,empresa%3Bvalor%0ASintetica%3B10%0A" download="retorno.csv">Link data</a>
        <a id="blob-link" download="retorno.xlsx">Link blob</a>
        <script>
          function save(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),5000)}
          function exportBlob(){window.exportCount=(window.exportCount||0)+1;save(new Blob([Uint8Array.from(atob('${syntheticBrowserXlsx().toString("base64")}'),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),'retorno.xlsx')}
          async function exportPost(){const r=await fetch('/post',{method:'POST'});save(await r.blob(),'retorno.csv')}
          document.querySelector('#blob-link').href=URL.createObjectURL(new Blob([Uint8Array.from(atob('${syntheticBrowserXlsx().toString("base64")}'),c=>c.charCodeAt(0))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
        </script>`,
      );
    } else if (path === "/redirect" || path === "/loop" || path === "/local") {
      response.writeHead(302, {
        Location:
          path === "/local"
            ? "file:///private"
            : path === "/loop"
              ? "/loop"
              : redirectTarget || "/zip",
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
    } else if (path === "/post") {
      response.writeHead(request.method === "POST" ? 200 : 405, { "Content-Type": "text/csv" });
      response.end("empresa;valor\nSintetica;10\n");
    } else if (path === "/xlsx" || path === "/attachment") {
      const body = syntheticBrowserXlsx();
      response.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="retorno.xlsx"',
        "Content-Length": body.length,
      });
      response.end(body);
    } else if (path === "/zip") {
      const body = syntheticBrowserZip();
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": body.length,
        "Content-Disposition": 'attachment; filename="../../injetado.exe"',
      });
      response.end(body);
    } else if (path === "/large" || path === "/large-attachment") {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": 101 * 1024 * 1024,
        ...(path.endsWith("attachment")
          ? { "Content-Disposition": 'attachment; filename="big.pdf"' }
          : {}),
      });
      response.flushHeaders();
    } else if (path === "/hang" || path === "/stream" || path === "/stream-attachment") {
      active.add(response);
      response.once("close", () => active.delete(response));
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        ...(path.endsWith("attachment")
          ? { "Content-Disposition": 'attachment; filename="slow.pdf"' }
          : {}),
      });
      response.flushHeaders();
      if (path.startsWith("/stream")) response.write(syntheticBrowserPdf());
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

import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { syntheticBrowserPdf } from "./browser-pdf.mjs";

// Every page and field is synthetic. Only loopback traffic, with no account or external service.
export async function startBrowserSite() {
  const dateScript = (
    await build({
      entryPoints: ["tests/fixtures/browser-dates.mjs"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
    })
  ).outputFiles[0].text;
  const dateCss = await readFile("node_modules/primeng/resources/primeng.min.css", "utf8");
  const comboScript = (
    await build({
      entryPoints: ["tests/fixtures/browser-combos.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
    })
  ).outputFiles[0].text;
  const effects = { submissions: 0, downloads: 0, hangs: 0, testWrites: 0 };
  let testRows = [];
  const server = createServer((request, response) => {
    if (request.url === "/testing/write" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const params = new URLSearchParams(body);
        if (params.get("operation") === "delete") testRows = [];
        else testRows = [params.get("name") + ":" + params.get("date")];
        effects.testWrites++;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ rows: testRows, writes: effects.testWrites }));
      });
      return;
    }
    if (request.url === "/testing") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body>
        <h1>Sistema sintético de homologação</h1>
        <form id="testing" action="/testing/write" method="post">
          <label>Nome de teste <input name="name" value="Registro sintético"></label>
          <label>Data de teste <input type="date" name="date" value="2026-10-10"></label>
          <button type="submit">Cadastrar</button>
          <button type="button" id="edit">Salvar edição</button>
          <button type="button" id="delete">Excluir registro de teste</button>
        </form>
        <output id="rows"></output>
        <button id="publish">Publicar</button><button id="pay">Pagar</button>
        <button id="security">Segurança</button>
        <a href="https://external.invalid/submit">Enviar para terceiro</a>
        <form action="/testing/write" method="post"><label>Senha <input type="password"></label><button>Continuar</button></form>
        <script>
          const form=document.querySelector('#testing');
          async function write(operation) {
            const body=new URLSearchParams(new FormData(form)); body.set('operation',operation);
            const data=await fetch(form.action,{method:'POST',body}).then(r=>r.json());
            document.querySelector('#rows').textContent=JSON.stringify(data);
          }
          form.addEventListener('submit',e=>{e.preventDefault();void write('create');});
          document.querySelector('#edit').onclick=()=>write('edit');
          document.querySelector('#delete').onclick=()=>write('delete');
        </script></body></html>`);
      return;
    }
    if (request.url === "/dates.js" || request.url === "/dates.css") {
      response.writeHead(200, {
        "Content-Type": request.url.endsWith(".js") ? "text/javascript" : "text/css",
      });
      response.end(request.url.endsWith(".js") ? dateScript : dateCss);
      return;
    }
    if (request.url === "/dates") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Datas sintéticas</title><link rel="stylesheet" href="/dates.css"><style>body{font:16px system-ui;padding:16px}label{display:block;margin:12px 0}input{padding:8px;max-width:90%}.p-datepicker{background:white;border:1px solid #888;padding:12px;box-shadow:0 2px 8px #999}.p-monthpicker-month,.p-yearpicker-year,.p-datepicker-calendar td>span{padding:10px}.p-datepicker-header{padding:8px}.p-disabled{opacity:.4}.p-highlight{background:#cdf}.p-hidden-accessible{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><body><date-controls></date-controls><script src="/dates.js"></script></body></html>',
      );
      return;
    }
    if (["/manual.pdf/@@display-file/file", "/download-pdf"].includes(request.url)) {
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        ...(request.url === "/download-pdf"
          ? { "Content-Disposition": 'attachment; filename="synthetic.pdf"' }
          : {}),
      });
      response.end(syntheticBrowserPdf());
      return;
    }
    if (request.url === "/wide") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Página larga sintética</title>
        <style>body{margin:0;font:16px system-ui}main{min-width:1000px;min-height:1200px;background:#eef3e9;padding:24px;box-sizing:border-box}header{display:flex;justify-content:space-between}</style>
        <body><main><header><h1>Consulta sintética</h1><button>Nova remessa sintética</button></header><p>Página de teste com largura mínima de 1000 pixels.</p></main></body></html>`);
      return;
    }
    if (request.url === "/session-login") {
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      const connected = /(?:^|; )synthetic_login=fixture(?:;|$)/.test(request.headers.cookie || "");
      response.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Login sintético</title><body>
        <h1>${connected ? "Conectado sintético" : "Login necessário"}</h1>
        <form method="POST" action="/session-login/submit"><label>Usuário sintético <input name="username" autocomplete="username"></label>
        <label>Senha sintética <input name="password" type="password" autocomplete="current-password"></label>
        <label><input id="remember" type="checkbox" name="remember" value="SYNTHETIC_PRIVATE_CHECKBOX">Continuar conectado</label><button type="submit">Login sintético</button></form>
        <label><input type="radio" checked>Perfil sintético</label>
        <div role="checkbox" aria-checked="mixed" tabindex="0" style="padding:8px">Preferência mista</div>
        <div role="switch" aria-checked="false" tabindex="0" style="padding:8px" onclick="this.setAttribute('aria-checked',this.getAttribute('aria-checked')!=='true')">Tema sintético</div>
        <script>window.securityProbe = {node:typeof process,require:typeof require,bridge:typeof window.stag};</script>
        </body></html>`);
      return;
    }
    if (request.url === "/session-login/submit" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const remember = new URLSearchParams(body).has("remember");
        response.writeHead(303, {
          Location: "/session-login",
          "Set-Cookie": `synthetic_login=fixture; HttpOnly; SameSite=Strict; Path=/${remember ? "; Max-Age=3600" : ""}`,
          "Cache-Control": "no-store",
        });
        response.end();
      });
      return;
    }
    if (request.url === "/combos.js") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(comboScript);
      return;
    }
    if (request.url === "/combos") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        '<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Combos sintéticos</title><style>body{font:16px system-ui;padding:16px}label{display:block;margin-top:12px}select,input,[role=combobox],[role=option]{padding:8px;border:1px solid #aaa;margin:4px}section{margin:16px 0}[role=listbox]{padding:10px;border:2px solid #467;background:#eef}</style><body><div id="combos"></div><script src="/combos.js"></script></body></html>',
      );
      return;
    }
    if (request.url === "/submit") {
      effects.submissions++;
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<h1>Envio sintético concluído</h1>");
      return;
    }
    if (request.url === "/download") {
      effects.downloads++;
      response.writeHead(200, { "Content-Disposition": 'attachment; filename="synthetic.txt"' });
      response.end("synthetic download");
      return;
    }
    if (request.url === "/hang") {
      effects.hangs++;
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (request.url === "/next") {
      response.end(
        '<title>Página seguinte</title><h1>Próxima página sintética</h1><a href="/">Voltar ao início</a>',
      );
      return;
    }
    if (request.url === "/frame") {
      response.end(
        "<h2>Frame sintético</h2><script>window.remoteBridge = typeof window.stag;</script>",
      );
      return;
    }
    response.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Documentação sintética</title><style>
      body{font:16px system-ui;color:#344b42;background:#fff;padding:24px;max-width:720px;margin:auto}h1{font-size:25px}label{display:block;margin:18px 0 8px}input,select,button,a{font:inherit;padding:9px;margin:5px 4px 5px 0;border-radius:5px}input,select,button{border:1px solid #bacabb}button{background:#eef3e9;color:#355a45;cursor:pointer}section{border-bottom:1px solid #e1e7df;padding-bottom:18px}iframe{width:100%;height:80px;border:1px solid #ddd}
    </style></head><body><h1>Documentação sintética</h1><p>Site local para homologar o navegador do STAG Plus. Nenhum dado real.</p>
    <section><label for="local">Texto local</label><input id="local" aria-label="Texto local"><select aria-label="Seção"><option value="intro">Introdução</option><option value="api">API</option></select><button id="expand" type="button" onclick="window.expansions=(window.expansions||0)+1;document.querySelector('#result').textContent='Seção expandida'">Expandir seção</button><p id="result">Seção recolhida</p><a id="next" href="/next">Próxima página</a></section>
    <section><label for="password">Senha sintética</label><input id="password" type="password" aria-label="Senha sintética" value="SYNTHETIC_PRIVATE_FIELD"><input id="card" aria-label="Pagamento sintético" autocomplete="cc-number"><form action="/submit" method="POST"><button id="send" type="submit">Enviar sintético</button></form></section>
    <button id="popup" type="button" onclick="window.open('/next','_blank')">Nova janela</button><a id="download" href="/download" download>Baixar sintético</a><input type="file" aria-label="Arquivo sintético"><input aria-label="Campo bloqueado" disabled><p style="display:none">SYNTHETIC_HIDDEN_CONTENT</p>
    <iframe title="Frame remoto" src="/frame"></iframe><div style="height:1100px;background:linear-gradient(#fff,#eff4e9);margin-top:20px">Área para rolagem</div>
    <script>window.securityProbe = {node:typeof process,require:typeof require,bridge:typeof window.stag};</script></body></html>`);
  });
  const sockets = new Set();
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (request.url !== "/ws" || typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => socket.end());
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    effects,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";

// Synthetic-only provider: never forwards traffic, loads credentials or calls an external service.
export async function apiProvider() {
  const state = {
    requests: [],
    tokens: 0,
    refreshes: 0,
    authorizations: [],
    expiresIn: 3600,
    tokenStatus: 200,
    slow: 0,
  };
  const codes = new Map();
  const held = new Set();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    for await (const chunk of req) body += chunk;
    state.requests.push({
      path: url.pathname,
      method: req.method,
      authorization: req.headers.authorization,
      body,
    });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/authorize") {
      const code = randomUUID();
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      if (
        redirect.hostname !== "127.0.0.1" ||
        redirect.pathname !== "/oauth/callback" ||
        url.searchParams.get("code_challenge_method") !== "S256"
      ) {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      state.authorizations.push(Object.fromEntries(url.searchParams));
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        redirect: redirect.href,
      });
      redirect.search = new URLSearchParams({
        code,
        state: url.searchParams.get("state"),
      }).toString();
      res.writeHead(302, { Location: redirect.href });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      if (state.tokenStatus !== 200) {
        res.writeHead(state.tokenStatus);
        res.end(
          JSON.stringify({
            error: "synthetic invalid grant",
            access_token: "synthetic-secret-error",
          }),
        );
        return;
      }
      const data = new URLSearchParams(body);
      const grant = data.get("grant_type");
      if (grant === "authorization_code") {
        const code = codes.get(data.get("code"));
        codes.delete(data.get("code"));
        if (
          !code ||
          code.redirect !== data.get("redirect_uri") ||
          code.challenge !==
            createHash("sha256")
              .update(data.get("code_verifier") || "")
              .digest("base64url")
        ) {
          res.writeHead(400);
          res.end('{"error":"pkce"}');
          return;
        }
      } else if (grant === "refresh_token") {
        if (!data.get("refresh_token")?.startsWith("synthetic-refresh-")) {
          res.writeHead(400);
          res.end("{}");
          return;
        }
        state.refreshes++;
      } else if (grant !== "client_credentials") {
        res.writeHead(400);
        res.end("{}");
        return;
      }
      state.tokens++;
      res.end(
        JSON.stringify({
          token_type: "Bearer",
          access_token: `synthetic-access-${state.tokens}`,
          refresh_token: `synthetic-refresh-${state.tokens}`,
          expires_in: state.expiresIn,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/slow") {
      state.slow++;
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    if (url.pathname === "/v1/redirect") {
      res.writeHead(302, { Location: "/outside" });
      res.end();
      return;
    }
    if (url.pathname === "/v1/error") {
      res.writeHead(401);
      res.end('{"access_token":"not-for-the-model","error":"unauthorized"}');
      return;
    }
    if (url.pathname === "/v1/large") {
      res.end(JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) }));
      return;
    }
    if (url.pathname === "/v1/html") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>synthetic login</html>");
      return;
    }
    res.end(
      JSON.stringify({
        ok: true,
        method: req.method,
        received: body || null,
        echo: req.headers.authorization || null,
        nested: { password: "synthetic-not-for-model", access_token: "synthetic-not-for-model" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    state,
    open: async (target) => {
      if (!target.startsWith(url + "/authorize?")) throw new Error("Synthetic provider only");
      const response = await fetch(target, { redirect: "manual" });
      if (response.status !== 302) throw new Error("Synthetic login failed");
      const callback = new URL(response.headers.get("location"));
      if (callback.hostname !== "127.0.0.1") throw new Error("Synthetic callback only");
      await fetch(callback);
    },
    release: () => {
      for (const res of held) res.end('{"ok":true}');
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

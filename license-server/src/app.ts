import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createPublicKey, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import type { Config } from "./config.js";
import { Store, audit, consumeNonce } from "./store.js";
import {
  HttpError,
  fail,
  object,
  string,
  integer,
  uuid,
  sha256,
  randomSecret,
  checkPassword,
  hashPassword,
  constantEqual,
  issueLease,
  keyId,
  validateDeviceRequest,
  RateLimiter,
} from "./security.js";

const files: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { name: "style.css", type: "text/css; charset=utf-8" },
};
const cookieName = (config: Config) =>
  config.secure ? "__Host-stag-license" : "stag-license-local";
function cookie(config: Config, value: string, seconds: number): string {
  return `${cookieName(config)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${config.secure ? "; Secure" : ""}`;
}
function sessionToken(req: IncomingMessage, config: Config): string {
  const value =
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName(config)}=`))
      ?.split("=")[1] || "";
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : "";
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] || ""))
    fail(415, "content_type", "Envie JSON.");
  if (Number(req.headers["content-length"] || 0) > 16384) {
    req.resume();
    fail(413, "body_limit", "Requisição muito grande.");
  }
  const data = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16384) {
        if (!rejected) reject(new HttpError(413, "body_limit", "Requisição muito grande."));
        rejected = true;
        chunks.length = 0;
      } else if (!rejected) chunks.push(chunk);
    });
    req.once("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.once("error", () =>
      reject(new HttpError(400, "invalid_request", "Requisição interrompida.")),
    );
    req.once("aborted", () =>
      reject(new HttpError(400, "invalid_request", "Requisição interrompida.")),
    );
  });
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return fail(400, "invalid_json", "JSON inválido.");
  }
}
function expiresAt(value: unknown): Date {
  const raw = string(value, 20, 30);
  const time = Date.parse(raw);
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(raw) ||
    !Number.isFinite(time) ||
    time <= Date.now() ||
    time > Date.now() + 3650 * 86400_000
  )
    fail(400, "invalid_expiry", "Escolha uma validade futura de até dez anos.");
  return new Date(time);
}
function label(value: unknown): string {
  const v = string(value, 1, 120).trim();
  if (!v) fail(400, "invalid_label", "Informe um nome para a licença.");
  return v;
}
async function lockedLicense(db: PoolClient, id: string) {
  const row = (await db.query("SELECT * FROM licenses WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!row) fail(404, "not_found", "Licença não encontrada.");
  return row;
}
function available(license: { revoked: boolean; expires_at: Date }): void {
  if (license.revoked) fail(403, "revoked", "Esta licença foi revogada.");
  if (license.expires_at.getTime() <= Date.now()) fail(403, "expired", "Esta licença venceu.");
}
function publicLicense(row: Record<string, any>) {
  return {
    id: row.id,
    label: row.label,
    keyHint: row.key_hint,
    expiresAt: row.expires_at,
    maxDevices: row.max_devices,
    status: row.revoked ? "revoked" : row.expires_at.getTime() <= Date.now() ? "expired" : "active",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeDevices: Number(row.active_devices || 0),
  };
}
export async function createApp(
  config: Config,
  store: Store,
  log: (entry: unknown) => void = (entry) => console.log(JSON.stringify(entry)),
) {
  const assets = new Map<string, Buffer>();
  for (const [path, file] of Object.entries(files))
    assets.set(path, await readFile(new URL(`../public/${file.name}`, import.meta.url)));
  const limiter = new RateLimiter();
  async function session(req: IncomingMessage) {
    const token = sessionToken(req, config);
    if (!token) fail(401, "unauthenticated", "Entre para administrar as licenças.");
    const r = await store.pool.query(
      "SELECT s.*,a.username FROM sessions s JOIN admins a ON a.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()",
      [sha256(token)],
    );
    if (!r.rows[0]) fail(401, "unauthenticated", "Sua sessão terminou. Entre novamente.");
    return r.rows[0];
  }
  function origin(req: IncomingMessage): void {
    if (req.headers.origin !== config.origin)
      fail(403, "origin_denied", "Origem da solicitação recusada.");
  }
  const server = createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    let category = "unknown";
    res.setHeader("x-request-id", requestId);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (config.secure) res.setHeader("strict-transport-security", "max-age=31536000");
    res.once("finish", () => {
      // Never record URL, headers, bodies, database errors, labels or credentials.
      if (category !== "health")
        log({
          event: "request",
          requestId,
          category,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        });
    });
    try {
      if ((req.url?.length || 0) > 2048) fail(414, "url_limit", "Endereço muito grande.");
      const url = new URL(req.url || "/", "http://internal.invalid");
      const path = url.pathname;
      const method = req.method || "GET";
      if (path === "/health/live" || path === "/health/ready") {
        category = "health";
        if (method !== "GET") fail(405, "method", "Método não permitido.");
        if (path.endsWith("ready")) await store.pool.query("SELECT 1");
        return reply(res, 200, { status: "ok", service: "stag-plus-licenses", version: "0.1.0" });
      }
      if (req.headers.host !== new URL(config.origin).host)
        fail(403, "host_denied", "Destino da solicitação recusado.");
      const peer = req.socket.remoteAddress || "unknown";
      limiter.check(`requests:${peer}`, 600, 60_000);
      if (method === "GET" && files[path]) {
        category = "panel";
        res.writeHead(200, { "content-type": files[path]!.type });
        return res.end(assets.get(path));
      }
      if (path === "/api/admin/login" && method === "POST") {
        category = "login";
        origin(req);
        limiter.check(`login:${peer}`, 10, 5 * 60_000);
        const b = object(await body(req), ["username", "password"]);
        const username = string(b.username, 3, 80);
        const password = string(b.password, 1, 128);
        const row = (await store.pool.query("SELECT * FROM admins WHERE username=$1", [username]))
          .rows[0];
        // Unknown users still perform the same expensive password derivation.
        const valid = await checkPassword(password, row?.password_hash || config.adminPasswordHash);
        if (!valid || !row) fail(401, "login_failed", "Usuário ou senha inválidos.");
        const token = randomSecret();
        const csrf = randomSecret();
        await store.transaction(async (db) => {
          await db.query("DELETE FROM sessions WHERE admin_id=$1 AND expires_at<=now()", [row.id]);
          await db.query(
            "INSERT INTO sessions(token_hash,admin_id,csrf,expires_at) VALUES($1,$2,$3,now()+interval '8 hours')",
            [sha256(token), row.id, csrf],
          );
          await audit(db, "admin.login");
        });
        res.setHeader("set-cookie", cookie(config, token, 28800));
        return reply(res, 200, { username: row.username, csrf });
      }
      if (path.startsWith("/api/admin/")) {
        category = "admin";
        const s = await session(req);
        if (method !== "GET") {
          origin(req);
          const csrf = req.headers["x-csrf-token"];
          if (typeof csrf !== "string" || !constantEqual(csrf, s.csrf))
            fail(403, "csrf_denied", "Atualize a página e tente novamente.");
        }
        if (path === "/api/admin/session" && method === "GET")
          return reply(res, 200, { username: s.username, csrf: s.csrf });
        if (path === "/api/admin/logout" && method === "POST") {
          object(await body(req), []);
          await store.pool.query("DELETE FROM sessions WHERE token_hash=$1", [s.token_hash]);
          res.setHeader("set-cookie", cookie(config, "", 0));
          return reply(res, 200, { ok: true });
        }
        if (path === "/api/admin/password" && method === "POST") {
          limiter.check(`password:${s.admin_id}`, 5, 5 * 60_000);
          const b = object(await body(req), ["currentPassword", "newPassword"]);
          const current = string(b.currentPassword, 1, 128);
          const next = string(b.newPassword, 12, 128);
          await store.transaction(async (db) => {
            const row = (
              await db.query("SELECT * FROM admins WHERE id=$1 FOR UPDATE", [s.admin_id])
            ).rows[0];
            if (!(await checkPassword(current, row.password_hash)))
              fail(401, "password_failed", "Senha atual inválida.");
            await db.query("UPDATE admins SET password_hash=$1 WHERE id=$2", [
              await hashPassword(next),
              s.admin_id,
            ]);
            await db.query("DELETE FROM sessions WHERE admin_id=$1", [s.admin_id]);
            await audit(db, "admin.password_changed");
          });
          res.setHeader("set-cookie", cookie(config, "", 0));
          return reply(res, 200, { ok: true });
        }
        if (path === "/api/admin/summary" && method === "GET") {
          const counts = (
            await store.pool
              .query(`SELECT count(*)::int total, count(*) FILTER(WHERE NOT revoked AND expires_at>now())::int active,
            count(*) FILTER(WHERE revoked)::int revoked, count(*) FILTER(WHERE NOT revoked AND expires_at<=now())::int expired,
            count(*) FILTER(WHERE NOT revoked AND expires_at>now() AND expires_at<now()+interval '7 days')::int expiring FROM licenses`)
          ).rows[0];
          const devices = (
            await store.pool.query(
              "SELECT count(*)::int count FROM activations a JOIN licenses l ON l.id=a.license_id WHERE NOT a.disabled AND NOT l.revoked AND l.expires_at>now()",
            )
          ).rows[0].count;
          return reply(res, 200, { ...counts, devices, offlineHours: config.offlineHours });
        }
        if (path === "/api/admin/audit" && method === "GET") {
          return reply(res, 200, {
            events: (
              await store.pool.query(
                'SELECT id,action,license_id AS "licenseId",activation_id AS "activationId",created_at AS "createdAt" FROM audit ORDER BY id DESC LIMIT 100',
              )
            ).rows,
          });
        }
        if (path === "/api/admin/licenses" && method === "GET") {
          const search = string(url.searchParams.get("search") || "", 0, 120);
          const page = integer(Number(url.searchParams.get("page") || 1), 1, 100000);
          const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
          const r = await store.pool.query(
            `SELECT l.*, (SELECT count(*) FROM activations a WHERE a.license_id=l.id AND NOT a.disabled) active_devices
            FROM licenses l WHERE label ILIKE $1 ORDER BY created_at DESC,id LIMIT 50 OFFSET $2`,
            [pattern, (page - 1) * 50],
          );
          const count = (
            await store.pool.query(
              "SELECT count(*)::int count FROM licenses WHERE label ILIKE $1",
              [pattern],
            )
          ).rows[0].count;
          return reply(res, 200, {
            licenses: r.rows.map(publicLicense),
            total: count,
            page,
            pageSize: 50,
          });
        }
        if (path === "/api/admin/licenses" && method === "POST") {
          const b = object(await body(req), ["label", "durationDays", "maxDevices"]);
          const name = label(b.label);
          const days = integer(b.durationDays ?? 30, 1, 3650);
          const max = integer(b.maxDevices ?? 1, 1, 100);
          const id = randomUUID();
          const licenseKey = `STAG-${randomSecret()}`;
          const license = await store.transaction(async (db) => {
            const r = await db.query(
              "INSERT INTO licenses(id,label,key_hash,key_hint,expires_at,max_devices) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
              [
                id,
                name,
                sha256(licenseKey),
                licenseKey.slice(-6),
                new Date(Date.now() + days * 86400_000),
                max,
              ],
            );
            await audit(db, "license.created", id);
            return publicLicense(r.rows[0]);
          });
          return reply(res, 201, { license, licenseKey });
        }
        const match = path.match(
          /^\/api\/admin\/licenses\/([^/]+)(?:\/(revoke|restore|rotate|devices)(?:\/([^/]+))?)?$/,
        );
        if (match) {
          const id = uuid(match[1]);
          const action = match[2];
          if (!action && method === "GET") {
            const r = await store.pool.query(
              "SELECT l.*,(SELECT count(*) FROM activations a WHERE a.license_id=l.id AND NOT a.disabled) active_devices FROM licenses l WHERE id=$1",
              [id],
            );
            if (!r.rows[0]) fail(404, "not_found", "Licença não encontrada.");
            const devices = (
              await store.pool.query(
                `SELECT id,device_name AS name,created_at AS \"createdAt\",last_seen_at AS \"lastSeenAt\",disabled
              FROM activations WHERE license_id=$1 ORDER BY disabled,last_seen_at DESC LIMIT 200`,
                [id],
              )
            ).rows;
            return reply(res, 200, { license: publicLicense(r.rows[0]), devices });
          }
          if (!action && method === "PATCH") {
            const b = object(await body(req), ["label", "expiresAt", "maxDevices"]);
            const name = label(b.label);
            const expiry = expiresAt(b.expiresAt);
            const max = integer(b.maxDevices, 1, 100);
            await store.transaction(async (db) => {
              await lockedLicense(db, id);
              const count = (
                await db.query(
                  "SELECT count(*)::int count FROM activations WHERE license_id=$1 AND NOT disabled",
                  [id],
                )
              ).rows[0].count;
              if (count > max)
                fail(409, "device_limit", "Libere computadores antes de reduzir o limite.");
              await db.query(
                "UPDATE licenses SET label=$2,expires_at=$3,max_devices=$4,updated_at=now() WHERE id=$1",
                [id, name, expiry, max],
              );
              await audit(db, "license.updated", id);
            });
            return reply(res, 200, { ok: true });
          }
          if (
            ["revoke", "restore", "rotate"].includes(action || "") &&
            method === "POST" &&
            !match[3]
          ) {
            object(await body(req), []);
            let licenseKey: string | undefined;
            await store.transaction(async (db) => {
              const license = await lockedLicense(db, id);
              if (action === "restore" && license.expires_at.getTime() <= Date.now())
                fail(409, "expired", "Prorrogue a validade antes de reativar.");
              if (action === "rotate") {
                licenseKey = `STAG-${randomSecret()}`;
                await db.query(
                  "UPDATE licenses SET key_hash=$2,key_hint=$3,updated_at=now() WHERE id=$1",
                  [id, sha256(licenseKey), licenseKey.slice(-6)],
                );
                await db.query("UPDATE activations SET disabled=true WHERE license_id=$1", [id]);
              } else
                await db.query("UPDATE licenses SET revoked=$2,updated_at=now() WHERE id=$1", [
                  id,
                  action === "revoke",
                ]);
              await audit(db, `license.${action}`, id);
            });
            return reply(res, 200, { ok: true, ...(licenseKey ? { licenseKey } : {}) });
          }
          if (action === "devices" && match[3] && method === "DELETE") {
            const activationId = uuid(match[3]);
            object(await body(req), []);
            await store.transaction(async (db) => {
              await lockedLicense(db, id);
              const r = await db.query(
                "UPDATE activations SET disabled=true WHERE id=$1 AND license_id=$2 AND NOT disabled RETURNING id",
                [activationId, id],
              );
              if (!r.rowCount) fail(404, "not_found", "Ativação não encontrada ou já liberada.");
              await audit(db, "device.released", id, activationId);
            });
            return reply(res, 200, { ok: true });
          }
        }
      } else if (path.startsWith("/api/v1/")) {
        category = "licensing";
        limiter.check(`licensing:${peer}`, 120, 60_000);
        if (req.headers.origin && req.headers.origin !== config.origin)
          fail(403, "origin_denied", "Origem recusada.");
        if (path === "/api/v1/public-key" && method === "GET") {
          return reply(res, 200, {
            algorithm: "Ed25519",
            keyId: keyId(config.signer),
            publicKey: createPublicKey(config.signer).export({ type: "spki", format: "pem" }),
          });
        }
        const action = path.slice("/api/v1/".length);
        if (["activate", "refresh", "deactivate"].includes(action) && method === "POST") {
          const b = validateDeviceRequest(action, await body(req));
          const result = await store.transaction(async (db) => {
            if (!(await consumeNonce(db, b.nonce, b.deviceHash)))
              fail(
                409,
                "replayed_proof",
                "Solicitação já utilizada; confira o estado antes de tentar novamente.",
              );
            let license;
            let activation;
            let activationToken: string | undefined;
            if (action === "activate") {
              license = (
                await db.query("SELECT * FROM licenses WHERE key_hash=$1 FOR UPDATE", [
                  sha256(b.credential),
                ])
              ).rows[0];
              if (!license) fail(401, "invalid_license", "Código de licença inválido.");
              available(license);
              activation = (
                await db.query("SELECT * FROM activations WHERE license_id=$1 AND device_hash=$2", [
                  license.id,
                  b.deviceHash,
                ])
              ).rows[0];
              if (!activation || activation.disabled) {
                const count = (
                  await db.query(
                    "SELECT count(*)::int count FROM activations WHERE license_id=$1 AND NOT disabled",
                    [license.id],
                  )
                ).rows[0].count;
                if (count >= license.max_devices)
                  fail(
                    409,
                    "device_limit",
                    "Limite de computadores atingido. Peça ao administrador para liberar a troca.",
                  );
              }
              activationToken = randomSecret();
              activation = (
                await db.query(
                  `INSERT INTO activations(id,license_id,device_hash,device_name,token_hash) VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(license_id,device_hash) DO UPDATE SET token_hash=excluded.token_hash,device_name=excluded.device_name,disabled=false,last_seen_at=now() RETURNING *`,
                  [randomUUID(), license.id, b.deviceHash, b.deviceName, sha256(activationToken)],
                )
              ).rows[0];
            } else {
              const found = (
                await db.query("SELECT license_id FROM activations WHERE token_hash=$1", [
                  sha256(b.credential),
                ])
              ).rows[0];
              if (!found) fail(401, "invalid_activation", "Ativação inválida.");
              license = await lockedLicense(db, found.license_id);
              activation = (
                await db.query(
                  "SELECT * FROM activations WHERE token_hash=$1 AND license_id=$2 AND device_hash=$3 AND NOT disabled FOR UPDATE",
                  [sha256(b.credential), license.id, b.deviceHash],
                )
              ).rows[0];
              if (!activation) fail(401, "invalid_activation", "Ativação inválida ou liberada.");
              if (action !== "deactivate") available(license);
              await db.query("UPDATE activations SET last_seen_at=now(),disabled=$2 WHERE id=$1", [
                activation.id,
                action === "deactivate",
              ]);
            }
            await audit(db, `device.${action}`, license.id, activation.id);
            if (action === "deactivate") return { ok: true };
            const now = Date.now();
            const lease = issueLease(config.signer, {
              v: 1,
              aud: "stag-plus",
              licenseId: license.id,
              activationId: activation.id,
              deviceHash: b.deviceHash,
              issuedAt: now,
              expiresAt: Math.min(
                now + config.offlineHours * 3600_000,
                license.expires_at.getTime(),
              ),
              licenseExpiresAt: license.expires_at.getTime(),
            });
            return {
              lease,
              ...(activationToken ? { activationToken } : {}),
              refreshAfterSeconds: Math.min(
                3600,
                Math.max(
                  1,
                  Math.floor(
                    (Math.min(now + config.offlineHours * 3600_000, license.expires_at.getTime()) -
                      now) /
                      2000,
                  ),
                ),
              ),
            };
          });
          return reply(res, 200, result);
        }
      }
      fail(404, "not_found", "Recurso não encontrado.");
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const known = error instanceof HttpError;
      const status = known ? error.status : 503;
      if (status === 429) res.setHeader("retry-after", "300");
      reply(res, status, {
        error: {
          code: known ? error.code : "service_unavailable",
          message: known ? error.message : "Serviço temporariamente indisponível. Tente novamente.",
          requestId,
        },
      });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  return server;
}

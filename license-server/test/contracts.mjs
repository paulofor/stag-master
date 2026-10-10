import assert from "node:assert/strict";
import { createDevice, deviceRequest, validateAuthorization } from "../client/client.mjs";
import { randomSecret } from "../dist/security.js";

export class Api {
  constructor(origin, password) {
    this.origin = origin;
    this.password = password;
    this.cookie = "";
    this.csrf = "";
    this.sensitive = [password];
  }
  async request(path, method = "GET", data, expected = 200, headers = {}) {
    const admin = path.startsWith("/api/admin/");
    const res = await fetch(this.origin + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "content-type": "application/json",
        ...(admin ? { origin: this.origin, cookie: this.cookie, "x-csrf-token": this.csrf } : {}),
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.equal(res.status, expected, `status da operação ${method} ${path.split("?")[0]}`);
    const value = await res.json();
    return { value, res };
  }
  async login(password = this.password) {
    const r = await this.request("/api/admin/login", "POST", { username: "admin", password });
    this.cookie = r.res.headers.get("set-cookie").split(";")[0];
    this.csrf = r.value.csrf;
    this.sensitive.push(this.cookie.split("=")[1], this.csrf);
    return r;
  }
  async create(label, maxDevices = 1) {
    const r = await this.request(
      "/api/admin/licenses",
      "POST",
      { label, durationDays: 30, maxDevices },
      201,
    );
    this.sensitive.push(r.value.licenseKey);
    return r.value;
  }
  async device(action, credential, device, name = "Synthetic device", expected = 200) {
    const r = await this.request(
      `/api/v1/${action}`,
      "POST",
      deviceRequest(action, credential, device, name),
      expected,
    );
    if (r.value.activationToken) this.sensitive.push(r.value.activationToken);
    return r.value;
  }
}
export async function apiContracts(origin, password, publicKey, sql) {
  const api = new Api(origin, password);
  await api.request("/health/live");
  await api.request("/health/ready");
  await api.request("/api/admin/licenses", "GET", undefined, 401);
  await api.request(
    "/api/admin/login",
    "POST",
    { username: "admin", password: "wrong-synthetic" },
    401,
  );
  await api.request("/api/admin/login", "POST", { username: "admin", password }, 403, {
    origin: "https://hostile.invalid",
  });
  const login = await api.login();
  assert.ok(login.res.headers.get("set-cookie").includes("HttpOnly"));
  assert.ok(login.res.headers.get("set-cookie").includes("SameSite=Strict"));
  assert.ok(
    !login.res.headers.get("set-cookie").includes("Secure"),
    "somente o perfil loopback pode usar cookie sem Secure",
  );
  assert.match(login.res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  for (const data of [
    { label: "invalid", maxDevices: 0 },
    { label: "invalid", durationDays: 0 },
    { label: "invalid", maxDevices: 101 },
    { label: "invalid", extra: "unrecognized" },
  ])
    await api.request("/api/admin/licenses", "POST", data, 400);
  await api.request("/api/admin/licenses", "POST", { label: "CSRF denied" }, 403, {
    "x-csrf-token": "invalid",
  });
  await api.request("/api/admin/licenses", "POST", { label: "Origin denied" }, 403, {
    origin: "https://hostile.invalid",
  });
  await api.request("/api/admin/licenses", "POST", { label: "x".repeat(17000) }, 413);
  const invalid = await fetch(origin + "/api/admin/licenses", {
    method: "POST",
    headers: {
      origin,
      cookie: api.cookie,
      "x-csrf-token": api.csrf,
      "content-type": "application/json",
    },
    body: "{invalid",
  });
  assert.equal(invalid.status, 400);
  console.log("Licenças: autenticação, origem, CSRF e validações HTTP aprovadas.");

  const first = await api.create("Synthetic beta A");
  const second = await api.create("Synthetic beta B");
  const a = createDevice();
  const b = createDevice();
  const proofs = [
    deviceRequest("activate", first.licenseKey, a, "Machine A"),
    deviceRequest("activate", first.licenseKey, b, "Machine B"),
  ];
  const races = await Promise.all(
    proofs.map(async (p) => {
      const res = await fetch(origin + "/api/v1/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(p),
      });
      return { status: res.status, value: await res.json() };
    }),
  );
  assert.deepEqual(races.map((r) => r.status).sort(), [200, 409], "limite deve ser atômico");
  const winner = races[0].status === 200 ? 0 : 1;
  const device = winner === 0 ? a : b;
  const loser = winner === 0 ? b : a;
  const activation = races[winner].value;
  api.sensitive.push(activation.activationToken);
  const lease = validateAuthorization(activation.lease, publicKey, device);
  assert.ok(lease.expiresAt <= lease.licenseExpiresAt);
  assert.ok(lease.expiresAt - lease.issuedAt <= 48 * 3600_000);
  await api.request("/api/v1/activate", "POST", proofs[winner], 409);
  const tampered = deviceRequest("refresh", activation.activationToken, device);
  tampered.deviceName = "Tampered";
  await api.request("/api/v1/refresh", "POST", tampered, 401);
  await api.device("refresh", activation.activationToken, loser, "Wrong device", 401);
  await api.device("refresh", activation.activationToken, device);
  await api.device("activate", first.licenseKey, loser, "No slot", 409);
  const detail = (await api.request(`/api/admin/licenses/${first.license.id}`)).value;
  assert.equal(detail.license.activeDevices, 1);
  assert.ok(!JSON.stringify(detail).includes(first.licenseKey));
  assert.ok(!JSON.stringify(detail).includes(activation.activationToken));
  await api.request(
    `/api/admin/licenses/${second.license.id}/devices/${lease.activationId}`,
    "DELETE",
    {},
    404,
  );
  await api.request(`/api/admin/licenses/${first.license.id}/revoke`, "POST", {});
  await api.device("refresh", activation.activationToken, device, "Machine", 403);
  await api.device("activate", first.licenseKey, device, "Machine", 403);
  assert.ok(
    validateAuthorization(activation.lease, publicKey, device),
    "autorização anterior permanece válida até seu prazo offline",
  );
  await api.request(`/api/admin/licenses/${first.license.id}/restore`, "POST", {});
  await api.device("refresh", activation.activationToken, device);
  await api.request(
    `/api/admin/licenses/${first.license.id}/devices/${lease.activationId}`,
    "DELETE",
    {},
  );
  await api.device("refresh", activation.activationToken, device, "Released", 401);
  const moved = await api.device("activate", first.licenseKey, loser, "Replacement");
  await api.device("deactivate", moved.activationToken, loser);
  await api.device("refresh", moved.activationToken, loser, "Disabled", 401);
  const rotated = (await api.request(`/api/admin/licenses/${first.license.id}/rotate`, "POST", {}))
    .value.licenseKey;
  api.sensitive.push(rotated);
  await api.device("activate", first.licenseKey, device, "Old code", 401);
  await api.device("activate", rotated, device, "New code");
  console.log(
    "Licenças: concorrência, prova de instalação, assinatura, revogação, liberação e rotação aprovadas.",
  );

  const multi = await api.create("Synthetic two devices", 2);
  const one = await api.device("activate", multi.licenseKey, createDevice());
  await api.device("activate", multi.licenseKey, createDevice());
  await api.request(
    `/api/admin/licenses/${multi.license.id}`,
    "PATCH",
    {
      label: "Keep full flow",
      maxDevices: 1,
      expiresAt: new Date(Date.now() + 60 * 86400_000).toISOString(),
    },
    409,
  );
  await sql(
    `UPDATE licenses SET expires_at=now()-interval '1 hour' WHERE id='${second.license.id}'`,
  );
  await api.device("activate", second.licenseKey, createDevice(), "Expired", 403);
  await api.request(`/api/admin/licenses/${second.license.id}/revoke`, "POST", {});
  await api.request(`/api/admin/licenses/${second.license.id}/restore`, "POST", {}, 409);
  await api.request(`/api/admin/licenses/${second.license.id}`, "PATCH", {
    label: "Synthetic beta B",
    maxDevices: 1,
    expiresAt: new Date(Date.now() + 10 * 86400_000).toISOString(),
  });
  await api.request(`/api/admin/licenses/${second.license.id}/restore`, "POST", {});
  const short = await api.create("Synthetic expiry boundary");
  await sql(
    `UPDATE licenses SET expires_at=now()+interval '1 hour' WHERE id='${short.license.id}'`,
  );
  const shortDevice = createDevice();
  const limited = validateAuthorization(
    (await api.device("activate", short.licenseKey, shortDevice)).lease,
    publicKey,
    shortDevice,
  );
  assert.ok(
    limited.expiresAt === limited.licenseExpiresAt,
    "offline deve respeitar vencimento da licença",
  );
  await api.request(
    `/api/admin/licenses/${short.license.id}`,
    "PATCH",
    { label: "Invalid past", maxDevices: 1, expiresAt: new Date(Date.now() - 1000).toISOString() },
    400,
  );
  const audit = (await api.request("/api/admin/audit")).value;
  assert.ok(audit.events.some((e) => e.action === "device.activate"));
  for (const secret of api.sensitive)
    assert.ok(!JSON.stringify(audit).includes(secret), "auditoria não pode conter segredos");
  const summary = (await api.request("/api/admin/summary")).value;
  assert.equal(summary.total, 4);
  assert.equal(summary.offlineHours, 48);
  assert.ok(summary.devices >= 3);
  console.log("Licenças: expiração, atualização, segregação e auditoria aprovadas.");
  return {
    api,
    firstId: first.license.id,
    multiId: multi.license.id,
    activationId: JSON.parse(Buffer.from(one.lease.payload, "base64url").toString()).activationId,
  };
}

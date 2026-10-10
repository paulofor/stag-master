import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  scrypt,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const randomSecret = () => randomBytes(32).toString("base64url");
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}
export function object(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !allowed.includes(k))
  )
    fail(400, "invalid_fields", "Campos inválidos ou desconhecidos.");
  return value as Record<string, unknown>;
}
export function string(value: unknown, min: number, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(400, "invalid_field", "Confira os campos informados.");
  return value;
}
export function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    fail(400, "invalid_number", "Valor numérico fora do limite.");
  return value as number;
}
export function uuid(value: unknown): string {
  const result = string(value, 36, 36);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(result))
    fail(400, "invalid_id", "Identificador inválido.");
  return result;
}
export function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function hashPassword(password: string): Promise<string> {
  string(password, 12, 128);
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt:${salt}:${hash.toString("hex")}`;
}
export function validPasswordHash(value: string): boolean {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(value);
}
export async function checkPassword(password: string, value: string): Promise<boolean> {
  if (!validPasswordHash(value)) return false;
  const [, salt, expected] = value.split(":");
  const hash = await derive(password, salt!);
  return constantEqual(hash.toString("hex"), expected!);
}
export function privateSigner(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("A chave de emissão deve ser Ed25519.");
  return key;
}
export function keyId(key: KeyObject): string {
  return sha256(createPublicKey(key).export({ type: "spki", format: "der" }) as Buffer).slice(
    0,
    24,
  );
}
export type Lease = {
  v: 1;
  aud: "stag-plus";
  licenseId: string;
  activationId: string;
  deviceHash: string;
  issuedAt: number;
  expiresAt: number;
  licenseExpiresAt: number;
};
export type SignedLease = { keyId: string; payload: string; signature: string };
export function issueLease(key: KeyObject, lease: Lease): SignedLease {
  const payload = Buffer.from(JSON.stringify(lease)).toString("base64url");
  return {
    keyId: keyId(key),
    payload,
    signature: sign(null, Buffer.from(`STAG-PLUS-LEASE-V1.${payload}`), key).toString("base64url"),
  };
}
// The public key must come from trusted application configuration, never only from the response.
export function verifyLease(
  signed: SignedLease,
  publicKey: string | KeyObject,
  deviceHash: string,
  now = Date.now(),
): Lease {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  if (
    key.asymmetricKeyType !== "ed25519" ||
    typeof signed?.payload !== "string" ||
    signed.payload.length > 4096 ||
    typeof signed.signature !== "string" ||
    signed.signature.length > 100 ||
    signed.keyId !== sha256(key.export({ type: "spki", format: "der" }) as Buffer).slice(0, 24) ||
    !verify(
      null,
      Buffer.from(`STAG-PLUS-LEASE-V1.${signed.payload}`),
      key,
      Buffer.from(signed.signature, "base64url"),
    )
  )
    fail(401, "invalid_lease", "Autorização inválida.");
  let lease: Lease;
  try {
    lease = JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8"));
  } catch {
    return fail(401, "invalid_lease", "Autorização inválida.");
  }
  if (
    lease.v !== 1 ||
    lease.aud !== "stag-plus" ||
    lease.deviceHash !== deviceHash ||
    !Number.isSafeInteger(lease.issuedAt) ||
    !Number.isSafeInteger(lease.expiresAt) ||
    !Number.isSafeInteger(lease.licenseExpiresAt) ||
    lease.issuedAt > now + 60_000 ||
    lease.expiresAt <= now ||
    lease.expiresAt <= lease.issuedAt ||
    lease.expiresAt > lease.licenseExpiresAt ||
    lease.expiresAt - lease.issuedAt > 48 * 3600_000
  )
    fail(401, "invalid_lease", "Autorização vencida ou incompatível com o dispositivo.");
  return lease;
}
export type DeviceRequest = {
  credential: string;
  publicKey: string;
  deviceName: string;
  nonce: string;
  issuedAt: number;
  signature: string;
};
export function proofMessage(action: string, body: Omit<DeviceRequest, "signature">): string {
  return JSON.stringify([
    "stag-plus-device-v1",
    action,
    sha256(body.credential),
    body.publicKey,
    body.deviceName,
    body.nonce,
    body.issuedAt,
  ]);
}
export function validateDeviceRequest(
  action: string,
  input: unknown,
  now = Date.now(),
): DeviceRequest & { deviceHash: string } {
  const b = object(input, [
    "credential",
    "publicKey",
    "deviceName",
    "nonce",
    "issuedAt",
    "signature",
  ]);
  const body: DeviceRequest = {
    credential: string(b.credential, 32, 80),
    publicKey: string(b.publicKey, 59, 59),
    deviceName: string(b.deviceName, 1, 80).trim(),
    nonce: uuid(b.nonce),
    issuedAt: integer(b.issuedAt, 0, Number.MAX_SAFE_INTEGER),
    signature: string(b.signature, 86, 86),
  };
  if (
    !body.deviceName ||
    !/^[A-Za-z0-9_-]+$/.test(body.publicKey) ||
    !/^[A-Za-z0-9_-]+$/.test(body.signature) ||
    Math.abs(now - body.issuedAt) > 5 * 60_000
  )
    fail(401, "invalid_proof", "Prova de dispositivo inválida ou antiga.");
  try {
    const key = createPublicKey({
      key: Buffer.from(body.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(proofMessage(action, body)),
        key,
        Buffer.from(body.signature, "base64url"),
      )
    )
      fail(401, "invalid_proof", "Prova de dispositivo inválida.");
  } catch {
    fail(401, "invalid_proof", "Prova de dispositivo inválida.");
  }
  return { ...body, deviceHash: sha256(Buffer.from(body.publicKey, "base64url")) };
}
export class RateLimiter {
  private entries = new Map<string, { count: number; until: number }>();
  check(key: string, limit: number, windowMs: number, now = Date.now()): void {
    for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 10_000)
        fail(429, "rate_limit", "Muitas tentativas. Aguarde alguns minutos.");
      entry = { count: 0, until: now + windowMs };
      this.entries.set(key, entry);
    }
    if (++entry.count > limit)
      fail(429, "rate_limit", "Muitas tentativas. Aguarde alguns minutos.");
  }
}

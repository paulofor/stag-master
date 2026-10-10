import { createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { proofMessage, sha256, verifyLease } from "../dist/security.js";
import { publicOrigin } from "../dist/config.js";

// Reference client for the future desktop integration. Keys/tokens belong in OS-protected storage.
export function createDevice() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const encoded = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  return { privateKey, publicKey: encoded, deviceHash: sha256(Buffer.from(encoded, "base64url")) };
}
export function deviceRequest(
  action,
  credential,
  device,
  deviceName = "Computador",
  now = Date.now(),
) {
  const body = {
    credential,
    publicKey: device.publicKey,
    deviceName,
    nonce: randomUUID(),
    issuedAt: now,
  };
  return {
    ...body,
    signature: sign(null, Buffer.from(proofMessage(action, body)), device.privateKey).toString(
      "base64url",
    ),
  };
}
export function validateAuthorization(lease, trustedPublicKey, device, now = Date.now()) {
  return verifyLease(lease, createPublicKey(trustedPublicKey), device.deviceHash, now);
}
export async function requestLicense(baseUrl, action, credential, device, deviceName) {
  if (!["activate", "refresh", "deactivate"].includes(action))
    throw new Error("Operação inválida.");
  const origin = publicOrigin(baseUrl).origin;
  // No redirects or automatic retries: an uncertain activation must be reconciled explicitly.
  const response = await fetch(`${origin}/api/v1/${action}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(deviceRequest(action, credential, device, deviceName)),
  });
  if (!response.ok) throw new Error(`Serviço de licenças recusou a operação (${response.status}).`);
  return response.json();
}

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BrowserCertificates } from "../../src/main/browser-certificates";
import { actionSchema } from "../../src/shared/validation";
import {
  browserArguments,
  browserCertificateInstructions,
  browserTool,
} from "../../src/main/browser-tools";

const pem = readFileSync("tests/fixtures/tls/loopback-cert.pem", "utf8");
const rotated = readFileSync("tests/fixtures/tls/loopback-rotated-cert.pem", "utf8");
const url = "https://localhost:5443/private?synthetic=DO_NOT_ECHO";
const error = "net::ERR_CERT_AUTHORITY_INVALID";

describe("exceção manual de certificado do navegador", () => {
  it("vincula origem, porta, certificado e erro sem expor caminho/query no card", () => {
    const policy = new BrowserCertificates();
    expect(policy.inspect(url, error, pem, true)).toBe(false);
    const pending = policy.snapshot()!;
    expect(pending.origin).toBe("https://localhost:5443");
    expect(pending.fingerprint).toMatch(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    expect(JSON.stringify(pending)).not.toMatch(/private|DO_NOT_ECHO/);
    expect(policy.accept(pending.id)).toBe(url);
    expect(policy.inspect("https://localhost:5443/assets", error, pem, false)).toBe(true);
    expect(policy.inspect("https://localhost:5444/", error, pem, false)).toBe(false);
    expect(policy.inspect("https://other.invalid:5443/", error, pem, false)).toBe(false);
    expect(policy.inspect(url, error, rotated, false)).toBe(false);
    expect(policy.inspect(url, "net::ERR_CERT_REVOKED", pem, true)).toBe(false);
    expect(policy.inspect(url, "net::ERR_CERT_DATE_INVALID", pem, false)).toBe(false);
    expect(policy.warning(url)).toBe("https://localhost:5443");
    expect(policy.warning("https://other.invalid/")).toBeUndefined();
    expect(new BrowserCertificates().inspect(url, error, pem, true)).toBe(false);
  });
  it.each([
    "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_CERT_DATE_INVALID",
    "net::ERR_CERT_COMMON_NAME_INVALID",
  ])("aceita somente a confirmação atual para %s", (code) => {
    const policy = new BrowserCertificates();
    policy.inspect(url, code, pem, true);
    const previous = policy.snapshot()!.id;
    policy.inspect(url, code, rotated, true);
    expect(() => policy.accept(previous)).toThrow("mudou");
    policy.accept(policy.snapshot()!.id);
    expect(policy.inspect(url, code, pem, false)).toBe(false);
    expect(policy.inspect(url, code, rotated, false)).toBe(true);
  });
  it("não cria exceção para subframes, erros desconhecidos ou dados malformados", () => {
    const policy = new BrowserCertificates();
    for (const [target, code, cert, main] of [
      [url, error, pem, false],
      [url, "net::ERR_CERT_REVOKED", pem, true],
      [url, "net::ERR_CERT_INVALID", pem, true],
      [url, error, "INVALID", true],
      ["http://localhost/", error, pem, true],
      ["https://user:password@localhost/", error, pem, true],
      ["file:///private", error, pem, true],
    ] as const) {
      expect(policy.inspect(target, code, cert, main)).toBe(false);
      expect(policy.snapshot()).toBeUndefined();
    }
    expect(() => policy.accept("forged")).toThrow("mudou");
  });
  it("limita exceções e permite renovar o certificado de uma origem existente", () => {
    const policy = new BrowserCertificates();
    for (let port = 5000; port < 5020; port++) {
      policy.inspect(`https://localhost:${port}/`, error, pem, true);
      policy.accept(policy.snapshot()!.id);
    }
    policy.inspect(url, error, pem, true);
    expect(() => policy.accept(policy.snapshot()!.id)).toThrow("Limite");
    policy.inspect("https://localhost:5000/", error, rotated, true);
    expect(() => policy.accept(policy.snapshot()!.id)).not.toThrow();
  });
  it("expõe somente id/aba no IPC, sem permitir ao modelo conceder confiança", () => {
    const control = {
      action: "trustCertificate",
      certificateId: "00000000-0000-4000-8000-000000000001",
      tab: "system",
    };
    expect(actionSchema.safeParse({ type: "browserControl", control }).success).toBe(true);
    for (const extra of [{ url }, { fingerprint: "fake" }, { approved: true }])
      expect(
        actionSchema.safeParse({ type: "browserControl", control: { ...control, ...extra } })
          .success,
      ).toBe(false);
    expect(
      actionSchema.safeParse({ type: "browserControl", control: { ...control, tab: undefined } })
        .success,
    ).toBe(false);
    expect(browserArguments.safeParse(control).success).toBe(false);
    expect(browserTool.description).toContain(browserCertificateInstructions);
    expect(browserCertificateInstructions).toContain("só a interface");
    expect(browserCertificateInstructions).toContain("Fechar/revogar/trocar conversa");
  });
});

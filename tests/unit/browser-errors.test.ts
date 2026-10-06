import { describe, expect, it } from "vitest";
import { browserLoadError } from "../../src/main/browser-errors";

describe("diagnóstico de carregamento do navegador", () => {
  it.each([
    [-202, /ERR_CERT_AUTHORITY_INVALID.*TI.*cadeia.*Windows/],
    [-201, /ERR_CERT_DATE_INVALID.*data.*hora/],
    [-200, /ERR_CERT_COMMON_NAME_INVALID.*nomes/],
    [-206, /ERR_CERT_REVOKED.*bloqueado/],
    [-207, /certificado HTTPS.*cadeia de confiança/],
    [-105, /ERR_NAME_NOT_RESOLVED.*VPN.*DNS/],
    [-106, /ERR_INTERNET_DISCONNECTED/],
    [-3, /interrompida/],
    [-102, /código -102/],
  ])("distingue o código %s sem atribuir toda falha a certificados", (code, expected) => {
    expect(browserLoadError(code)).toMatch(expected);
  });
  it("não reflete dados nativos, URLs ou códigos malformados", () => {
    for (const value of [
      null,
      undefined,
      NaN,
      Infinity,
      -202.5,
      -1000,
      202,
      "ERR_CERT_AUTHORITY_INVALID loading https://example.invalid/SYNTHETIC_PRIVATE",
      { message: "SYNTHETIC_PRIVATE" },
    ]) {
      const message = browserLoadError(value);
      expect(message).toBe(browserLoadError(null));
      expect(message).not.toMatch(/SYNTHETIC_PRIVATE|https?:|NaN|Infinity/);
    }
  });
});

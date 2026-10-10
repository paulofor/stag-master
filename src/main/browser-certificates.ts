import { randomUUID, X509Certificate } from "node:crypto";
import { browserUrl } from "./browser-tools";
import type { BrowserCertificateInfo } from "../shared/types";

const overridable = new Set([
  "net::ERR_CERT_AUTHORITY_INVALID",
  "net::ERR_CERT_DATE_INVALID",
  "net::ERR_CERT_COMMON_NAME_INVALID",
]);

// Owned by one WebContents lifetime. No trust store, settings or public tool can write grants.
export class BrowserCertificates {
  pending: (BrowserCertificateInfo & { url: string }) | null = null;
  private grants = new Map<string, string>();

  inspect(url: string, error: string, pem: string, mainFrame: boolean): boolean {
    try {
      const parsed = new URL(browserUrl(url));
      if (parsed.protocol !== "https:" || !overridable.has(error)) return false;
      const fingerprint = new X509Certificate(pem).fingerprint256;
      const identity = `${fingerprint}|${error}`;
      if (this.grants.get(parsed.origin) === identity) return true;
      if (mainFrame) {
        this.pending = { id: randomUUID(), origin: parsed.origin, fingerprint, error, url };
      }
    } catch {
      // Malformed certificate/URL remains blocked, without reflecting native payloads.
    }
    return false;
  }

  challenge(id: string) {
    if (!this.pending || this.pending.id !== id)
      throw new Error("O certificado ou a página mudou. Abra o endereço novamente.");
    return this.pending;
  }

  accept(id: string): string {
    const pending = this.challenge(id);
    if (this.grants.size >= 20 && !this.grants.has(pending.origin))
      throw new Error(
        "Limite de exceções nesta aba. Encerre o acesso não seguro antes de continuar.",
      );
    this.grants.set(pending.origin, `${pending.fingerprint}|${pending.error}`);
    this.pending = null;
    return pending.url;
  }

  warning(url: string): string | undefined {
    try {
      const origin = new URL(url).origin;
      return this.grants.has(origin) ? origin : undefined;
    } catch {
      return undefined;
    }
  }

  snapshot(): BrowserCertificateInfo | undefined {
    if (!this.pending) return undefined;
    const { id, origin, fingerprint, error } = this.pending;
    return { id, origin, fingerprint, error };
  }
}

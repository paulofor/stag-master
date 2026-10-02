import { describe, expect, it } from "vitest";
import { assistantInstructions } from "../../src/main/policy";
import { browserTool } from "../../src/main/browser-tools";
import { desktopTool } from "../../src/main/desktop-tools";

describe("contrato de navegação do agente", () => {
  it("exige navegador integrado em todos os modos, plataformas e estados de consentimento", () => {
    for (const mode of ["read", "project", "windows"] as const)
      for (const platform of ["win32", "linux"])
        for (const [authorized, available] of [
          [false, false],
          [false, true],
          [true, true],
        ]) {
          const instructions = assistantInstructions(mode, platform, authorized, available);
          expect(instructions).toContain("use exclusivamente stag_browser");
          expect(instructions).toContain("localhost/127.0.0.1");
          expect(instructions).toContain("Não abra nem controle Chrome, Edge, Firefox");
          expect(instructions).toContain("A autorização do desktop não autoriza o navegador");
          expect(instructions).toContain("Mostrar navegador");
          if (!available) expect(instructions).toContain("stag_browser não está registrado");
          else if (authorized) expect(instructions).toContain("O cliente autorizou stag_browser");
          else expect(instructions).toContain("o cliente precisa clicar em Autorizar navegador");
        }
  });
  it("orienta as duas ferramentas sobre páginas locais, consentimento e fallback externo", () => {
    expect(desktopTool.description).toContain("use exclusivamente stag_browser");
    expect(desktopTool.description).toContain("localhost");
    expect(desktopTool.description).toContain("Não use esta ferramenta para abrir/controlar");
    expect(browserTool.description).toContain("Ferramenta obrigatória");
    expect(browserTool.description).toContain("localhost/127.0.0.1");
    expect(browserTool.description).toContain("peça esse botão ao cliente e aguarde");
    expect(browserTool.description).toContain("ação manual do cliente, sem fallback");
  });
});

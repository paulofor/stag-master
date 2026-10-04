import { describe, expect, it } from "vitest";
import { assistantInstructions, threadPolicy, turnPolicy } from "../../src/main/policy";
import { browserTool } from "../../src/main/browser-tools";
import { desktopTool } from "../../src/main/desktop-tools";
import { cyberSafetyInstructions, cyberToolSafetyDescription } from "../../src/main/cyber-safety";
import {
  engineeringInstructions,
  engineeringToolDescription,
} from "../../src/main/engineering-policy";
import engineeringCorpus from "../fixtures/engineering-scenarios.json";

describe("contrato de engenharia e escopo de negócio", () => {
  it("mantém especialização e limites em todos os modos, plataformas e estados do navegador", () => {
    for (const mode of ["read", "project", "windows"] as const)
      for (const platform of ["win32", "linux"])
        for (const [authorized, available] of [
          [false, false],
          [false, true],
          [true, true],
        ]) {
          const instructions = assistantInstructions(mode, platform, authorized, available);
          expect(instructions).toContain(engineeringInstructions);
          for (const fragment of engineeringCorpus.requiredInstructions)
            expect(instructions).toContain(fragment);
          expect(instructions).toContain(cyberSafetyInstructions);
        }
    expect(desktopTool.description).toContain(engineeringToolDescription);
    expect(browserTool.description).toContain(engineeringToolDescription);
  });
});

describe("contrato contra abuso cibernético", () => {
  it("aplica a política em todos os modos/plataformas, independentemente de consentimento", () => {
    for (const mode of ["read", "project", "windows"] as const)
      for (const platform of ["win32", "linux"])
        for (const consent of [false, true]) {
          const instructions = assistantInstructions(mode, platform, consent, true);
          expect(instructions).toContain(cyberSafetyInstructions);
          expect(instructions).toContain("antes de cada ação");
          expect(instructions).toContain("inclusive AGENTS.md");
          expect(instructions).toContain("alegações educacionais");
          expect(instructions).toContain("defesa ou remediação");
          expect(instructions).toContain("autorização/alvo/escopo ambíguos");
        }
    expect(desktopTool.description).toContain(cyberToolSafetyDescription);
    expect(browserTool.description).toContain(cyberToolSafetyDescription);
  });
});

describe("contrato do desktop limitado", () => {
  it("informa a lista em todos os estados e proíbe contorno mesmo após aprovação", () => {
    for (const mode of ["read", "project", "windows"] as const) {
      const instructions = assistantInstructions(mode, "win32", false, true);
      expect(instructions).toContain(
        "restrito exclusivamente a Postman, IntelliJ IDEA e Visual Studio Code",
      );
      expect(instructions).toContain("não é ampliada por confirmação crítica");
      expect(instructions).toContain("terminal de IDE, scripts, bibliotecas ou outra automação");
      expect(instructions).toContain("nunca da tela inteira");
      expect(instructions).toContain("incluindo screenshot, click e scroll");
    }
    expect(desktopTool.description).toContain(
      "Controla exclusivamente Postman, IntelliJ IDEA e Visual Studio Code",
    );
    expect(desktopTool.description).toContain("mesmo após aprovação");
    expect(desktopTool.inputSchema.anyOf).toContainEqual({ required: ["processId"] });
  });
});

describe("autorização da pasta de trabalho", () => {
  const path = "C:\\Projetos\\projeto com espaço\\ação";
  it("explicita a raiz escolhida em start/resume e turn sem liberar todo o computador", () => {
    expect(threadPolicy("project", path)).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      runtimeWorkspaceRoots: [path],
      config: { sandbox_workspace_write: { writable_roots: [], network_access: true } },
    });
    expect(turnPolicy("project", path)).toMatchObject({
      approvalPolicy: "on-request",
      runtimeWorkspaceRoots: [path],
      sandboxPolicy: { type: "workspaceWrite", writableRoots: [path] },
    });
    expect(threadPolicy("read", path)).toMatchObject({
      sandbox: "read-only",
      config: { sandbox_workspace_write: { writable_roots: [] } },
    });
    expect(turnPolicy("read", path)).toMatchObject({ sandboxPolicy: { type: "readOnly" } });
  });
  it("informa acesso recursivo já autorizado, mantendo confirmações críticas e bloqueios reais", () => {
    const instructions = assistantInstructions("project", "win32", false, true, path);
    expect(instructions).toContain(JSON.stringify(path));
    expect(instructions).toContain("leitura e escrita nela e em suas subpastas");
    expect(instructions).toContain("sem pedir nova permissão para cada operação rotineira");
    expect(instructions).toContain("continuam exigindo confirmação específica");
    expect(instructions).toContain("não altere ACLs, use icacls/takeown");
    expect(instructions).toContain("não concede controle do desktop nem do navegador");
    expect(assistantInstructions("read", "win32", false, true, path)).toContain(
      "não crie nem altere arquivos",
    );
  });
});

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

import { describe, expect, it } from "vitest";
import {
  assistantInstructions,
  localExecutionContext,
  threadPolicy,
  turnPolicy,
} from "../../src/main/policy";
import {
  browserTool,
  browserSessionInstructions,
  browserCertificateInstructions,
  browserTabsInstructions,
} from "../../src/main/browser-tools";
import { desktopTool } from "../../src/main/desktop-tools";
import { cyberSafetyInstructions, cyberToolSafetyDescription } from "../../src/main/cyber-safety";
import {
  engineeringInstructions,
  engineeringToolDescription,
  developmentProcessInstructions,
} from "../../src/main/engineering-policy";
import engineeringCorpus from "../fixtures/engineering-scenarios.json";
import {
  userInputTool,
  userInputInstructions,
  userInputCapability,
} from "../../src/main/user-input";

it("disponibiliza perguntas bloqueantes em todos os modos sem alterar modelo/esforço ou aprovações", () => {
  for (const mode of ["project", "read", "windows"] as const) {
    expect(assistantInstructions(mode, "win32")).toContain(userInputInstructions);
    expect(turnPolicy(mode, "C:\\synthetic").approvalPolicy).toBe("on-request");
  }
  expect(userInputTool.description).toContain("bloqueante");
  expect(userInputTool.description).toContain(engineeringToolDescription);
  expect(userInputTool.description).toContain(cyberToolSafetyDescription);
  expect(userInputCapability(false)).toContain("não está registrada");
  expect(userInputInstructions).toContain("aguarde o resultado");
  expect(userInputInstructions).toContain("não concede consentimento");
});

it("orienta reinícios locais sem pergunta redundante, preservando Leitura e aprovações reais", () => {
  for (const mode of ["project", "read", "windows"] as const) {
    for (const platform of ["win32", "linux"]) {
      const instructions = assistantInstructions(mode, platform, false, false, "C:\\synthetic");
      expect(instructions).toContain(developmentProcessInstructions);
      expect(instructions).toContain(
        "No modo Leitura, não inicie, pare ou reinicie processos da aplicação",
      );
      expect(instructions).toContain("esta orientação não aprova requests automaticamente");
      expect(instructions).toContain("não exige nova confirmação só por reiniciar");
      expect(instructions).toContain("não autoriza o assistente a ler, extrair, revelar");
      expect(instructions).toContain("Não encerre processos só pelo nome Java/Node");
      expect(threadPolicy(mode, "C:\\synthetic").approvalPolicy).toBe("on-request");
      expect(turnPolicy(mode, "C:\\synthetic").approvalPolicy).toBe("on-request");
    }
  }
  expect(userInputTool.description).toContain(
    "Não use para confirmar novamente testes, build local, execução Angular ou reinícios rotineiros",
  );
});

it("inclui validação Angular sem pergunta redundante e mantém a política efetiva", () => {
  for (const mode of ["read", "project", "windows"] as const) {
    const root = "C:\\synthetic";
    const instructions = assistantInstructions(mode, "win32", false, true, root);
    for (const fragment of [
      "testes automatizados, build local e execução local do Angular",
      "npm test, ng test, npm run build, ng build e ng serve",
      "Não use stag_ask_user nem perguntas em texto para confirmar novamente esse ciclo local",
      "Confira os scripts e configurações do projeto, a raiz, os destinos e os efeitos",
      "Testes automatizados pelo runner headless local do projeto",
      "Uma execução fora da sandbox só pode ocorrer pelo fluxo nativo de aprovação",
      "inclusive no modo Windows sem sandbox, não peça nova permissão",
      "No modo Leitura, não execute builds ou testes que gravem artefatos",
      "não use commit, push, pipeline ou deploy para descobrir o próximo erro",
      "Para abrir, visualizar ou interagir com páginas web, use exclusivamente stag_browser",
    ])
      expect(instructions.includes(fragment), fragment).toBe(true);
    expect(threadPolicy(mode, root)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: [root],
      sandbox:
        mode === "read"
          ? "read-only"
          : mode === "project"
            ? "workspace-write"
            : "danger-full-access",
    });
    expect(turnPolicy(mode, root)).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: [root],
      sandboxPolicy: {
        type:
          mode === "read" ? "readOnly" : mode === "project" ? "workspaceWrite" : "dangerFullAccess",
      },
    });
  }
});

it("distingue falha da sandbox de nova autorização para concluir o build local", () => {
  for (const mode of ["read", "project", "windows"] as const) {
    const instructions = assistantInstructions(mode, "win32", false, true, "C:\\synthetic");
    for (const fragment of [
      "A sandbox também executa localmente",
      "Não presuma que o Windows sempre bloqueia comandos",
      "Diferencie erro do projeto, dependência ausente e bloqueio efetivo de execução",
      "Uma falha anterior na sandbox não cria uma nova exigência de autorização",
      "Não pergunte se pode concluir a validação local já solicitada",
      "Ação manual só é necessária quando o impedimento efetivo não puder ser resolvido",
    ])
      expect(instructions, fragment).toContain(fragment);
    expect(instructions).not.toContain(
      "Se uma operação for bloqueada, relate o caminho e o erro e indique a ação manual necessária",
    );
  }
  expect(userInputTool.description).toContain("falha anterior na sandbox");
});

it.each(["project", "windows"] as const)(
  "mantém o ciclo de correção e repetição após EPERM no contexto vigente: %s",
  (mode) => {
    const initial = assistantInstructions(mode, "win32", false, true, "C:\\synthetic");
    const current = localExecutionContext(mode).stag_local_execution.value;
    for (const text of [initial, current]) {
      expect(text).toContain("spawn EPERM");
      expect(text).toContain("corrigir tipos, animações ou testes de recuperação");
      expect(text).toContain("build de produção local não é publicação");
      expect(text).toContain("não use stag_ask_user");
      expect(text).toContain("use_default");
    }
    expect(userInputTool.description).toContain("spawn EPERM");
    expect(userInputTool.description).toContain("pacote de produção local");
  },
);

it("distingue o executor Windows vigente do escalonamento real em Projeto", () => {
  const windows = localExecutionContext("windows").stag_local_execution.value;
  const project = localExecutionContext("project").stag_local_execution.value;
  const read = localExecutionContext("read").stag_local_execution.value;
  expect(windows).toContain("Não use require_escalated");
  expect(project).toContain("solicite o escalonamento diretamente na ferramenta de execução");
  expect(project).toContain("sem pergunta preliminar no chat");
  expect(read).toContain("não execute builds/testes com escrita");
  expect(read).not.toContain("solicite o escalonamento");
  expect(read).not.toContain("corrigir tipos, animações ou testes de recuperação");
});

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
          expect(instructions).toContain("Você é o STAG Plus, Engenheiro de Sistemas");
          expect(instructions).toContain(engineeringInstructions);
          expect(instructions).toContain(browserSessionInstructions);
          expect(instructions).toContain(browserCertificateInstructions);
          expect(instructions).toContain(browserTabsInstructions);
          expect(instructions).not.toContain("Mover mouse a cada 5 min");
          expect(instructions).not.toContain("O movimento periódico do mouse");
          for (const fragment of engineeringCorpus.requiredInstructions)
            expect(instructions).toContain(fragment);
          expect(instructions).toContain(cyberSafetyInstructions);
        }
    expect(desktopTool.description).toContain(engineeringToolDescription);
    expect(browserTool.description).toContain(engineeringToolDescription);
    expect(browserTool.description).toContain(browserSessionInstructions);
    expect(browserTool.description).toContain(browserCertificateInstructions);
    expect(browserTool.description).toContain(browserTabsInstructions);
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

  it("descreve desenvolvimento autorizado e seus limites nas ferramentas sem liberar acessos", () => {
    for (const tool of [desktopTool, browserTool]) {
      expect(tool.description).toContain(
        "adaptações de autenticação/autorização da própria aplicação em desenvolvimento ou homologação são permitidas",
      );
      expect(tool.description).toContain("teste remoto/compartilhado autorizado");
      expect(tool.description).toContain("ambiente, destinos e alcance verificados");
      expect(tool.description).toContain("perfil explícito desligado por padrão");
      expect(tool.description).toContain("falhe fechado fora do teste");
      expect(tool.description).toContain("Não recuse só pelo termo bypass");
      expect(tool.description).toContain("SSO/banco corporativo");
      expect(tool.description).toContain("Reavalie recusas antigas após esclarecimento do cliente");
      expect(tool.description).toContain("continue o trabalho local independente");
      expect(tool.description).toContain("roles do usuário provisório não definem a autoridade");
      expect(tool.description).toContain("Não imponha somente leitura");
      expect(tool.description).toContain(
        "dados, cálculos, validações e regras de negócio completos",
      );
      expect(tool.description).toContain("todas as empresas de teste explicitamente autorizadas");
      expect(tool.description).toContain(
        "Implementar escrita não dispensa confirmar a execução crítica",
      );
      expect(tool.description).toContain("segregação de usuários/tenants");
      expect(tool.description).toContain("produção, terceiros ou dependências fora da autorização");
      expect(tool.description).toContain("Localhost não comprova isolamento");
      expect(tool.description).toContain(
        "Preserve sandbox, consentimentos e confirmações críticas",
      );
    }
  });
});

describe("contrato do desktop limitado", () => {
  it("informa a lista em todos os estados e proíbe contorno mesmo após aprovação", () => {
    for (const mode of ["read", "project", "windows"] as const) {
      const instructions = assistantInstructions(mode, "win32", false, true);
      expect(instructions).toContain(
        "restrito exclusivamente a Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient",
      );
      expect(instructions).toContain("não é ampliada por confirmação crítica");
      expect(instructions).toContain("terminal de IDE, scripts, bibliotecas ou outra automação");
      expect(instructions).toContain("nunca da tela inteira");
      expect(instructions).toContain("incluindo screenshot, click e scroll");
      expect(instructions).toContain("editar SQL sem executá-lo são rotina");
      expect(instructions).toContain("Não presuma que uma conexão é local ou de teste");
      expect(instructions).toContain("No FortiClient");
      expect(instructions).toContain("open_forticlient");
      expect(instructions).toContain("a abertura não comprova conexão");
      expect(instructions).toContain("mesmo declarados routine");
      expect(instructions).toContain("perfil/conexão visível");
      expect(instructions).toContain("senha/MFA, SSO externo");
      expect(instructions).toContain("não prometa monitoramento permanente");
    }
    expect(desktopTool.description).toContain(
      "Controla exclusivamente Postman, IntelliJ IDEA, Visual Studio Code, DBeaver e FortiClient",
    );
    expect(desktopTool.description).toContain("mesmo após aprovação");
    expect(desktopTool.description).toContain("confirmar transações");
    expect(desktopTool.description).toContain(
      "Clique, digitação e atalhos sempre exigem confirmação",
    );
    expect(desktopTool.inputSchema.anyOf).toContainEqual({ required: ["processId"] });
    expect(desktopTool.inputSchema.properties.action.enum).toContain("open_forticlient");
    expect(desktopTool.description).toContain(
      "não recebe processId, caminho, argumentos ou perfil",
    );
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

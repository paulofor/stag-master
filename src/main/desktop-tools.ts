import { cyberToolSafetyDescription } from "./cyber-safety";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { Approval } from "../shared/types";

const executeFile = promisify(execFile);
const targetProcess = z.number().int().positive();
const interactionContext = {
  risk: z.enum(["routine", "critical"]).optional(),
  intent: z.string().trim().min(1).max(500).optional(),
};
export const desktopArguments = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_windows") }).strict(),
  z.object({ action: z.literal("screenshot"), processId: targetProcess }).strict(),
  z.object({ action: z.literal("focus_window"), processId: targetProcess }).strict(),
  z
    .object({
      action: z.literal("send_keys"),
      processId: z.number().int().positive(),
      keys: z.string().min(1).max(2000),
      ...interactionContext,
    })
    .strict(),
  z
    .object({
      action: z.literal("type_text"),
      processId: z.number().int().positive(),
      text: z.string().min(1).max(2000),
      ...interactionContext,
    })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      processId: targetProcess,
      x: z.number().int().min(-30000).max(30000),
      y: z.number().int().min(-30000).max(30000),
      button: z.enum(["left", "right", "middle"]).optional(),
      clicks: z.union([z.literal(1), z.literal(2)]).optional(),
      ...interactionContext,
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
      processId: targetProcess,
      x: z.number().int().min(-30000).max(30000),
      y: z.number().int().min(-30000).max(30000),
      delta: z
        .number()
        .int()
        .min(-1200)
        .max(1200)
        .refine((value) => value !== 0),
    })
    .strict(),
]);
export type DesktopArguments = z.infer<typeof desktopArguments>;
export interface ToolResult {
  contentItems: ({ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string })[];
  success: boolean;
}
export const desktopTool = {
  type: "function",
  name: "windows_desktop",
  description:
    "Controla exclusivamente Postman, IntelliJ IDEA e Visual Studio Code no desktop Windows após autorização da conversa. list_windows mostra somente esses programas, identificados pelo executável, produto e assinatura do fornecedor. Todas as demais ações exigem processId de list_windows, inclusive screenshot/click/scroll. Screenshot captura apenas a janela desse processo; as coordenadas são físicas e devem usar a origem informada na captura. O driver recusa outros processos, sobreposições e atalhos globais, mesmo após aprovação. Envie um atalho por chamada; não use sequências para trocar de aplicativo. Se o programa não aparecer, peça ao cliente para abri-lo manualmente ou verificar sua instalação oficial; não contorne a lista com shell ou outra automação. Para abrir ou interagir com páginas web, inclusive localhost, use exclusivamente stag_browser no painel do STAG. Não use esta ferramenta para abrir/controlar Chrome, Edge, Firefox ou outro navegador externo; sem autorização de stag_browser, peça Autorizar navegador e aguarde. Capturas, foco, rolagem e interações rotineiras não pedem nova aprovação. Em click, type_text e send_keys, sempre informe intent (efeito concreto e alvo) e risk: routine para navegação/edição local reversível, critical para excluir dados, enviar dados ou mensagens a terceiros, publicar/deploy, pagar/comprar, usar credenciais ou alterar segurança/configuração do sistema. A confirmação é por ação crítica, não autoriza outras ações. Contexto ausente, Enter/Delete, atalhos desconhecidos/compostos ou texto com quebra de linha/tabulação também exigem confirmação. Avalie o efeito na tela, não apenas o gesto; nunca marque uma ação crítica como routine nem use outra ferramenta para contornar recusa. Liste janelas antes de focar, digitar ou enviar atalhos. type_text digita texto literal; send_keys usa sintaxe .NET (ex.: ^s para Ctrl+S). Capture antes de clicar/rolar; use coordenadas físicas em pixels. click permite botão esquerdo/direito/meio e clique duplo. scroll usa delta (120 por passo, positivo sobe). Capture novamente para verificar o resultado." +
    cyberToolSafetyDescription,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list_windows",
          "focus_window",
          "send_keys",
          "type_text",
          "click",
          "scroll",
          "screenshot",
        ],
      },
      processId: {
        type: "integer",
        minimum: 1,
        description:
          "Obrigatório em toda ação exceto list_windows. Processo permitido obtido em list_windows; validado novamente antes da execução.",
      },
      keys: { type: "string", description: "Obrigatório para send_keys; sintaxe SendKeys .NET." },
      text: {
        type: "string",
        description: "Obrigatório para type_text; texto literal, sem interpretar atalhos.",
      },
      x: {
        type: "integer",
        minimum: -30000,
        maximum: 30000,
        description: "Obrigatório para click/scroll, coordenada física horizontal.",
      },
      y: {
        type: "integer",
        minimum: -30000,
        maximum: 30000,
        description: "Obrigatório para click/scroll, coordenada física vertical.",
      },
      button: {
        type: "string",
        enum: ["left", "right", "middle"],
        description: "Só em click; padrão left.",
      },
      clicks: { type: "integer", enum: [1, 2], description: "Só em click; padrão 1." },
      delta: {
        type: "integer",
        minimum: -1200,
        maximum: 1200,
        description: "Obrigatório em scroll, não zero. 120 por passo; negativo desce.",
      },
      risk: {
        type: "string",
        enum: ["routine", "critical"],
        description:
          "Em click/type_text/send_keys: routine para navegação/edição local reversível; critical para exclusão, envio externo, publicação, pagamentos, credenciais ou mudanças no sistema. Sem contexto há confirmação.",
      },
      intent: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Em click/type_text/send_keys: efeito concreto esperado e alvo da interação.",
      },
    },
    required: ["action"],
    anyOf: [{ properties: { action: { const: "list_windows" } } }, { required: ["processId"] }],
    additionalProperties: false,
  },
};

/** Coordinates alone cannot establish intent. Legacy or uncertain interactions still ask. */
export function desktopConfirmationReason(input: DesktopArguments): string | null {
  if (input.action !== "click" && input.action !== "type_text" && input.action !== "send_keys")
    return null;
  if (!input.risk || !input.intent)
    return "O efeito desta interação não foi identificado. Confirme antes de executá-la.";
  if (input.risk === "critical")
    return "O agente identificou um efeito crítico. Esta confirmação vale somente para esta ação.";
  if (input.action === "type_text" && /[\r\n\t]/.test(input.text))
    return "O texto inclui Enter ou Tab e pode enviar, executar ou mudar o alvo da interação.";
  // A single navigation/editing shortcut is predictable; submissions and arbitrary sequences are not.
  if (
    input.action === "send_keys" &&
    !/^(?:\^[acsvxyz]|[+^]?\{(?:TAB|ESC|ESCAPE|UP|DOWN|LEFT|RIGHT|HOME|END|PGUP|PGDN)\})$/i.test(
      input.keys,
    )
  )
    return "Este atalho pode confirmar, excluir, executar ou enviar dados; confirme seu efeito.";
  return null;
}

export function desktopApproval(input: DesktopArguments): Pick<Approval, "title" | "detail"> {
  const reason = desktopConfirmationReason(input);
  return {
    title: "Confirmar ação no desktop?",
    detail: [
      reason,
      "intent" in input ? `Intenção: ${input.intent || "não informada"}` : "",
      desktopOperationDetail(input),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

function desktopOperationDetail(input: DesktopArguments): string {
  switch (input.action) {
    case "list_windows":
      return "Listar somente janelas de Postman, IntelliJ IDEA e Visual Studio Code.";
    case "screenshot":
      return `Capturar somente a janela do processo ${input.processId}.`;
    case "focus_window":
      return `Trazer a janela do processo ${input.processId} para frente.`;
    case "send_keys":
      return `Processo: ${input.processId}\nAtalho (SendKeys): ${input.keys}`;
    case "type_text":
      return `Processo: ${input.processId}\nTexto literal:\n${input.text}`;
    case "click":
      return `Processo: ${input.processId}\nPosição física: x=${input.x}, y=${input.y}\nBotão: ${{ left: "esquerdo", right: "direito", middle: "meio" }[input.button || "left"]}\nCliques: ${input.clicks || 1}`;
    case "scroll":
      return `Processo: ${input.processId}\nPosição física: x=${input.x}, y=${input.y}\nRoda: ${input.delta} (${input.delta > 0 ? "para cima" : "para baixo"})`;
  }
}

interface AssistantWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  hide(): void;
  showInactive(): void;
}

/** Keep screenshots and coordinate actions on the same desktop, without the approval panel covering the target. */
export async function withoutAssistantWindow(
  window: AssistantWindow | null,
  execute: () => Promise<ToolResult>,
  settle: () => Promise<unknown> = () => delay(150),
): Promise<ToolResult> {
  const restore = !!window && !window.isDestroyed() && window.isVisible();
  try {
    if (restore) {
      window!.hide();
      await settle();
    }
    return await execute();
  } finally {
    if (restore && !window!.isDestroyed()) window!.showInactive();
  }
}

/** Let Windows PowerShell rebuild its own module paths, even when launched through Node from PS7. */
export function windowsPowerShellEnvironment(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
  );
}

export class DesktopTools {
  constructor(
    private script: string,
    private platform = process.platform,
  ) {}
  async execute(raw: unknown): Promise<ToolResult> {
    const input = desktopArguments.parse(raw);
    if (this.platform !== "win32")
      throw new Error("Controle de desktop disponível somente no Windows.");
    // JSON goes through stdin, never interpolated in shell or PowerShell code.
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const invocation = executeFile(
      "powershell.exe",
      // Apply only to this approved subprocess; Group Policy still takes precedence.
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 16 * 1024 * 1024,
        env: windowsPowerShellEnvironment(),
      },
    );
    invocation.child.stdin?.on("error", () => {});
    invocation.child.stdin?.end(encoded);
    let result;
    try {
      result = await invocation;
    } catch (error) {
      const stderr = (error as { stderr?: unknown })?.stderr;
      const detail =
        typeof stderr === "string" ? stderr : error instanceof Error ? error.message : "";
      if (
        /PSSecurityException|FullyQualifiedErrorId\s*:\s*(UnauthorizedAccess|AuthorizationManagerCheckFailed)\b/i.test(
          detail,
        )
      ) {
        throw new Error(
          "O Windows bloqueou o script de controle do STAG por uma política de execução. Esta ação não foi executada. Se o bloqueio persistir na versão atual, peça ao administrador para verificar a política corporativa de scripts do STAG. O aplicativo não altera essa política.",
          { cause: error },
        );
      }
      if (/STAG_DESKTOP_DENIED/.test(detail)) {
        throw new Error(
          "Desktop restrito a Postman, IntelliJ IDEA e Visual Studio Code. O alvo não foi autorizado ou mudou durante a ação. Liste as janelas novamente; se necessário, peça ao cliente para abrir o programa oficial ou remover a sobreposição. Não contorne o bloqueio por shell, outro aplicativo ou automação.",
          { cause: error },
        );
      }
      throw error;
    }
    if (input.action === "screenshot") {
      const capture = z
        .object({
          processId: targetProcess,
          bounds: z.object({
            x: z.number().int(),
            y: z.number().int(),
            width: z.number().int().positive().max(8192),
            height: z.number().int().positive().max(8192),
          }),
          imageBase64: z
            .string()
            .min(1)
            .regex(/^[A-Za-z0-9+/]+={0,2}$/),
        })
        .parse(JSON.parse(result.stdout.replace(/^\uFEFF/, "")));
      if (capture.processId !== input.processId)
        throw new Error("A captura não pertence ao processo solicitado.");
      const { x, y, width, height } = capture.bounds;
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: `Janela do processo ${capture.processId}: ${width}×${height} pixels. Origem física: x=${x}, y=${y}. Para clicar/rolar, some a origem às coordenadas na imagem e use processId=${capture.processId}. Somente Postman, IntelliJ IDEA e Visual Studio Code são permitidos.`,
          },
          { type: "inputImage", imageUrl: `data:image/png;base64,${capture.imageBase64}` },
        ],
      };
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: result.stdout.trim() || "Ação concluída." }],
    };
  }
}

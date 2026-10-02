import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { Approval } from "../shared/types";

const executeFile = promisify(execFile);
export const desktopArguments = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list_windows") }).strict(),
  z.object({ action: z.literal("screenshot") }).strict(),
  z.object({ action: z.literal("focus_window"), processId: z.number().int().positive() }).strict(),
  z
    .object({
      action: z.literal("send_keys"),
      processId: z.number().int().positive(),
      keys: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("type_text"),
      processId: z.number().int().positive(),
      text: z.string().min(1).max(2000),
    })
    .strict(),
  z
    .object({
      action: z.literal("click"),
      x: z.number().int().min(-30000).max(30000),
      y: z.number().int().min(-30000).max(30000),
      button: z.enum(["left", "right", "middle"]).optional(),
      clicks: z.union([z.literal(1), z.literal(2)]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("scroll"),
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
    "Controla o desktop Windows do cliente após consentimento, com aprovação individual de cada operação. Liste janelas antes de focar, digitar ou enviar atalhos. type_text digita texto literal; send_keys usa sintaxe .NET (ex.: ^s para Ctrl+S). Capture a tela principal antes de clicar ou rolar; use coordenadas físicas em pixels, incluindo sua origem. click permite botão esquerdo/direito/meio e clique duplo. scroll usa delta em unidades de roda (120 por passo, positivo sobe, negativo desce). Capture novamente para verificar o resultado. Não use para contornar recusa do usuário.",
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
        description: "Obrigatório para foco, texto e atalhos; obtido em list_windows.",
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
    },
    required: ["action"],
    additionalProperties: false,
  },
};

export function desktopApproval(input: DesktopArguments): Pick<Approval, "title" | "detail"> {
  switch (input.action) {
    case "list_windows":
      return {
        title: "Permitir listar janelas?",
        detail:
          "Os títulos e processos das janelas abertas serão enviados ao ChatGPT para identificar o aplicativo da tarefa.",
      };
    case "screenshot":
      return {
        title: "Permitir captura de tela?",
        detail:
          "A imagem da tela principal será enviada ao ChatGPT para executar esta tarefa. Ela pode incluir informações de outros aplicativos abertos.",
      };
    case "focus_window":
      return {
        title: "Permitir focar uma janela?",
        detail: `Trazer a janela do processo ${input.processId} para frente.`,
      };
    case "send_keys":
      return {
        title: "Permitir enviar teclas?",
        detail: `Processo: ${input.processId}\nAtalho (SendKeys): ${input.keys}`,
      };
    case "type_text":
      return {
        title: "Permitir digitar texto?",
        detail: `Processo: ${input.processId}\nTexto literal:\n${input.text}`,
      };
    case "click":
      return {
        title: "Permitir clique no desktop?",
        detail: `Posição física: x=${input.x}, y=${input.y}\nBotão: ${{ left: "esquerdo", right: "direito", middle: "meio" }[input.button || "left"]}\nCliques: ${input.clicks || 1}`,
      };
    case "scroll":
      return {
        title: "Permitir rolar no desktop?",
        detail: `Posição física: x=${input.x}, y=${input.y}\nRoda: ${input.delta} (${input.delta > 0 ? "para cima" : "para baixo"})`,
      };
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
    private capture: () => Promise<ToolResult>,
    private platform = process.platform,
  ) {}
  async execute(raw: unknown): Promise<ToolResult> {
    const input = desktopArguments.parse(raw);
    if (this.platform !== "win32")
      throw new Error("Controle de desktop disponível somente no Windows.");
    if (input.action === "screenshot") return this.capture();
    // JSON goes through stdin, never interpolated in shell or PowerShell code.
    const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
    const invocation = executeFile(
      "powershell.exe",
      // Apply only to this approved subprocess; Group Policy still takes precedence.
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.script],
      {
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
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
      throw error;
    }
    return {
      success: true,
      contentItems: [{ type: "inputText", text: result.stdout.trim() || "Ação concluída." }],
    };
  }
}

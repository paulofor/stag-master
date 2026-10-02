import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

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
      action: z.literal("click"),
      x: z.number().int().min(-30000).max(30000),
      y: z.number().int().min(-30000).max(30000),
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
    "Interage com o Windows local do cliente, somente no modo Windows e com aprovação específica. Liste as janelas antes de focar ou enviar teclas. Envie processId para focar o alvo antes de SendKeys (sintaxe .NET, ex.: ^s para Ctrl+S). Capture a tela principal antes de clicar; use coordenadas físicas em pixels, incluindo sua origem. Não use para contornar recusa do usuário. Disponível só no Windows.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list_windows", "focus_window", "send_keys", "click", "screenshot"],
      },
      processId: { type: "integer", description: "Obrigatório para foco e teclas." },
      keys: { type: "string", description: "Obrigatório para send_keys; sintaxe SendKeys .NET." },
      x: { type: "integer", description: "Obrigatório para click, coordenada física horizontal." },
      y: { type: "integer", description: "Obrigatório para click, coordenada física vertical." },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

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
      ["-NoProfile", "-NonInteractive", "-File", this.script],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    invocation.child.stdin?.on("error", () => {});
    invocation.child.stdin?.end(encoded);
    const result = await invocation;
    return {
      success: true,
      contentItems: [{ type: "inputText", text: result.stdout.trim() || "Ação concluída." }],
    };
  }
}

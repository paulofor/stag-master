import { z } from "zod";
import { engineeringToolDescription } from "./engineering-policy";
import { cyberToolSafetyDescription } from "./cyber-safety";

export const userInputInstructions = `Perguntas ao cliente: quando a continuação depender de uma informação, decisão ou ação manual do cliente (por exemplo, selecionar novamente a pasta no STAG Plus), use stag_ask_user com uma pergunta curta e opções claras, incluindo uma alternativa se ele não puder agir agora. Essa ferramenta é bloqueante também no modo normal: aguarde o resultado antes de continuar o trabalho dependente. Não substitua a ferramenta por opções escritas em uma mensagem, por “avise quando terminar” ou por uma pergunta assíncrona. Não peça confirmação para ações rotineiras já autorizadas. A resposta esclarece a tarefa, mas não concede consentimento de desktop/navegador/bancos/APIs nem substitui aprovações específicas de ações críticas. Não solicite senhas, tokens ou outros segredos pela pergunta; use os formulários próprios ou ação manual. Se a ferramenta falhar, informe a falha e não presuma resposta ou autorização.`;

export function userInputCapability(available: boolean): string {
  return available
    ? "stag_ask_user está registrada nesta conversa; use-a para aguardar respostas ou ações manuais do cliente."
    : "stag_ask_user não está registrada neste histórico. Para perguntar e aguardar uma resposta, indique Nova conversa no STAG Plus e peça para repetir a tarefa nela. Preserve a política original; não afirme que está aguardando por uma ferramenta indisponível.";
}

export const userInputTool = {
  type: "function",
  name: "stag_ask_user",
  description: `Pergunta bloqueante ao cliente no painel do STAG Plus, disponível em todos os modos de acesso. Use quando o trabalho depender de uma informação, decisão ou ação manual; só retorna após resposta explícita ou interrupção. Não use para confirmar novamente testes, build local, execução Angular ou reinícios rotineiros de processos locais do projeto já autorizados em Projeto/Windows; confira scripts, alvo, ambiente e efeitos pelo contrato de desenvolvimento. Isso inclui repetir testes após corrigir tipos/animações, regressão e pacote de produção local sem publicação. EPERM ou spawn EPERM não cria uma decisão do cliente. Uma falha anterior na sandbox não justifica perguntar se pode concluir a validação local: investigue o erro e use as ferramentas sob a política vigente; peça ação manual somente diante de impedimento efetivo não resolvível nesse acesso. No modo Windows já autorizado use o executor padrão sem escalonamento rotineiro. Se Projeto realmente precisar escalonar, encaminhe diretamente ao executor, sem esta pergunta preliminar. Aprovações reais do App Server, inclusive para execução fora da sandbox, permanecem no fluxo nativo; não as duplique com esta pergunta. Prefira uma pergunta curta com alternativas, incluindo impossibilidade de agir agora, e aceite texto livre. Não use para senhas/tokens nem para substituir consentimentos ou confirmações críticas das outras ferramentas. A resposta não executa ações nem amplia permissões. ${engineeringToolDescription} ${cyberToolSafetyDescription}`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "question", "options"],
          properties: {
            id: {
              type: "string",
              minLength: 1,
              maxLength: 100,
              pattern: "^(?!__proto__$)[\\s\\S]+$",
            },
            question: { type: "string", minLength: 1, maxLength: 4000 },
            options: {
              type: "array",
              maxItems: 8,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label", "description"],
                properties: {
                  label: { type: "string", minLength: 1, maxLength: 500 },
                  description: { type: "string", maxLength: 2000 },
                },
              },
            },
          },
        },
      },
    },
  },
};

export const userInputQuestions = z
  .array(
    z.object({
      id: z
        .string()
        .min(1)
        .max(100)
        .refine((value) => !!value.trim() && value !== "__proto__"),
      question: z.string().trim().min(1).max(4000),
      isSecret: z.boolean().default(false),
      options: z
        .array(
          z.object({
            label: z.string().trim().min(1).max(500),
            description: z.string().max(2000),
          }),
        )
        .max(8)
        .nullable()
        .optional(),
    }),
  )
  .min(1)
  .max(3)
  .refine((questions) => new Set(questions.map((q) => q.id)).size === questions.length);

export const userInputToolArguments = z
  .object({
    questions: userInputQuestions.refine((questions) =>
      questions.every((q) => !q.isSecret && Array.isArray(q.options)),
    ),
  })
  .strict();

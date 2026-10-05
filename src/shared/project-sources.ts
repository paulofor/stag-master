import { z } from "zod";

export const maxProjectSources = 20;
export const maxSourceUrlLength = 2048;
const noControls = /^[^\p{Cc}\p{Cf}]*$/u;

export const documentationSourceSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Informe o nome da fonte.")
      .max(120, "O nome deve ter no máximo 120 caracteres.")
      .regex(noControls, "O nome não pode conter caracteres de controle."),
    url: z
      .string()
      .trim()
      .min(1, "Informe a URL da documentação.")
      .max(maxSourceUrlLength, "A URL deve ter no máximo 2048 caracteres.")
      .refine((raw) => {
        try {
          const url = new URL(raw);
          return (
            /^https?:\/\//i.test(raw) &&
            noControls.test(raw) &&
            ["https:", "http:"].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            url.href.length <= maxSourceUrlLength
          );
        } catch {
          return false;
        }
      }, "Use uma URL completa HTTP ou HTTPS, sem usuário ou senha.")
      .transform((raw) => new URL(raw).href),
  })
  .strict();

export const projectSourcesSchema = z
  .array(documentationSourceSchema)
  .max(maxProjectSources, "Cadastre no máximo 20 fontes por projeto.")
  .superRefine((sources, context) => {
    const urls = new Set<string>();
    sources.forEach((source, index) => {
      if (urls.has(source.url))
        context.addIssue({
          code: "custom",
          path: [index, "url"],
          message: "Esta URL já está cadastrada neste projeto.",
        });
      urls.add(source.url);
    });
  });

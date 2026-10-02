import { z } from "zod";

export const actionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum([
        "connect",
        "login",
        "cancelLogin",
        "logout",
        "selectProject",
        "newChat",
        "stop",
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("preferences"),
      model: z.string().max(200).optional(),
      effort: z.string().max(30).optional(),
      mode: z.enum(["read", "project", "windows"]).optional(),
      windowsConsent: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("resume"), threadId: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal("send"), text: z.string().trim().min(1).max(100000) }).strict(),
  z
    .object({
      type: z.literal("answer"),
      id: z.string().min(1).max(200),
      accept: z.boolean().optional(),
      answers: z.record(z.string().max(200), z.string().max(10000)).optional(),
    })
    .strict(),
  z.object({ type: z.literal("openLink"), url: z.string().max(8000) }).strict(),
]);

export function safeLink(raw: string, login = false): string {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Link não permitido.");
  }
  if (
    login &&
    (url.protocol !== "https:" ||
      !["auth.openai.com", "chatgpt.com", "openai.com"].includes(url.hostname))
  ) {
    throw new Error("URL de login inesperada. Reconecte o Codex.");
  }
  return url.href;
}

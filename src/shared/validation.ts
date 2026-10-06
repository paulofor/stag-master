import { z } from "zod";
import { requestImagesSchema } from "./request-images";
import { projectSourcesSchema } from "./project-sources";

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
  z
    .object({
      type: z.literal("enqueue"),
      threadId: z.string().min(1).max(200),
      id: z.uuid(),
      text: z.string().trim().min(1).max(100000),
    })
    .strict(),
  z
    .object({
      type: z.literal("removeQueued"),
      threadId: z.string().min(1).max(200),
      id: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("pauseQueue"),
      threadId: z.string().min(1).max(200),
      paused: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("projectSources"),
      projectPath: z.string().min(1).max(32768),
      sources: projectSourcesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("send"),
      text: z.string().trim().max(100000),
      images: requestImagesSchema.optional(),
      videoId: z.uuid().optional(),
    })
    .strict()
    .refine(
      (action) => !!action.text || !!action.images?.length || !!action.videoId,
      "Escreva uma mensagem ou cole uma imagem.",
    ),
  z.object({ type: z.literal("selectVideo") }).strict(),
  z.object({ type: z.literal("removeVideo") }).strict(),
  z
    .object({
      type: z.literal("answer"),
      id: z.string().min(1).max(200),
      accept: z.boolean().optional(),
      answers: z.record(z.string().max(200), z.string().max(10000)).optional(),
    })
    .strict(),
  z.object({ type: z.literal("openLink"), url: z.string().max(8000) }).strict(),
  z.object({ type: z.literal("browserVisibility"), visible: z.boolean() }).strict(),
  z.object({ type: z.literal("browserConsent"), allow: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("browserSession"),
      projectPath: z.string().min(1).max(32768),
      remember: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("browserControl"),
      control: z.discriminatedUnion("action", [
        z.object({ action: z.literal("navigate"), url: z.string().min(1).max(8000) }).strict(),
        z.object({ action: z.enum(["back", "forward", "reload"]) }).strict(),
      ]),
    })
    .strict(),
  z
    .object({
      type: z.literal("browserBounds"),
      bounds: z
        .object({
          x: z.number().int().min(0).max(20000),
          y: z.number().int().min(0).max(20000),
          width: z.number().int().min(0).max(20000),
          height: z.number().int().min(0).max(20000),
        })
        .strict(),
    })
    .strict(),
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

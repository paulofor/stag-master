import { z } from "zod";
import { requestImagesSchema } from "./request-images";
import { projectSourcesSchema } from "./project-sources";
import { branchOperationSchema } from "./project-branches";
import { databasePasswordSchema, sqlServerConfigSchema } from "./database-connections";
import { apiActionSchemas } from "./api-connections";
import { browserTabs } from "./types";

export const browserTabSchema = z.enum(browserTabs);

export const actionSchema = z.discriminatedUnion("type", [
  ...apiActionSchemas,
  z
    .object({
      type: z.literal("databaseConsent"),
      projectPath: z.string().min(1).max(32768),
      revision: z.uuid(),
      allow: z.boolean(),
    })
    .strict(),
  z
    .object({ type: z.literal("listDatabases"), projectPath: z.string().min(1).max(32768) })
    .strict(),
  z
    .object({
      type: z.literal("saveDatabase"),
      projectPath: z.string().min(1).max(32768),
      revision: z.uuid(),
      connectionId: z.uuid().nullable(),
      config: sqlServerConfigSchema,
      password: databasePasswordSchema,
      rememberPassword: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("deleteDatabase"),
      projectPath: z.string().min(1).max(32768),
      revision: z.uuid(),
      connectionId: z.uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("testDatabase"),
      projectPath: z.string().min(1).max(32768),
      revision: z.uuid(),
      connectionId: z.uuid().nullable(),
      testId: z.uuid(),
      config: sqlServerConfigSchema,
      password: databasePasswordSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("cancelDatabaseTest"),
      projectPath: z.string().min(1).max(32768),
      testId: z.uuid(),
    })
    .strict(),
  z.object({ type: z.literal("listBranches"), projectPath: z.string().min(1).max(32768) }).strict(),
  z
    .object({
      type: z.literal("changeBranch"),
      projectPath: z.string().min(1).max(32768),
      revision: z.uuid(),
      repositoryId: z.uuid(),
      operation: branchOperationSchema,
    })
    .strict(),
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
      type: z.literal("mouseMovement"),
      threadId: z.string().min(1).max(200),
      enabled: z.boolean(),
    })
    .strict(),
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
  z.object({ type: z.literal("analyzeVideo") }).strict(),
  z
    .object({
      type: z.literal("videoAnalysis"),
      id: z.uuid(),
      control: z.enum(["pause", "resume", "cancel", "retry"]),
    })
    .strict(),
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
  z.object({ type: z.literal("browserTab"), tab: browserTabSchema }).strict(),
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
        z
          .object({
            action: z.literal("navigate"),
            url: z.string().min(1).max(8000),
            tab: browserTabSchema.optional(),
          })
          .strict(),
        z
          .object({
            action: z.enum(["back", "forward", "reload"]),
            tab: browserTabSchema.optional(),
          })
          .strict(),
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

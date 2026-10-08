import { z } from "zod";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u);
const endpoint = text(2048)
  .min(1)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !/[\\?#]/.test(value)
      );
    } catch {
      return false;
    }
  }, "Use uma URL HTTP(S) completa, sem credenciais, parâmetros ou fragmento.")
  .transform((value) => new URL(value).href);
export const apiConfigSchema = z
  .object({
    name: text(80).min(1),
    baseUrl: endpoint.transform((url) => (url.endsWith("/") ? url : `${url}/`)),
    allowHttp: z.boolean(),
    timeoutSeconds: z.number().int().min(5).max(120),
    auth: z.discriminatedUnion("type", [
      z.object({ type: z.literal("none") }).strict(),
      z.object({ type: z.literal("bearer") }).strict(),
      z
        .object({
          type: z.literal("basic"),
          user: text(256)
            .min(1)
            .refine((v) => !v.includes(":")),
        })
        .strict(),
      z
        .object({
          type: z.literal("oauth2"),
          flow: z.enum(["authorization_code", "client_credentials"]),
          authorizationUrl: z.union([z.literal(""), endpoint]),
          tokenUrl: endpoint,
          clientId: text(512).min(1),
          clientAuthentication: z.enum(["none", "basic", "body"]),
          scopes: text(2048),
          callbackPort: z.number().int().min(1024).max(65535),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((config, ctx) => {
    const oauth = config.auth.type === "oauth2" ? config.auth : null;
    const urls = [
      config.baseUrl,
      ...(oauth ? [oauth.tokenUrl, oauth.authorizationUrl].filter(Boolean) : []),
    ];
    if (
      !config.allowHttp &&
      urls.some((url) => URL.canParse(url) && new URL(url).protocol !== "https:")
    )
      ctx.addIssue({
        code: "custom",
        path: ["allowHttp"],
        message: "Use HTTPS ou habilite explicitamente HTTP nesta conexão.",
      });
    if (oauth?.flow === "authorization_code" && !oauth.authorizationUrl)
      ctx.addIssue({
        code: "custom",
        path: ["auth", "authorizationUrl"],
        message: "Informe a URL de autorização.",
      });
    if (oauth?.flow === "client_credentials" && oauth.clientAuthentication === "none")
      ctx.addIssue({
        code: "custom",
        path: ["auth", "clientAuthentication"],
        message: "Client Credentials requer autenticação do cliente.",
      });
  });
export const apiSecretSchema = z
  .string()
  .max(16384)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u);
export type ApiConfig = z.infer<typeof apiConfigSchema>;
export const emptyApiConfig: ApiConfig = {
  name: "",
  baseUrl: "",
  allowHttp: false,
  timeoutSeconds: 30,
  auth: { type: "bearer" },
};
export const emptyOAuthConfig: Extract<ApiConfig["auth"], { type: "oauth2" }> = {
  type: "oauth2",
  flow: "authorization_code",
  authorizationUrl: "",
  tokenUrl: "",
  clientId: "",
  clientAuthentication: "none",
  scopes: "",
  callbackPort: 43821,
};
export interface ApiProfile {
  id: string;
  config: ApiConfig;
  remember: boolean;
  credentialAvailable: boolean;
  authenticated: boolean;
}
export interface ProjectApis {
  revision: string;
  connections: ApiProfile[];
  canRemember: boolean;
  authorized: boolean;
  operation: {
    id: string;
    connectionId: string;
    status: "working" | "success" | "error" | "canceled";
    message: string;
  } | null;
  metrics: { requests: number; failures: number; elapsedMs: number; lastStatus: number | null };
}
export type ApiAction =
  | { type: "listApis"; projectPath: string }
  | {
      type: "saveApi";
      projectPath: string;
      revision: string;
      connectionId: string | null;
      config: ApiConfig;
      secret: string;
      remember: boolean;
    }
  | {
      type: "deleteApi" | "authenticateApi";
      projectPath: string;
      revision: string;
      connectionId: string;
    }
  | { type: "cancelApiLogin"; projectPath: string; operationId: string }
  | { type: "apiConsent"; projectPath: string; revision: string; allow: boolean };

const projectPath = z.string().min(1).max(32768);
const reference = { projectPath, revision: z.uuid(), connectionId: z.uuid() };
export const apiActionSchemas = [
  z.object({ type: z.literal("listApis"), projectPath }).strict(),
  z
    .object({
      type: z.literal("saveApi"),
      ...reference,
      connectionId: z.uuid().nullable(),
      config: apiConfigSchema,
      secret: apiSecretSchema,
      remember: z.boolean(),
    })
    .strict(),
  z.object({ type: z.enum(["deleteApi", "authenticateApi"]), ...reference }).strict(),
  z.object({ type: z.literal("cancelApiLogin"), projectPath, operationId: z.uuid() }).strict(),
  z
    .object({ type: z.literal("apiConsent"), projectPath, revision: z.uuid(), allow: z.boolean() })
    .strict(),
] as const;

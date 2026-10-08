import { z } from "zod";

export const maxDatabaseConnections = 20;
const noControls = /^[^\p{Cc}\p{Cf}]*$/u;
const label = (max: number) => z.string().trim().min(1).max(max).regex(noControls);
const host = z
  .string()
  .trim()
  .min(1, "Informe o servidor.")
  .max(253)
  .refine((value) => {
    if (value.includes(":")) {
      try {
        return /^[a-f\d:]+$/i.test(value) && new URL(`http://[${value}]/`).hostname.startsWith("[");
      } catch {
        return false;
      }
    }
    return value.split(".").every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part));
  }, "Use apenas o hostname ou IP, sem URL, porta, instância ou credenciais.")
  .transform((value) =>
    value.includes(":") ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value.toLowerCase(),
  );

export const sqlServerConfigSchema = z
  .object({
    name: label(80),
    driver: z.literal("sqlserver"),
    authentication: z.literal("sql"),
    server: host,
    endpoint: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("port"), port: z.number().int().min(1).max(65535) }).strict(),
      z
        .object({
          kind: z.literal("instance"),
          instance: z
            .string()
            .trim()
            .min(1)
            .max(128)
            .regex(/^[a-z\d_$-]+$/i),
        })
        .strict(),
    ]),
    database: label(128),
    user: label(128),
    encrypt: z.boolean(),
    trustServerCertificate: z.boolean(),
    certificateHost: z.union([z.literal(""), host]),
    timeoutSeconds: z.number().int().min(5).max(60),
  })
  .strict();

export const databasePasswordSchema = z
  .string()
  .max(1024)
  .refine((value) => !value.includes("\0"));
export type SqlServerConfig = z.infer<typeof sqlServerConfigSchema>;
export interface DatabaseConnectionProfile {
  id: string;
  config: SqlServerConfig;
  passwordSaved: boolean;
  passwordAvailable: boolean;
}
export interface DatabaseConnectionTest {
  id: string;
  status: "testing" | "success" | "error" | "canceled";
  message: string;
  elapsedMs?: number;
}
export interface ProjectDatabases {
  revision: string;
  connections: DatabaseConnectionProfile[];
  canRememberPassword: boolean;
  authorized: boolean;
  metrics: { requests: number; failures: number; elapsedMs: number; lastRows: number | null };
  test: DatabaseConnectionTest | null;
}
export const emptySqlServerConfig: SqlServerConfig = {
  name: "",
  driver: "sqlserver",
  authentication: "sql",
  server: "",
  endpoint: { kind: "port", port: 1433 },
  database: "",
  user: "",
  encrypt: true,
  trustServerCertificate: false,
  certificateHost: "",
  timeoutSeconds: 15,
};

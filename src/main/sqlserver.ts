import { Connection, Request, type ConnectionConfiguration } from "tedious";
import type { SqlServerConfig } from "../shared/database-connections";
import { sqlServerError } from "./database-errors";
export { sqlServerError, databaseTestError } from "./database-errors";

export function sqlServerOptions(
  config: SqlServerConfig,
  password: string,
): ConnectionConfiguration {
  return {
    server: config.server,
    authentication: { type: "default", options: { userName: config.user, password } },
    options: {
      ...(config.endpoint.kind === "port"
        ? { port: config.endpoint.port }
        : { instanceName: config.endpoint.instance }),
      database: config.database,
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      ...(config.certificateHost ? { serverName: config.certificateHost } : {}),
      connectTimeout: config.timeoutSeconds * 1000,
      requestTimeout: config.timeoutSeconds * 1000,
      maxRetriesOnTransientErrors: 0,
      fallbackToDefaultDb: false,
      appName: "STAG Plus connection test",
      workstationId: "STAG Plus",
    },
  };
}

export type SqlServerTester = (
  config: SqlServerConfig,
  password: string,
  signal: AbortSignal,
) => Promise<void>;

// A single fixed, read-only probe. Never accepts SQL or environment credentials.
export const testSqlServer: SqlServerTester = (config, password, signal) => {
  if (signal.aborted) return Promise.reject(new Error("Teste de conexão cancelado."));
  return new Promise<void>((resolve, reject) => {
    const connection = new Connection(sqlServerOptions(config, password));
    let outcome: Error | null = null;
    let finished = false;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      outcome = error;
      connection.close();
    };
    const cancel = () => finish(new Error("Teste de conexão cancelado."));
    // Bound both connection and probe; cancellation always waits for the driver's end.
    const deadline = setTimeout(
      () =>
        finish(
          new Error(
            "O teste excedeu o prazo. Confira servidor, porta ou instância, VPN e firewall.",
          ),
        ),
      config.timeoutSeconds * 2000 + 1000,
    );
    connection.on("end", () => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      if (!finished) outcome = new Error("A conexão encerrou antes de concluir o teste.");
      if (outcome) reject(outcome);
      else resolve();
    });
    connection.on("error", (error) => finish(new Error(sqlServerError(error))));
    connection.on("connect", (error) => {
      if (finished) return;
      if (error) return finish(new Error(sqlServerError(error)));
      const request = new Request("SELECT 1 AS stag_connection_test", (failure) => {
        finish(failure ? new Error(sqlServerError(failure)) : null);
      });
      connection.execSql(request);
    });
    signal.addEventListener("abort", cancel, { once: true });
    connection.connect();
    if (signal.aborted) cancel();
  });
};

import { Connection, Request, TYPES } from "tedious";
import { sqlServerOptions } from "./sqlserver";
import { sqlServerError } from "./database-errors";
import { SqlFailure, redactSqlValue, type SqlQueryRunner } from "./sql-tools";
import { secretField } from "./api-http";

// SQL/parameters arrive only from main validation. Neither config nor passwords come
// from the tool. Every outcome, including truncation/cancellation, waits for end.
export const runSqlQuery: SqlQueryRunner = (config, password, args, signal) => {
  if (signal.aborted) return Promise.reject(new SqlFailure("Operação SQL cancelada."));
  return new Promise((resolve, reject) => {
    const options = sqlServerOptions(config, password);
    options.options!.appName = "STAG SQL tool";
    options.options!.rowCollectionOnDone = false;
    options.options!.rowCollectionOnRequestCompletion = false;
    const connection = new Connection(options);
    let outcome: Error | null = null,
      finished = false,
      activeRequest = false;
    const result = {
      columns: [] as string[],
      rows: [] as unknown[][],
      affectedRows: 0,
      truncated: false,
    };
    let bytes = 0;
    const finish = (error: Error | null) => {
      if (finished) return;
      finished = true;
      outcome = error;
      // Closing from a row event clears Tedious' active request while its parser
      // still consumes the current message. Cancel first and close in the callback.
      if (activeRequest) connection.cancel();
      else connection.close();
    };
    const cancel = () => {
      const error = new SqlFailure(
        "Operação SQL cancelada; confira o efeito antes de tentar novamente.",
      );
      if (finished && !outcome) outcome = error;
      else finish(error);
    };
    const deadline = setTimeout(
      () =>
        finish(
          new SqlFailure(
            "A operação SQL excedeu o prazo; confira o efeito antes de repetir uma escrita.",
          ),
        ),
      config.timeoutSeconds * 2000 + 1000,
    );
    connection.on("end", () => {
      clearTimeout(deadline);
      signal.removeEventListener("abort", cancel);
      if (!finished)
        outcome = new SqlFailure(
          "A sessão SQL encerrou antes da conclusão; confira o efeito antes de tentar novamente.",
        );
      if (outcome) reject(outcome);
      else resolve(result);
    });
    connection.on("error", (error) => finish(new SqlFailure(sqlServerError(error))));
    connection.on("connect", (error) => {
      if (finished) return;
      if (error) return finish(new SqlFailure(sqlServerError(error)));
      const maxRows = args.maxRows || 100;
      // Server-side LOB and row limits avoid accumulating a full result in the driver.
      const sql = `${args.operation === "query" ? `SET TEXTSIZE 4096; SET ROWCOUNT ${maxRows + 1};\n` : ""}${args.sql}`;
      const request = new Request(sql, (failure, count) => {
        activeRequest = false;
        if (finished) {
          connection.close();
          return;
        }
        result.affectedRows = args.operation === "execute" ? count || 0 : 0;
        finish(
          failure
            ? new SqlFailure(
                "O SQL Server recusou a instrução. Confira sintaxe, objetos e permissões; não repita escrita automaticamente.",
              )
            : null,
        );
      });
      for (const item of args.parameters || [])
        request.addParameter(
          item.name,
          { string: TYPES.NVarChar, int: TYPES.Int, float: TYPES.Float, boolean: TYPES.Bit }[
            item.type
          ],
          item.value,
          item.type === "string" ? { length: 4000 } : {},
        );
      request.on("columnMetadata", (metadata) => {
        if (finished) return;
        if (!Array.isArray(metadata)) return finish(new SqlFailure("Metadados SQL inválidos."));
        const columns = metadata;
        if (columns.length > 128 || result.columns.length)
          return finish(new SqlFailure("Use somente um resultado SQL com até 128 colunas."));
        result.columns = columns.map((column) => column.colName.slice(0, 128));
        bytes = Buffer.byteLength(JSON.stringify(result.columns));
        if (bytes > 56000)
          finish(
            new SqlFailure("Metadados SQL excederam o limite. Use menos colunas e nomes menores."),
          );
      });
      request.on("row", (row: { value: unknown }[]) => {
        if (finished) return;
        if (args.operation !== "query")
          return finish(
            new SqlFailure(
              "Escrita com retorno de linhas não é suportada; confira o efeito antes de tentar novamente.",
            ),
          );
        const values = row.map(({ value }, index) => {
          if (secretField(result.columns[index] || "")) return "[campo sensível removido]";
          if (value === null || typeof value === "boolean" || typeof value === "number")
            return value;
          let text =
            value instanceof Date
              ? value.toISOString()
              : Buffer.isBuffer(value)
                ? "[binário omitido]"
                : String(value);
          if (Buffer.byteLength(text) >= 4096) {
            result.truncated = true;
            text = Buffer.from(text).subarray(0, 4096).toString("utf8");
          }
          return redactSqlValue(text, password);
        });
        const size = Buffer.byteLength(JSON.stringify(values));
        if (result.rows.length >= maxRows || bytes + size > 56000) {
          result.truncated = true;
          finish(null);
          return;
        }
        bytes += size;
        result.rows.push(values);
      });
      activeRequest = true;
      connection.execSql(request);
    });
    signal.addEventListener("abort", cancel, { once: true });
    connection.connect();
    if (signal.aborted) cancel();
  });
};

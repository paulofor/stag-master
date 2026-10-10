import { z } from "zod";

export const browserDownloadAccept =
  "application/pdf, application/zip, application/octet-stream, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, application/vnd.ms-excel, text/csv, text/plain, application/json, application/xml";

export const browserDownloadFormats = [
  "pdf",
  "zip",
  "xlsx",
  "xls",
  "csv",
  "txt",
  "json",
  "xml",
] as const;
export const downloadDestination = z
  .string()
  .min(1)
  .max(240)
  .refine((path) => {
    const parts = path.split(/[\\/]/);
    return (
      parts.length <= 16 &&
      parts.every(
        (part) =>
          part.length <= 100 &&
          !!part &&
          part !== "." &&
          part !== ".." &&
          !/[<>:"|?*\x00-\x1f\x7f]/.test(part) &&
          !/^[ .]|[ .]$/.test(part) &&
          !/^(con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:[ .]|$)/i.test(part) &&
          !/^(node_modules|auth\.json)$/i.test(part),
      ) &&
      browserDownloadFormats.some((format) => path.toLowerCase().endsWith(`.${format}`))
    );
  }, "Informe destino relativo no projeto, com nome PDF/ZIP/XLSX/XLS/CSV/TXT/JSON/XML, sem metadados, links ou caminhos especiais.");

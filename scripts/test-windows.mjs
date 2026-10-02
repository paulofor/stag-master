import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
if (process.platform !== "win32")
  throw new Error("Este teste requer Windows. Use os testes com doubles no Linux.");
const script = resolve("native/windows-control.ps1");
execFileSync(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-File", resolve("native/validate.ps1"), "-ScriptPath", script],
  { stdio: "inherit" },
);
const input = Buffer.from(JSON.stringify({ action: "list_windows" })).toString("base64");
const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
  encoding: "utf8",
  timeout: 15000,
  input,
});
if (!Array.isArray(JSON.parse(result.replace(/^\uFEFF/, ""))))
  throw new Error("Contrato de list_windows inválido.");
console.log(
  "PowerShell: parser e listagem real de janelas OK. Foco/teclado/clique não são executados no desktop de CI.",
);

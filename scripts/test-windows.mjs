import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
if (process.platform !== "win32")
  throw new Error("Este teste requer Windows. Use os testes com doubles no Linux.");
const script = resolve("native/windows-control.ps1");
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("tests/fixtures/desktop-native.ps1"),
    "-ScriptPath",
    script,
  ],
  { stdio: "inherit" },
);
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("native/validate.ps1"),
    "-ScriptPath",
    script,
  ],
  { stdio: "inherit" },
);

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/windows-policy-test-"));
const inheritedPolicy = process.env.PSExecutionPolicyPreference;
try {
  await build({
    entryPoints: ["src/main/desktop-tools.ts"],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { DesktopTools } = await import(pathToFileURL(join(dir, "desktop-tools.mjs")).href);
  const policies = () =>
    JSON.parse(
      execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-ExecutionPolicy -List | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", timeout: 15000 },
      ).replace(/^\uFEFF/, ""),
    );
  // Restrict only this test process and its children, without Set-ExecutionPolicy or registry writes.
  process.env.PSExecutionPolicyPreference = "Restricted";
  const before = policies();
  const effective = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"],
    { encoding: "utf8", timeout: 15000 },
  ).trim();
  assert.equal(effective, "Restricted", "O teste precisa iniciar com scripts bloqueados.");
  const fixture = resolve("tests/fixtures/desktop-process.ps1");
  const input = Buffer.from(JSON.stringify({ action: "list_windows" })).toString("base64");
  assert.throws(
    () =>
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", fixture], {
        input,
        encoding: "utf8",
        timeout: 15000,
        stdio: "pipe",
      }),
    /UnauthorizedAccess|PSSecurityException/,
    "Sem política de processo, o script deve ser bloqueado.",
  );
  const noCapture = async () => {
    throw new Error("Captura não permitida neste teste.");
  };
  const driver = new DesktopTools(fixture, noCapture);
  for (const args of [
    { action: "list_windows" },
    {
      action: "type_text",
      processId: 4242,
      text: "Texto + ^ % {x}; $(dummy); `literal`; ação\nlinha",
    },
  ]) {
    const result = await driver.execute(args);
    assert.equal(result.success, true);
    const output = JSON.parse(result.contentItems[0].text);
    assert.equal(output.processPolicy, "Bypass");
    assert.deepEqual(output.request, args);
    assert.equal(output.windows[0].processId, 4242);
  }
  assert.deepEqual(
    policies(),
    before,
    "As políticas do processo pai e persistentes devem ser preservadas.",
  );
  // CI Windows has no client windows. Outside CI, keep every operation synthetic.
  if (process.env.CI === "true") {
    const result = await new DesktopTools(script, noCapture).execute({ action: "list_windows" });
    assert.ok(Array.isArray(JSON.parse(result.contentItems[0].text)));
  }
  console.log(
    "PowerShell: parser, dispatcher sintético e driver de produção sob Restricted OK; políticas persistentes preservadas. Nenhum mouse/teclado/captura real executado.",
  );
} finally {
  if (inheritedPolicy === undefined) delete process.env.PSExecutionPolicyPreference;
  else process.env.PSExecutionPolicyPreference = inheritedPolicy;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

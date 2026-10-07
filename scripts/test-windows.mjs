import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
if (process.platform !== "win32")
  throw new Error("Este teste requer Windows. Use os testes com doubles no Linux.");
const script = resolve("native/windows-control.ps1");

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/windows-policy-test-"));
const inheritedPolicy = process.env.PSExecutionPolicyPreference;
const inheritedModules = process.env.PSModulePath;
try {
  await build({
    entryPoints: ["src/main/desktop-tools.ts", "src/main/waiting-sound.ts"],
    outdir: dir,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
  });
  const { DesktopTools, windowsPowerShellEnvironment } = await import(
    pathToFileURL(join(dir, "desktop-tools.mjs")).href
  );
  const { WaitingSound, waitingWave } = await import(
    pathToFileURL(join(dir, "waiting-sound.mjs")).href
  );
  const runPowerShell = (args, options = {}) =>
    execFileSync("powershell.exe", args, {
      // Test scripts include cold PowerShell startup and C# compilation, unlike a desktop action.
      timeout: 60000,
      ...options,
      env: windowsPowerShellEnvironment(),
    });
  for (const validation of ["tests/fixtures/desktop-native.ps1", "native/validate.ps1"]) {
    console.log(`Windows: validação ${validation} (inicialização/compilação, prazo 60 s).`);
    runPowerShell(
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        resolve(validation),
        "-ScriptPath",
        script,
      ],
      { stdio: "inherit" },
    );
  }
  const policies = () =>
    JSON.parse(
      runPowerShell(
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Get-ExecutionPolicy -List | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8" },
      ).replace(/^\uFEFF/, ""),
    );
  // Restrict only this test process and its children, without Set-ExecutionPolicy or registry writes.
  process.env.PSExecutionPolicyPreference = "Restricted";
  console.log("Windows: conferir Restricted e preservação das políticas pelo driver de produção.");
  // Compare scopes in separate diagnostic processes; the no-flag probe below remains Restricted.
  const before = policies();
  console.log("Windows: áudio sintético de cinco segundos pelo script de produção sob Restricted.");
  const soundScript = resolve("native/waiting-sound.ps1");
  const wave = waitingWave();
  assert.equal(wave.readUInt32LE(40) / wave.readUInt32LE(28), 5);
  const played = runPowerShell(
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", soundScript],
    { input: wave.toString("base64"), encoding: "utf8" },
  );
  assert.equal(
    played
      .replace(/^\uFEFF/, "")
      .replace(/\r\n/g, "\n")
      .trim(),
    "STAG_WAIT_SOUND_READY\nSTAG_WAIT_SOUND_DONE",
  );
  for (const input of ["invalid synthetic audio", Buffer.alloc(wave.length).toString("base64")]) {
    assert.throws(
      () =>
        runPowerShell(
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", soundScript],
          { input, encoding: "utf8", stdio: "pipe" },
        ),
      /STAG_WAIT_SOUND_FAILED/,
    );
  }
  const sound = new WaitingSound(soundScript);
  const warnings = [];
  const warn = console.warn;
  try {
    console.warn = (...args) => warnings.push(args);
    sound.play();
    await sound.settled();
    sound.play();
    sound.stop();
    await sound.settled();
    sound.play();
    await sound.settled();
    assert.deepEqual(warnings, [], "Driver deve recuperar sem falhas ou áudio pendente.");
  } finally {
    console.warn = warn;
    sound.stop();
    await sound.settled();
  }
  const fixture = resolve("tests/fixtures/desktop-process.ps1");
  const input = Buffer.from(JSON.stringify({ action: "list_windows" })).toString("base64");
  assert.throws(
    () =>
      runPowerShell(["-NoProfile", "-NonInteractive", "-File", fixture], {
        input,
        encoding: "utf8",
        stdio: "pipe",
      }),
    /UnauthorizedAccess|PSSecurityException/,
    "Sem política de processo, o script deve ser bloqueado.",
  );
  const driver = new DesktopTools(fixture);
  const opening = {
    action: "open_forticlient",
    risk: "critical",
    intent: "Abrir console VPN sintético",
  };
  assert.match(await driver.confirmationReason(opening), /somente para a abertura/);
  await assert.rejects(driver.execute(opening), /confirmação específica/);
  const opened = await driver.execute(opening, true);
  assert.equal(opened.success, true);
  assert.match(opened.contentItems[0].text, /Isso não comprova conexão da VPN/);
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
  assert.equal(
    process.env.PSExecutionPolicyPreference,
    "Restricted",
    "A política herdada do processo pai deve ser preservada.",
  );
  assert.deepEqual(
    await driver.pulseCursor(new AbortController().signal),
    { moved: false },
    "O gesto interno usa a mesma política do subprocesso, somente com dados sintéticos.",
  );
  const hostHandle = Buffer.alloc(8);
  hostHandle.writeBigUInt64LE(11001n);
  const boundDriver = new DesktopTools(fixture, "win32", () => hostHandle);
  assert.deepEqual(await boundDriver.pulseCursor(), { moved: false, reason: "cursor_outside" });
  // Binding is never attached to public actions, even on the same driver instance.
  assert.deepEqual(
    JSON.parse((await boundDriver.execute({ action: "list_windows" })).contentItems[0].text)
      .request,
    { action: "list_windows" },
  );
  assert.equal(
    process.env.PSModulePath,
    inheritedModules,
    "Os caminhos de módulos do pai devem ser preservados.",
  );
  assert.deepEqual(policies(), before, "As políticas persistentes devem ser preservadas.");
  // CI Windows has no client windows. Outside CI, keep every operation synthetic.
  if (process.env.CI === "true") {
    console.log(
      "Windows: conferir list_windows pelo script empacotado, sem mouse/teclado/captura.",
    );
    const result = await new DesktopTools(script).execute({ action: "list_windows" });
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

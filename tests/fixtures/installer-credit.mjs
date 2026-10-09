import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppInfo } from "app-builder-lib";
import { readPackageJson } from "app-builder-lib/out/util/packageMetadata.js";
import { NsisTarget } from "app-builder-lib/out/targets/nsis/NsisTarget.js";
import { NsisScriptGenerator } from "app-builder-lib/out/targets/nsis/nsisScriptGenerator.js";
import { getEffectiveOptions } from "app-builder-lib/out/options/CommonWindowsInstallerConfiguration.js";
import { gte } from "semver";

const metadata = await readPackageJson(resolve("package.json"));
const info = { metadata, config: metadata.build };
const appInfo = new AppInfo(info, null);
assert.equal(appInfo.companyName, "Paulo Forestieri");
assert.equal(appInfo.copyright, "Desenvolvido por: Paulo Forestieri");
assert.equal(appInfo.id, "io.stag.desktop");
assert.equal(appInfo.productName, "STAG Plus");
assert.equal(appInfo.productFilename, "STAG Plus");
assert.equal(
  metadata.name,
  "stag-desktop",
  "A identidade interna de atualização deve continuar estável.",
);
assert.ok(gte(appInfo.version, "0.4.40"), "A renomeação mantém a sequência de versões.");
assert.equal(metadata.build.win.artifactName, "STAG-Plus-${version}-Windows-${arch}-Setup.${ext}");

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/installer-credit-"));
try {
  const packager = { info, config: info.config, appInfo, debugLogger: { isEnabled: false } };
  assert.equal(getEffectiveOptions(info.config.nsis, packager).shortcutName, "STAG Plus");
  const target = new NsisTarget(packager, dir, "nsis", { refCount: 0 });
  const defines = {
    PRODUCT_NAME: appInfo.productName,
    APP_FILENAME: appInfo.productFilename,
    VERSION: appInfo.version,
  };
  // Use the production builder's author normalization, defines, escaping and compiler.
  target.configureDefinesForAllTypeOfInstaller(defines);
  const includes = new NsisScriptGenerator();
  includes.include("MUI2.nsh");
  // Preserve native path separators, as the production builder does on Windows.
  includes.include(resolve(info.config.nsis.include));
  const file = join(dir, "welcome-fixture.exe");
  await target.executeMakensis(
    defines,
    { OutFile: `"${file}"` },
    `Unicode true
SetCompress off
Name "\${PRODUCT_NAME}"
${includes.build()}
!insertmacro customWelcomePage
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "PortugueseBR"
Section
  DetailPrint "Compilação sintética; este executável nunca é iniciado."
SectionEnd
`,
    { skipSizeVerification: true },
  );
  const executable = await readFile(file);
  assert.equal(executable.subarray(0, 2).toString(), "MZ");
  for (const text of [
    "Instalação do STAG Plus",
    "Desenvolvido por: Paulo Forestieri",
    `STAG Plus ${appInfo.version}`,
  ])
    assert.ok(executable.includes(Buffer.from(text, "utf16le")), `Texto ausente: ${text}`);
  console.log("Boas-vindas NSIS compiladas com crédito e versão: OK");
} finally {
  await rm(dir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AppInfo } from "app-builder-lib";
import { readPackageJson } from "app-builder-lib/out/util/packageMetadata.js";
import { NsisTarget } from "app-builder-lib/out/targets/nsis/NsisTarget.js";
import { NsisScriptGenerator } from "app-builder-lib/out/targets/nsis/nsisScriptGenerator.js";
import { computeLicensePage } from "app-builder-lib/out/targets/nsis/nsisLicense.js";
import { PlatformPackager } from "app-builder-lib/out/platformPackager.js";
import { getEffectiveOptions } from "app-builder-lib/out/options/CommonWindowsInstallerConfiguration.js";
import { gte } from "semver";

const metadata = await readPackageJson(resolve("package.json"));
const info = { metadata, config: metadata.build, buildResourcesDir: resolve("build") };
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
assert.equal(metadata.license, "SEE LICENSE IN LICENSE");
assert.equal(metadata.build.nsis.license, "LICENSE");
assert.equal(metadata.build.nsis.oneClick, false);
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
assert.equal(lock.packages[""].license, metadata.license);
assert.equal(lock.version, metadata.version);
assert.equal(lock.packages[""].version, metadata.version);
const legacy = await readFile("licenses/STAG-MIT-0.4.51.txt");
assert.equal(
  createHash("sha256").update(legacy).digest("hex"),
  "06e06305d903dd79a5bb7d0f8676404d87806a9660bb8252d1d46acd92bea671",
  "Preservar integralmente os termos MIT já publicados.",
);

await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/installer-credit-"));
try {
  const packager = {
    info,
    config: info.config,
    appInfo,
    projectDir: resolve("."),
    resourceList: Promise.resolve(await readdir(info.buildResourcesDir)),
    getResource: PlatformPackager.prototype.getResource,
    debugLogger: { isEnabled: false },
  };
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
  // Generate the license page from the production builder and the actual configured source.
  await computeLicensePage(packager, info.config.nsis, includes, ["pt_BR"]);
  await assert.rejects(
    computeLicensePage(
      packager,
      { ...info.config.nsis, license: join(dir, "missing-license.txt") },
      new NsisScriptGenerator(),
      ["pt_BR"],
    ),
    /cannot find specified resource/,
  );
  const file = join(dir, "welcome-fixture.exe");
  await target.executeMakensis(
    defines,
    { OutFile: `"${file}"` },
    `Unicode true
SetCompress off
Name "\${PRODUCT_NAME}"
${includes.build()}
!insertmacro customWelcomePage
!insertmacro licensePage
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
    "STAG Plus Proprietary License",
    "Previously released MIT material",
    "5fa5d9f3f89714dd293684ee8df33fa4a2ea061d",
  ])
    assert.ok(executable.includes(Buffer.from(text, "utf16le")), `Texto ausente: ${text}`);
  console.log("Boas-vindas NSIS compiladas com crédito e versão: OK");
  console.log("Licença proprietária compilada e MIT histórica preservada: OK");
} finally {
  await rm(dir, { recursive: true, force: true });
}

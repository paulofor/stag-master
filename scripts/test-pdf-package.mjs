import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { build } from "esbuild";
import { syntheticReaderPdf } from "../tests/fixtures/browser-pdf.mjs";
// Test the actual app.asar and native canvas shipped by electron-builder, not source dependencies.
const executable = process.argv[2]
  ? resolve(process.argv[2])
  : resolve("release/win-unpacked/STAG Plus.exe");
const worker = join(dirname(executable), "resources/app.asar/dist/main/pdf-worker.mjs");
const licenses = [
  { source: "LICENSE", installed: "LICENSE.txt" },
  { source: "licenses/STAG-MIT-0.4.51.txt", installed: "LICENSE-MIT-LEGACY.txt" },
];
const asarLicenseChecks = [];
for (const { source, installed } of licenses) {
  const expected = await readFile(source, "utf8");
  assert.equal(await readFile(join(dirname(executable), installed), "utf8"), expected);
  asarLicenseChecks.push(
    `assert.equal(require('node:fs').readFileSync(${JSON.stringify(join(dirname(executable), "resources/app.asar", source))},'utf8'),${JSON.stringify(expected)});`,
  );
}
await mkdir(".local", { recursive: true });
const root = await realpath(await mkdtemp(resolve(".local/pdf-package-test-")));
try {
  await writeFile(join(root, "documento.pdf"), syntheticReaderPdf());
  await build({
    entryPoints: ["src/main/pdf-reader.ts"],
    outfile: join(root, "reader.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await writeFile(
    join(root, "run.cjs"),
    `const assert=require('node:assert/strict'); ${asarLicenseChecks.join("\n")} const {PdfReader}=require('./reader.cjs'); (async()=>{const reader=new PdfReader(${JSON.stringify(worker)});for(const action of ['info','read','render']){const result=await reader.execute({action,path:'documento.pdf',...(action==='render'?{page:1}:{})},${JSON.stringify(root)});assert.equal(result.success,true);const data=JSON.parse(result.contentItems[0].text);assert.equal(data.totalPages,2);if(action==='read')assert.match(data.pages[0].text,/REQUISITO 10039/);if(action==='render'){assert.equal(data.image.width,800);assert.match(result.contentItems[1].imageUrl,/^data:image\\/jpeg;base64,/);}} console.log('PACKAGED_PDF_OK');})().catch(()=>{console.error('PACKAGED_PDF_FAILED');process.exitCode=1;});`,
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|NODE_OPTIONS/i.test(key),
    ),
  );
  const result = await promisify(execFile)(executable, [join(root, "run.cjs")], {
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
    timeout: 120000,
    windowsHide: true,
  });
  assert.match(result.stdout, /PACKAGED_PDF_OK/);
  console.log("Licenças empacotadas: arquivos externos e app.asar idênticos às fontes.");
  console.log(
    "Leitor PDF empacotado: app.asar, parser/worker, fontes e canvas nativo, info/read/render aprovados.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

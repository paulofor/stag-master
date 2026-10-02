import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createYargs,
  configureBuildCommand,
  normalizeOptions,
} from "electron-builder/out/builder.js";
import { Packager } from "app-builder-lib";
import { PublishManager } from "app-builder-lib/out/publish/PublishManager.js";
import { Arch } from "builder-util";

// Runs in a fresh process: the actual builder reads CI at module initialization.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const args = pkg.scripts["dist:win"].split("electron-builder")[1].trim().split(/\s+/);
const cli = configureBuildCommand(createYargs());
const options = normalizeOptions(cli.parse(args));
const packager = new Packager(options);
const manager = new PublishManager(packager, options);
const uploads = [];
// Only the upload boundary is replaced. Policy, CLI and artifact event are real.
manager.scheduleUpload = async (...upload) => {
  uploads.push(upload);
};
assert.equal(manager.isPublish, false, "CI must not enable implicit release publishing");
await packager.emitArtifactCreated({
  file: "STAG-0.1.0-Windows-x64-Setup.exe",
  arch: Arch.x64,
  packager: null,
  target: null,
  publishConfig: { provider: "github", owner: "fixture", repo: "fixture" },
});
await manager.awaitTasks();
assert.equal(uploads.length, 0);
console.log("Artefato local sem publisher ou token de release: OK");

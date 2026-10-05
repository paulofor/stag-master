import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

// The Codex sandbox must see the same isolated user config as the application main.
const executable = process.argv[3];
if (!executable || !isAbsolute(executable)) throw new Error("Probe Git exige executável absoluto.");
const result = spawnSync(executable, ["-C", process.argv[2], "status", "--short", "--branch"], {
  env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
  encoding: "utf8",
  windowsHide: true,
});
// Report only classification, never raw stderr, environment, repository output or credentials.
console.log(
  JSON.stringify({
    code: result.status,
    launchError: result.error?.code || null,
    dubiousOwnership: /detected dubious ownership/.test(result.stderr || ""),
  }),
);

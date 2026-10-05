import { spawnSync } from "node:child_process";

// The Codex sandbox must see the same isolated user config as the application main.
const result = spawnSync("git", ["-C", process.argv[2], "status", "--short", "--branch"], {
  env: { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" },
  encoding: "utf8",
  windowsHide: true,
});
if (result.error) throw new Error("Git de teste não iniciou no sandbox.");
console.log(JSON.stringify({ code: result.status }));

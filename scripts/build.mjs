import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { copyFile } from "node:fs/promises";
import { prepareCodex } from "./prepare-codex.mjs";
import { prepareMedia } from "./prepare-media.mjs";
await prepareCodex();
await prepareMedia();
await build({
  entryPoints: { index: "src/main/index.ts", preload: "src/main/preload.ts" },
  outdir: "dist/main",
  outExtension: { ".js": ".cjs" },
  platform: "node",
  target: "node22",
  format: "cjs",
  bundle: true,
  external: ["electron"],
  sourcemap: false,
});
await buildRenderer();
// ESM parser and its fixed production dependencies must remain available inside app.asar.
await copyFile("src/main/pdf-worker.mjs", "dist/main/pdf-worker.mjs");

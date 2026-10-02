import { build } from "esbuild";
import { build as buildRenderer } from "vite";
import { prepareCodex } from "./prepare-codex.mjs";
await prepareCodex();
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

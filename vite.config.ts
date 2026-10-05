import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  // Fixtures start subprocesses and exchange large frames; bound concurrency on shared runners.
  test: { include: ["tests/unit/**/*.test.ts"], testTimeout: 15000, maxWorkers: 2 },
});

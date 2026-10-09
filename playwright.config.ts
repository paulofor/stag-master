import { defineConfig, devices } from "@playwright/test";
import { createServer } from "node:net";

// A fixed shared port can silently test a different checkout and disappear when
// that job finishes. Workers inherit this run's port; Vite never reuses a server.
if (!process.env.STAG_E2E_PORT) {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Não foi possível reservar a porta do harness."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  process.env.STAG_E2E_PORT = String(port);
}
const port = Number(process.env.STAG_E2E_PORT);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Porta inválida para o harness.");
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 640, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" } },
  ],
  webServer: {
    command: `npm run dev:web -- --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});

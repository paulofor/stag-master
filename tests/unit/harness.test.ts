import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("recuperação do harness Electron", () => {
  it.each([false, true])(
    "preserva a causa da validação mesmo quando a limpeza falha: %s",
    async (cleanupFails) => {
      const { validateBrowser } = await import(
        pathToFileURL(resolve("scripts/test-browser.mjs")).href
      );
      const original = new Error("Falha sintética de navegação antes da limpeza");
      const cleanup = new Error("Conexão Electron sintética encerrada durante a limpeza");
      const application = {
        evaluate: vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(original),
      };
      if (cleanupFails) application.evaluate.mockRejectedValueOnce(cleanup);
      else application.evaluate.mockResolvedValueOnce(undefined);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          validateBrowser(application, "synthetic-harness", { effects: { submissions: 0 } }),
        ).rejects.toBe(original);
        expect(application.evaluate).toHaveBeenCalledTimes(3);
        expect(error).toHaveBeenCalledTimes(cleanupFails ? 1 : 0);
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    },
  );
});

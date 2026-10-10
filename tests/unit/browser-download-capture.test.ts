import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { DownloadItem, Event, WebContents } from "electron";
import { BrowserDownloadCapture } from "../../src/main/browser-download-capture";
import { browserUrl } from "../../src/main/browser-tools";

function fixture() {
  const contents = {} as WebContents;
  const controller = new AbortController();
  const progress = vi.fn(),
    check = vi.fn();
  const capture = new BrowserDownloadCapture({
    contents,
    signal: controller.signal,
    path: "private-stage/arquivo.part",
    source: "https://fixture.invalid/",
    progress,
    check,
    url: browserUrl,
  });
  const event = { preventDefault: vi.fn() } as unknown as Event;
  const item = Object.assign(new EventEmitter(), {
    getInitiatorOrigin: (): string => "https://fixture.invalid",
    getURLChain: () => ["blob:https://fixture.invalid/synthetic"],
    getTotalBytes: (): number => 100,
    getReceivedBytes: (): number => 100,
    getFilename: () => "fixture.xlsx",
    getMimeType: () => "application/octet-stream",
    setSavePath: vi.fn(),
    cancel: vi.fn(),
  });
  const accept = (wc = contents) => capture.accept(event, item as unknown as DownloadItem, wc);
  return { capture, contents, controller, progress, check, event, item, accept };
}

describe("recepção exclusiva da exportação nativa", () => {
  it("recusa outra janela, consome só um arquivo e ignora eventos antigos após conclusão", async () => {
    const f = fixture();
    const start = vi.fn(async () => {});
    const result = f.capture.run(start);
    expect(f.accept({} as WebContents)).toBe(false);
    expect(f.accept()).toBe(true);
    expect(f.accept()).toBe(false);
    expect(f.item.setSavePath).toHaveBeenCalledExactlyOnceWith("private-stage/arquivo.part");
    f.item.emit("done", {}, "completed");
    await expect(result).resolves.toMatchObject({ filename: "fixture.xlsx" });
    expect(f.accept()).toBe(false);
    f.controller.abort();
    expect(f.item.cancel).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });
  it.each(["origin", "blob", "downgrade", "protocol", "limit"])(
    "recusa %s sem definir caminho ou liberar diálogo",
    async (cause) => {
      const f = fixture();
      if (cause === "origin") f.item.getInitiatorOrigin = () => "https://other.invalid";
      if (cause === "blob") f.item.getURLChain = () => ["blob:https://other.invalid/id"];
      if (cause === "downgrade") f.item.getURLChain = () => ["http://fixture.invalid/file"];
      if (cause === "protocol") f.item.getURLChain = () => ["file:///private"];
      if (cause === "limit") f.item.getTotalBytes = () => 101 * 1024 * 1024;
      const result = f.capture.run(async () => {});
      expect(f.accept()).toBe(true);
      await expect(result).rejects.toThrow();
      expect(f.event.preventDefault).toHaveBeenCalledOnce();
      expect(f.item.setSavePath).not.toHaveBeenCalled();
    },
  );
  it.each(["cancel", "limit", "identity", "interrupted"])(
    "%s aguarda encerramento nativo antes da limpeza",
    async (cause) => {
      const f = fixture();
      let settled = false;
      const result = f.capture
        .run(async () => {})
        .finally(() => {
          settled = true;
        });
      expect(f.accept()).toBe(true);
      if (cause === "cancel") f.controller.abort();
      else {
        if (cause === "limit") f.item.getReceivedBytes = () => 101 * 1024 * 1024;
        if (cause === "identity")
          f.check.mockImplementation(() => {
            throw new Error("Pasta mudou");
          });
        f.item.emit("updated", {}, cause === "interrupted" ? "interrupted" : "progressing");
      }
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(f.item.cancel).toHaveBeenCalledOnce();
      f.item.emit("done", {}, "cancelled");
      await expect(result).rejects.toThrow();
      expect(settled).toBe(true);
    },
  );
  it("redirect inválido encerra a espera antes de seguir; falha não repete clique", async () => {
    const f = fixture();
    const start = vi.fn(async () => {});
    const result = f.capture.run(start);
    expect(f.capture.redirect(1, "https://fixture.invalid", "http://fixture.invalid")).toBe(false);
    await expect(result).rejects.toThrow("Redirecionamento");
    expect(start).toHaveBeenCalledOnce();
    expect(f.accept()).toBe(false);
    const next = fixture();
    next.controller.abort();
    const lateStart = vi.fn();
    await expect(next.capture.run(lateStart)).rejects.toThrow("cancelado");
    expect(lateStart).not.toHaveBeenCalled();
  });
});

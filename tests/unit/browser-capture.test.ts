import type { NativeImage, WebContents } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserCaptureError, captureBrowserPage } from "../../src/main/browser-capture";

const image = { isEmpty: () => false } as NativeImage;
function fixture() {
  const contents = {
    getBackgroundThrottling: vi.fn(() => true),
    setBackgroundThrottling: vi.fn(),
    isDestroyed: vi.fn(() => false),
    invalidate: vi.fn(),
    capturePage: vi.fn<() => Promise<NativeImage>>().mockResolvedValue(image),
  };
  const controller = new AbortController();
  const check = vi.fn();
  return {
    contents,
    controller,
    check,
    capture: () => captureBrowserPage(contents as unknown as WebContents, controller.signal, check),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["UnknownVizError", "VizSentEmptyBitmap", "Frame Gone", "EmbeddingTokenChanged"])(
  "recupera %s com leitura limitada, sem mostrar/acordar a janela",
  async (message) => {
    const f = fixture();
    f.contents.capturePage.mockRejectedValueOnce(new Error(message));
    const result = f.capture();
    await vi.advanceTimersByTimeAsync(249);
    expect(f.contents.capturePage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe(image);
    expect(f.contents.capturePage).toHaveBeenCalledTimes(2);
    expect(f.contents.capturePage).toHaveBeenLastCalledWith(undefined, {
      stayHidden: false,
      stayAwake: false,
    });
    expect(f.contents.setBackgroundThrottling.mock.calls).toEqual([[false], [true]]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["UnknownVizError", "empty"])(
  "recusa falha persistente %s após três tentativas",
  async (kind) => {
    const f = fixture();
    if (kind === "empty")
      f.contents.capturePage.mockResolvedValue({ isEmpty: () => true } as NativeImage);
    else f.contents.capturePage.mockRejectedValue(new Error(kind));
    const result = f.capture().catch((error) => error.message);
    await vi.runAllTimersAsync();
    expect(await result).toBe(browserCaptureError);
    expect(f.contents.capturePage).toHaveBeenCalledTimes(3);
    expect(f.contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["SYNTHETIC_SECRET https://private.invalid", "Timeout", "Unknown"])(
  "não repete falha desconhecida nem publica o payload %s",
  async (message) => {
    const f = fixture();
    f.contents.capturePage.mockRejectedValue(new Error(message));
    await expect(f.capture()).rejects.toThrow(browserCaptureError);
    expect(f.contents.capturePage).toHaveBeenCalledTimes(1);
    expect(f.contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  },
);

it("cancelar durante espera remove o timer sem outra tentativa", async () => {
  const f = fixture();
  f.contents.capturePage.mockRejectedValue(new Error("UnknownVizError"));
  const result = f.capture().catch((error) => error.message);
  await vi.advanceTimersByTimeAsync(100);
  expect(vi.getTimerCount()).toBe(1);
  f.controller.abort();
  expect(await result).toMatch(/cancelada/);
  expect(vi.getTimerCount()).toBe(0);
  await vi.runAllTimersAsync();
  expect(f.contents.capturePage).toHaveBeenCalledTimes(1);
});

it("cancelar captura pendente responde sem esperar pixels antigos nem repetir", async () => {
  const f = fixture();
  let release!: (value: NativeImage) => void;
  f.contents.capturePage.mockReturnValue(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const result = f.capture().catch((error) => error.message);
  f.controller.abort();
  expect(await result).toMatch(/cancelada/);
  release(image);
  await vi.runAllTimersAsync();
  expect(f.contents.capturePage).toHaveBeenCalledTimes(1);
  expect(f.contents.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
});

it("não inicia captura cancelada nem sobre página com carga falha", async () => {
  const f = fixture();
  f.controller.abort();
  await expect(f.capture()).rejects.toThrow(/cancelada/);
  const other = fixture();
  other.check.mockImplementation(() => {
    throw new Error("Certificado HTTPS não confiável");
  });
  await expect(other.capture()).rejects.toThrow(/Certificado/);
  expect(f.contents.capturePage).not.toHaveBeenCalled();
  expect(other.contents.capturePage).not.toHaveBeenCalled();
});

it("restaura a configuração anterior e não acessa conteúdo destruído", async () => {
  const f = fixture();
  f.contents.getBackgroundThrottling.mockReturnValue(false);
  await f.capture();
  expect(f.contents.setBackgroundThrottling.mock.calls).toEqual([[false], [false]]);
  const other = fixture();
  other.contents.capturePage.mockImplementation(async () => {
    other.contents.isDestroyed.mockReturnValue(true);
    other.controller.abort();
    return image;
  });
  await expect(other.capture()).rejects.toThrow(/cancelada/);
  expect(other.contents.setBackgroundThrottling.mock.calls).toEqual([[false]]);
});

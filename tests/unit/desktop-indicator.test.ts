import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "electron";
import { createDesktopControl, DesktopControlIndicator } from "../../src/main/desktop-indicator";

const native = vi.hoisted(() => ({
  windows: [] as any[],
  displays: [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
    { bounds: { x: -1280, y: -200, width: 1280, height: 1024 }, scaleFactor: 1 },
  ],
  load: vi.fn<() => Promise<void>>(),
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  class Window extends EventEmitter {
    destroyed = false;
    bounds: Electron.Rectangle;
    setBounds = vi.fn((bounds: Electron.Rectangle) => {
      this.bounds = { ...bounds };
    });
    showInactive = vi.fn();
    setEnabled = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      },
    });
    constructor(public options: Electron.BrowserWindowConstructorOptions) {
      super();
      // Chromium's initial widget placement may constrain a transparent window to workArea.
      this.bounds = {
        x: options.x!,
        y: options.y!,
        width: options.width!,
        height: options.height! - 48,
      };
      native.windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy = vi.fn(() => {
      this.destroyed = true;
      this.emit("closed");
    });
    loadURL = vi.fn(async (_url: string) => native.load());
  }
  return {
    BrowserWindow: Window,
    screen: Object.assign(new EventEmitter(), { getAllDisplays: () => native.displays }),
  };
});

let indicator: DesktopControlIndicator;
beforeEach(() => {
  vi.clearAllMocks();
  native.windows = [];
  native.load.mockResolvedValue();
  indicator = new DesktopControlIndicator("win32");
});
afterEach(() => {
  indicator.dispose();
  expect(native.windows.every((window) => window.destroyed)).toBe(true);
  expect(screen.listenerCount("display-added")).toBe(0);
  expect(screen.listenerCount("display-removed")).toBe(0);
  expect(screen.listenerCount("display-metrics-changed")).toBe(0);
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("indicador Windows durante a operação", () => {
  it("mostra bordas por monitor sem foco/entrada, conserva o resultado e destrói ao concluir", async () => {
    const wait = gate();
    const execute = vi.fn(async () => {
      await wait.promise;
      return "resultado";
    });
    expect(native.windows).toHaveLength(0);
    const work = indicator.run(execute);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      expect(native.windows).toHaveLength(2);
      for (const [index, window] of native.windows.entries()) {
        expect(window.options).toMatchObject({
          ...native.displays[index].bounds,
          transparent: true,
          frame: false,
          focusable: false,
          skipTaskbar: true,
          show: false,
          hasShadow: false,
          webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            javascript: false,
          },
        });
        expect(window.options.webPreferences).not.toHaveProperty("preload");
        expect(window.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true);
        expect(window.setEnabled).toHaveBeenCalledExactlyOnceWith(false);
        expect(window.showInactive).toHaveBeenCalledOnce();
        expect(window.bounds).toEqual(native.displays[index].bounds);
        const html = decodeURIComponent(window.loadURL.mock.calls[0][0].split(",")[1]);
        expect(html).toContain("STAG controlando o Windows");
        expect(html).toContain("prefers-reduced-motion");
        expect(html).not.toMatch(/<script|https?:\/\//);
        const event = { preventDefault: vi.fn() };
        window.webContents.emit("will-navigate", event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({
          action: "deny",
        });
        const callback = vi.fn();
        window.webContents.session.webRequest.onBeforeRequest.mock.calls[0][1]({}, callback);
        expect(callback).toHaveBeenCalledWith({ cancel: true });
      }
    } finally {
      wait.release();
      await work;
    }
    await expect(work).resolves.toBe("resultado");
  });

  it("não cria camada fora do Windows", async () => {
    const other = new DesktopControlIndicator("linux");
    await expect(other.run(async () => 42)).resolves.toBe(42);
    expect(native.windows).toHaveLength(0);
  });

  it("remove o efeito em erro e permite a próxima ação", async () => {
    await expect(
      indicator.run(async () => {
        throw new Error("falha nativa");
      }),
    ).rejects.toThrow("falha nativa");
    expect(native.windows.every((window) => window.destroyed)).toBe(true);
    await expect(indicator.run(async () => "recuperado")).resolves.toBe("recuperado");
  });

  it("cancela antes da carga sem iniciar a ação ou reaparecer depois", async () => {
    const wait = gate();
    native.load.mockReturnValue(wait.promise);
    const execute = vi.fn(async () => "proibido");
    const work = indicator.run(execute);
    indicator.cancel();
    expect(native.windows.every((window) => window.destroyed)).toBe(true);
    wait.release();
    await expect(work).rejects.toThrow("interrompida");
    expect(execute).not.toHaveBeenCalled();
    expect(native.windows.every((window) => window.showInactive.mock.calls.length === 0)).toBe(
      true,
    );
  });

  it("remove imediatamente, aguarda limpeza e descarta resultado após cancelar", async () => {
    const wait = gate();
    let signal!: AbortSignal;
    const work = indicator.run(async (received) => {
      signal = received;
      await wait.promise;
      return "antigo";
    });
    await vi.waitFor(() => expect(signal).toBeDefined());
    indicator.cancel();
    expect(signal.aborted).toBe(true);
    expect(native.windows.every((window) => window.destroyed)).toBe(true);
    await expect(indicator.run(async () => "sobreposta")).rejects.toThrow("anterior");
    wait.release();
    await expect(work).rejects.toThrow("interrompida");
    await expect(indicator.run(async () => "nova")).resolves.toBe("nova");
  });

  it.each(["display-added", "display-removed", "display-metrics-changed"])(
    "cancela quando %s invalida os bounds",
    async (event) => {
      await expect(
        indicator.run(async (signal) => {
          screen.emit(event, {});
          expect(signal.aborted).toBe(true);
          expect(native.windows.every((window) => window.destroyed)).toBe(true);
        }),
      ).rejects.toThrow("interrompida");
      await expect(indicator.run(async () => "nova topologia")).resolves.toBe("nova topologia");
    },
  );

  it.each(["closed", "render-process-gone"])(
    "interrompe a ação se o indicador receber %s",
    async (event) => {
      await expect(
        indicator.run(async (signal) => {
          const window = native.windows[0];
          if (event === "closed") window.destroy();
          else window.webContents.emit(event, {}, { reason: "crashed" });
          expect(signal.aborted).toBe(true);
        }),
      ).rejects.toThrow("interrompida");
    },
  );

  it("falha fechada e mensagem fixa quando a camada não carrega; recupera", async () => {
    native.load.mockRejectedValueOnce(new Error("synthetic-private-url"));
    const execute = vi.fn(async () => "proibido");
    await expect(indicator.run(execute)).rejects.toThrow("A ação não foi executada");
    expect(execute).not.toHaveBeenCalled();
    await expect(indicator.run(async () => "nova")).resolves.toBe("nova");
  });

  it("propaga cancelamento externo do movimento e não transfere autorização após dispose", async () => {
    const controller = new AbortController();
    await expect(
      indicator.run(async (signal) => {
        controller.abort();
        expect(signal.aborted).toBe(true);
      }, controller.signal),
    ).rejects.toThrow("interrompida");
    indicator.dispose();
    await expect(indicator.run(async () => "proibido")).rejects.toThrow("encerrado");
  });
});

describe("integração de produção com o desktop", () => {
  it("cancelamento enquanto o painel se oculta não inicia entrada e restaura sem foco", async () => {
    const driver = {
      execute: vi.fn(async () => ({ success: true, contentItems: [] })),
      confirmationReason: vi.fn(async () => null),
      cancel: vi.fn(),
      pulseCursor: vi.fn(async () => ({ moved: true })),
    };
    const host = {
      isDestroyed: () => false,
      isVisible: () => true,
      hide: vi.fn(),
      showInactive: vi.fn(),
    };
    const control = createDesktopControl(host, driver, indicator);
    const work = control.execute({ action: "screenshot", processId: 42 });
    await vi.waitFor(() => expect(host.hide).toHaveBeenCalledOnce());
    control.cancel();
    await expect(work).rejects.toThrow("interrompida");
    expect(driver.execute).not.toHaveBeenCalled();
    expect(host.showInactive).toHaveBeenCalledOnce();
  });
  it("inspeção/argumentos inválidos não mostram indicador; execução recebe sinal e aprovação", async () => {
    const driver = {
      execute: vi.fn(async () => ({ success: true, contentItems: [] })),
      confirmationReason: vi.fn(async () => "confirme"),
      cancel: vi.fn(),
      pulseCursor: vi.fn(async () => ({ moved: true })),
    };
    const control = createDesktopControl(null, driver, indicator);
    const input = { action: "focus_window", processId: 42 };
    await expect(control.confirmationReason(input)).resolves.toBe("confirme");
    expect(native.windows).toHaveLength(0);
    expect(() => control.execute({ ...input, stagCriticalApproved: true })).toThrow();
    expect(native.windows).toHaveLength(0);
    await control.execute(input, true);
    expect(driver.execute).toHaveBeenCalledExactlyOnceWith(input, true, expect.any(AbortSignal));
    control.dispose();
    expect(driver.cancel).toHaveBeenCalledOnce();
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { emptySnapshot, type Approval, type Snapshot } from "../../src/shared/types";
import { attentionIcon, TaskbarAttention, waitingTitle } from "../../src/main/taskbar-attention";

vi.mock("electron", () => ({
  nativeImage: { createFromBitmap: (pixels: Buffer, options: unknown) => ({ pixels, options }) },
}));

class Window extends EventEmitter {
  focused = false;
  minimized = true;
  visible = true;
  destroyed = false;
  isFocused = () => this.focused;
  isMinimized = () => this.minimized;
  isVisible = () => this.visible;
  isDestroyed = () => this.destroyed;
  flashFrame = vi.fn();
  setOverlayIcon = vi.fn();
  setTitle = vi.fn();
}

const approval = (kind: Approval["kind"] = "questions", id = "pending"): Approval => ({
  id,
  kind,
  title: "Dado sintético privado",
  detail: "Nunca deve ir à barra de tarefas",
});
const state = (approvals: Approval[] = [], patch: Partial<Snapshot> = {}): Snapshot => ({
  ...structuredClone(emptySnapshot),
  connection: "ready",
  threadId: "thread-synthetic",
  busy: true,
  approvals,
  ...patch,
});
function setup(platform: NodeJS.Platform = "win32") {
  const window = new Window();
  const sound = { play: vi.fn(), stop: vi.fn(), settled: vi.fn(async () => {}) };
  const controller = new TaskbarAttention(window as unknown as BrowserWindow, platform, sound);
  return { window, controller, sound };
}

describe("Som de conclusão do trabalho", () => {
  it("usa o vínculo de produção para snapshots, conclusão e parada", () => {
    const { controller, sound } = setup();
    const source = new EventEmitter();
    controller.bind(source);
    source.emit("snapshot", state());
    source.emit("workCompleted", { threadId: "thread-synthetic" });
    expect(sound.play).not.toHaveBeenCalled();
    source.emit("snapshot", state([], { busy: false }));
    source.emit("workCompleted", { threadId: "thread-synthetic" });
    expect(sound.play).toHaveBeenCalledOnce();
    const before = sound.stop.mock.calls.length;
    source.emit("workStopped");
    expect(sound.stop).toHaveBeenCalledTimes(before + 1);
    controller.dispose();
    expect(source.eventNames()).toEqual([]);
  });

  it("desvincula o serviço anterior e não mantém listeners depois de fechar", () => {
    const { controller, sound } = setup();
    const previous = new EventEmitter();
    const current = new EventEmitter();
    controller.bind(previous);
    controller.bind(current);
    expect(previous.eventNames()).toEqual([]);
    current.emit("snapshot", state([], { busy: false }));
    previous.emit("workCompleted", { threadId: "thread-synthetic" });
    expect(sound.play).not.toHaveBeenCalled();
    current.emit("workCompleted", { threadId: "thread-synthetic" });
    expect(sound.play).toHaveBeenCalledOnce();
    controller.dispose();
    controller.bind(current);
    expect(current.eventNames()).toEqual([]);
  });
  it.each([true, false])(
    "toca também com janela minimizada=%s sem indicação de espera",
    (minimized) => {
      const { window, controller, sound } = setup();
      window.minimized = minimized;
      window.focused = !minimized;
      controller.update(state([], { busy: false }));
      controller.completed("thread-synthetic");
      controller.update(state([], { busy: false }));
      window.emit("blur");
      expect(sound.play).toHaveBeenCalledOnce();
      expect(window.setOverlayIcon).not.toHaveBeenCalled();
      expect(window.flashFrame).not.toHaveBeenCalled();
      expect(window.setTitle).not.toHaveBeenCalled();
    },
  );

  it.each([
    { busy: true },
    { connection: "disconnected" as const },
    { threadId: "other-thread" },
    { approvals: [approval()] },
    { queuedMessages: [{ id: "q", text: "synthetic", status: "pending" as const }] },
  ])("recusa conclusão antiga ou durante trabalho/espera: %j", (patch) => {
    const { controller, sound } = setup();
    controller.update(state([], { busy: false, ...patch }));
    const before = sound.play.mock.calls.length;
    controller.completed("thread-synthetic");
    expect(sound.play).toHaveBeenCalledTimes(before);
  });

  it("interrompe com novo trabalho, foco, parada e troca; conclusão posterior pode tocar", () => {
    const { window, controller, sound } = setup();
    controller.update(state([], { busy: false }));
    controller.completed("thread-synthetic");
    const before = sound.stop.mock.calls.length;
    controller.update(state());
    expect(sound.stop).toHaveBeenCalledTimes(before + 1);
    controller.update(state([], { busy: false }));
    controller.completed("thread-synthetic");
    window.focused = true;
    window.minimized = false;
    window.emit("focus");
    expect(sound.stop).toHaveBeenCalledTimes(before + 2);
    controller.stopSound();
    expect(sound.stop).toHaveBeenCalledTimes(before + 3);
    controller.update(state([], { busy: false, threadId: "other-thread" }));
    expect(sound.stop).toHaveBeenCalledTimes(before + 4);
    controller.completed("thread-synthetic");
    expect(sound.play).toHaveBeenCalledTimes(2);
    controller.completed("other-thread");
    expect(sound.play).toHaveBeenCalledTimes(3);
    controller.dispose();
    controller.completed("other-thread");
    expect(sound.play).toHaveBeenCalledTimes(3);
  });

  it("preserva som da pergunta e toca novamente somente na conclusão ociosa", () => {
    const { window, controller, sound } = setup();
    controller.update(state([approval()]));
    controller.completed("thread-synthetic");
    expect(sound.play).toHaveBeenCalledOnce();
    controller.update(state());
    controller.update(state([], { busy: false }));
    controller.completed("thread-synthetic");
    expect(sound.play).toHaveBeenCalledTimes(2);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
  });

  it("não toca no Linux, em janela destruída ou depois do fechamento", () => {
    for (const platform of ["linux", "win32"] as const) {
      const { window, controller, sound } = setup(platform);
      controller.update(state([], { busy: false }));
      if (platform === "win32") window.destroyed = true;
      controller.completed("thread-synthetic");
      window.emit("closed");
      controller.completed("thread-synthetic");
      expect(sound.play).not.toHaveBeenCalled();
    }
  });
});

describe("Aviso de espera do usuário na barra de tarefas", () => {
  it.each(["questions", "command", "file", "desktop", "browser"] as const)(
    "indica %s em todos os modos sem dados privados",
    (kind) => {
      for (const mode of ["project", "read", "windows"] as const) {
        const { window, controller, sound } = setup();
        controller.update(state([approval(kind)], { mode }));
        expect(window.setTitle).toHaveBeenLastCalledWith(waitingTitle);
        expect(window.setOverlayIcon).toHaveBeenCalledWith(
          expect.anything(),
          "Aguardando sua resposta ou autorização",
        );
        expect(window.flashFrame).toHaveBeenLastCalledWith(true);
        expect(sound.play).toHaveBeenCalledOnce();
        expect(JSON.stringify(window.setOverlayIcon.mock.calls)).not.toContain("privado");
        controller.dispose();
      }
    },
  );

  it("mantém o sinal até a última pendência e não reinicia destaque em deltas/reload", () => {
    const { window, controller, sound } = setup();
    controller.update(state([approval(), approval("command", "second")]));
    controller.update(state([approval("command", "second")]));
    controller.update(state([approval("command", "second")]));
    expect(window.flashFrame).toHaveBeenCalledTimes(1);
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    expect(sound.play).toHaveBeenCalledOnce();
    controller.update(state());
    expect(sound.stop).toHaveBeenCalledTimes(2);
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    expect(window.setTitle).toHaveBeenLastCalledWith("STAG Plus");
    controller.update(state([approval()]));
    expect(sound.play).toHaveBeenCalledTimes(2);
    expect(window.flashFrame).toHaveBeenLastCalledWith(true);
  });

  it("focar reconhece o destaque mas não resolve a solicitação", () => {
    const { window, controller, sound } = setup();
    controller.update(state([approval()]));
    window.focused = true;
    window.minimized = false;
    window.emit("focus");
    expect(sound.stop).toHaveBeenCalledTimes(2);
    expect(window.flashFrame).toHaveBeenLastCalledWith(false);
    expect(window.setOverlayIcon).toHaveBeenCalledTimes(1);
    window.focused = false;
    window.emit("blur");
    controller.update(state([approval()]));
    expect(sound.play).toHaveBeenCalledOnce();
    expect(window.flashFrame).toHaveBeenLastCalledWith(true);
  });

  it("pergunta em primeiro plano só destaca quando a janela fica oculta ou minimizada", () => {
    const { window, controller, sound } = setup();
    window.focused = true;
    window.minimized = false;
    controller.update(state([approval()]));
    expect(sound.play).toHaveBeenCalledOnce();
    expect(window.flashFrame).not.toHaveBeenCalled();
    window.visible = false;
    window.emit("hide");
    expect(window.flashFrame).toHaveBeenLastCalledWith(true);
  });

  it.each(["disconnected", "connecting", "error"] as const)(
    "limpa ao ficar %s apesar de snapshot com pendências",
    (connection) => {
      const { window, controller, sound } = setup();
      controller.update(state([approval()]));
      controller.update(state([approval()], { connection }));
      expect(sound.stop).toHaveBeenCalledTimes(2);
      expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
      expect(window.flashFrame).toHaveBeenLastCalledWith(false);
    },
  );

  it("não marca trabalho comum, fila, histórico ou consentimento sem pedido pendente", () => {
    const { window, controller, sound } = setup();
    controller.update(state());
    controller.update(
      state([], {
        busy: false,
        queuePaused: true,
        queuedMessages: [{ id: "q", text: "synthetic", status: "pending" }],
      }),
    );
    controller.update(state([approval()], { threadId: null }));
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
    expect(window.flashFrame).not.toHaveBeenCalled();
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("limpa ao encerrar e não reage após descarte ou janela destruída", () => {
    const { window, controller, sound } = setup();
    controller.update(state([approval()]));
    controller.dispose();
    expect(sound.stop).toHaveBeenCalledTimes(2);
    expect(window.setOverlayIcon).toHaveBeenLastCalledWith(null, "");
    expect(window.eventNames()).toHaveLength(0);
    vi.clearAllMocks();
    controller.dispose();
    controller.update(state([approval()]));
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
    expect(sound.play).not.toHaveBeenCalled();
    const other = setup();
    other.window.destroyed = true;
    other.window.emit("closed");
    other.controller.update(state([approval()]));
    expect(other.window.setTitle).not.toHaveBeenCalled();
    expect(other.window.eventNames()).toHaveLength(0);
  });

  it("não chama APIs exclusivas do Windows em Linux", () => {
    const { window, controller, sound } = setup("linux");
    controller.update(state([approval()]));
    expect(window.setTitle).toHaveBeenLastCalledWith(waitingTitle);
    controller.dispose();
    expect(window.setOverlayIcon).not.toHaveBeenCalled();
    expect(sound.play).not.toHaveBeenCalled();
  });

  it("interrompe a conversa anterior mesmo se outra já contém pendências", () => {
    const { controller, sound } = setup();
    controller.update(state([approval()]));
    controller.update(state([approval()], { threadId: "other-thread" }));
    expect(sound.stop).toHaveBeenCalledTimes(2);
    expect(sound.play).toHaveBeenCalledTimes(2);
    expect(sound.stop.mock.invocationCallOrder[1]).toBeLessThan(
      sound.play.mock.invocationCallOrder[1],
    );
    controller.update(state([approval()], { threadId: "other-thread" }));
    expect(sound.play).toHaveBeenCalledTimes(2);
  });

  it("aguarda a limpeza do áudio antes de concluir o encerramento", async () => {
    const { controller, sound } = setup();
    let close!: () => void;
    sound.settled.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          close = resolve;
        }),
    );
    controller.update(state([approval()]));
    controller.dispose();
    let done = false;
    const work = controller.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    close();
    await work;
    expect(done).toBe(true);
  });

  it("preserva o título após atualização da página", () => {
    const { window, controller } = setup();
    controller.update(state([approval()]));
    const event = { preventDefault: vi.fn() };
    window.emit("page-title-updated", event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("gera imagem fixa, transparente com círculo âmbar e exclamação branca", () => {
    const icon = attentionIcon() as unknown as { pixels: Buffer; options: unknown };
    expect(icon.options).toEqual({ width: 16, height: 16, scaleFactor: 1 });
    const pixel = (x: number, y: number) => [
      ...icon.pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4),
    ];
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(3, 8)).toEqual([6, 119, 217, 255]);
    expect(pixel(7, 5)).toEqual([255, 255, 255, 255]);
    expect(pixel(7, 11)).toEqual([255, 255, 255, 255]);
  });
});

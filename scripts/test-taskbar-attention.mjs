import assert from "node:assert/strict";
import { build } from "esbuild";
import { join } from "node:path";
import { expect } from "@playwright/test";

export async function buildTaskbarHarness(dir) {
  await build({
    entryPoints: ["src/main/taskbar-attention.ts"],
    outfile: join(dir, "taskbar-attention.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
}

// Observe and forward the actual native APIs, installed only in the isolated test boot.
export function installTaskbarProbe(BrowserWindow) {
  global.taskbarCalls = [];
  for (const method of ["flashFrame", "setOverlayIcon"]) {
    const original = BrowserWindow.prototype[method];
    if (!original) continue;
    BrowserWindow.prototype[method] = function (...args) {
      global.taskbarCalls.push({
        id: this.id,
        method,
        value: method === "flashFrame" ? args[0] : args[0] !== null,
        description: method === "setOverlayIcon" ? args[1] : "",
      });
      return original.apply(this, args);
    };
  }
}

export async function validateTaskbarAttention(application, page) {
  const before = await page.evaluate(() => window.stag.getSnapshot());
  const result = await application.evaluate(async ({ BrowserWindow }) => {
    const { TaskbarAttention, attentionIcon, waitingTitle } = global.TaskbarHarness;
    const icon = attentionIcon();
    const pixels = icon.toBitmap();
    const pixel = (x, y) => [...pixels.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4)];
    const host = BrowserWindow.getAllWindows().find((win) =>
      win.webContents.getURL().startsWith("stag://app/"),
    );
    const focusedBefore = host.isFocused();
    const target = new BrowserWindow({
      show: false,
      title: "STAG synthetic attention",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const attention = new TaskbarAttention(target);
    const state = {
      connection: "ready",
      threadId: "synthetic",
      approvals: [{ id: "q", kind: "questions" }],
    };
    try {
      await target.loadURL("data:text/html,<title>Synthetic page</title><p>Synthetic question</p>");
      attention.update(state);
      const title = target.getTitle();
      const hidden = !target.isVisible();
      attention.update(state);
      attention.update({ ...state, approvals: [{ id: "second", kind: "command" }] });
      const started = global.taskbarCalls.filter((call) => call.id === target.id);
      attention.update({ ...state, approvals: [] });
      const cleared = target.getTitle();
      attention.update(state);
      const focusedPreserved = host.isFocused() === focusedBefore;
      let nativeFocus = null;
      if (process.platform === "win32") {
        const waitFor = async (condition) => {
          const deadline = Date.now() + 30000;
          while (!condition()) {
            if (Date.now() >= deadline)
              throw new Error("Janela sintética não concluiu foco/minimização.");
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
        // These actions simulate the user; the controller never shows/restores/focuses windows.
        target.show();
        target.focus();
        await waitFor(() => target.isFocused());
        target.minimize();
        await waitFor(() => target.isMinimized());
        attention.update(state);
        const minimized = target.isMinimized();
        const minimizedCalls = global.taskbarCalls.filter(
          (call) => call.id === target.id && call.method === "flashFrame",
        );
        target.restore();
        target.focus();
        await waitFor(
          () =>
            target.isFocused() &&
            !target.isMinimized() &&
            global.taskbarCalls
              .filter((call) => call.id === target.id && call.method === "flashFrame")
              .at(-1)?.value === false,
        );
        const focusedCalls = global.taskbarCalls.filter(
          (call) => call.id === target.id && call.method === "flashFrame",
        );
        nativeFocus = {
          minimized,
          flashingMinimized: minimizedCalls.at(-1).value,
          flashingFocused: focusedCalls.at(-1).value,
          title: target.getTitle(),
        };
      }
      attention.dispose();
      const calls = global.taskbarCalls.filter((call) => call.id === target.id);
      return {
        size: icon.getSize(),
        corner: pixel(0, 0),
        amber: pixel(3, 8),
        mark: pixel(7, 5),
        title,
        waitingTitle,
        hidden,
        cleared,
        started,
        calls,
        focusedPreserved,
        nativeFocus,
      };
    } finally {
      attention.dispose();
      target.destroy();
    }
  });
  assert.deepEqual(result.size, { width: 16, height: 16 });
  assert.equal(result.corner[3], 0);
  assert.deepEqual(result.amber, [6, 119, 217, 255]);
  assert.deepEqual(result.mark, [255, 255, 255, 255]);
  assert.equal(result.title, result.waitingTitle);
  assert.equal(result.cleared, "STAG");
  assert.ok(result.hidden && result.focusedPreserved, "O aviso não mostra a janela nem toma foco.");
  assert.equal(
    result.started.filter((call) => call.method === "flashFrame" && call.value).length,
    1,
  );
  assert.equal(result.calls.at(-1).value, false);
  if (process.platform === "win32") {
    assert.deepEqual(result.nativeFocus, {
      minimized: true,
      flashingMinimized: true,
      flashingFocused: false,
      title: result.waitingTitle,
    });
    assert.equal(
      result.started.filter((call) => call.method === "setOverlayIcon" && call.value).length,
      1,
    );
    assert.equal(result.calls.at(-1).method, "setOverlayIcon");
    assert.equal(result.calls.at(-1).description, "");
  }
  assert.deepEqual(await page.evaluate(() => window.stag.getSnapshot()), before);
  console.log(
    "Barra de tarefas: NativeImage real, APIs de produção, ausência de foco/ativação, espera, deduplicação, resolução e descarte conferidos.",
  );
}

export async function validateTaskbarService(application, page) {
  const title = () =>
    application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.webContents.getURL().startsWith("stag://app/"))
        .getTitle(),
    );
  const request = (action) => page.evaluate((action) => window.stag.request(action), action);
  await request({ type: "newChat" });
  await request({ type: "send", text: "perguntar sobre stack do projeto sintético" });
  await expect.poll(title).toBe("STAG — Aguardando sua resposta");
  let snapshot = await page.evaluate(() => window.stag.getSnapshot());
  assert.equal(snapshot.approvals[0].kind, "questions");
  await page.reload();
  await expect(page.getByRole("region", { name: "Solicitação do assistente" })).toBeVisible();
  await expect.poll(title).toBe("STAG — Aguardando sua resposta");
  await request({ type: "answer", id: snapshot.approvals[0].id, answers: { stack: "TypeScript" } });
  await expect.poll(title).toBe("STAG");
  await expect
    .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
    .toBe(false);
  for (const accept of [false, true]) {
    await request({ type: "send", text: "aprovar validação sintética do projeto" });
    await expect.poll(title).toBe("STAG — Aguardando sua resposta");
    snapshot = await page.evaluate(() => window.stag.getSnapshot());
    assert.equal(snapshot.approvals[0].kind, "command");
    await request({ type: "answer", id: snapshot.approvals[0].id, accept });
    await expect.poll(title).toBe("STAG");
    await expect
      .poll(() => page.evaluate(async () => (await window.stag.getSnapshot()).busy))
      .toBe(false);
  }
  await request({ type: "send", text: "perguntar sobre stack para parar" });
  await expect.poll(title).toBe("STAG — Aguardando sua resposta");
  await request({ type: "stop" });
  await expect.poll(title).toBe("STAG");
  await request({ type: "newChat" });
  await expect.poll(title).toBe("STAG");
  console.log(
    "Espera ponta a ponta: request de pergunta, reload, resposta, aprovação, recusa, parada e conversa nova com fixture bidirecional OK.",
  );
}

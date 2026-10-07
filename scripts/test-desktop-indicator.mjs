import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect } from "@playwright/test";

export async function buildDesktopIndicatorHarness(dir) {
  await build({
    entryPoints: ["src/main/desktop-indicator.ts", "src/main/desktop-tools.ts"],
    outdir: dir,
    outExtension: { ".js": ".cjs" },
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
}

export async function validateDesktopIndicator(application, page) {
  const before = await page.evaluate(() => window.stag.getSnapshot());
  await application.evaluate(async ({ BrowserWindow, screen }) => {
    const host = BrowserWindow.getAllWindows()[0];
    const target = new BrowserWindow({
      ...screen.getPrimaryDisplay().bounds,
      title: "STAG synthetic indicator target",
      frame: false,
      show: false,
      enableLargerThanScreen: true,
      backgroundColor: "#f5f4f1",
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    await target.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><title>STAG synthetic indicator target</title><style>body{background:#f5f4f1;margin:0}button{position:fixed;left:1px;top:45%;height:42px}input{margin:80px}</style><button onclick="this.textContent=\'Clicado\'">Alvo sintético</button><input aria-label="Texto sintético">')}`,
    );
    // Keep the synthetic target above the taskbar so all four monitor-edge hit tests
    // refer to fixture content. The later indicator is still on top of this window.
    target.setAlwaysOnTop(true, "screen-saver");
    host.minimize();
    // Xvfb without a window manager cannot iconify. Exercise an actually hidden host there;
    // Windows still requires native minimization, rather than pretending the request succeeded.
    if (process.platform === "linux" && !host.isMinimized()) host.hide();
    target.show();
    target.setBounds(screen.getPrimaryDisplay().bounds);
    target.focus();
    const indicator = new global.DesktopIndicatorHarness.DesktopControlIndicator("win32");
    const harness = {
      host,
      target,
      indicator,
      executions: 0,
      inspections: 0,
      canceled: 0,
      phase: "idle",
      outcome: "",
      signal: null,
      release: null,
    };
    const execute = async (_input, _approved, signal) => {
      signal.throwIfAborted();
      harness.executions++;
      harness.signal = signal;
      harness.phase = "running";
      // Keep cleanup separate from cancellation, exactly as the native driver waits for close.
      await new Promise((resolve) => {
        harness.release = resolve;
      });
      harness.phase = "idle";
      return { success: true, contentItems: [] };
    };
    harness.control = global.DesktopIndicatorHarness.createDesktopControl(
      host,
      {
        execute,
        confirmationReason: async () => {
          harness.inspections++;
          return "confirme";
        },
        cancel: () => {
          harness.canceled++;
        },
        pulseCursor: (signal) => execute(null, false, signal).then(() => ({ moved: true })),
      },
      indicator,
    );
    global.desktopIndicatorHarness = harness;
    await harness.control.confirmationReason({ action: "click", processId: 4242, x: 1, y: 1 });
  });
  const indicatorWindows = () =>
    application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter(
          (window) => window.getTitle() === "STAG · controle Windows",
        ).length,
    );
  const begin = (pulse = false) =>
    application.evaluate((_electron, pulse) => {
      const h = global.desktopIndicatorHarness;
      h.outcome = "";
      const operation = pulse
        ? h.control.pulseCursor(new AbortController().signal)
        : h.control.execute({ action: "screenshot", processId: 4242 });
      h.work = operation.then(
        () => {
          h.outcome = "ok";
        },
        (error) => {
          h.outcome = error.message;
        },
      );
    }, pulse);
  const running = () =>
    expect
      .poll(() => application.evaluate(() => global.desktopIndicatorHarness.phase), {
        timeout: 30000,
      })
      .toBe("running");
  const finish = () =>
    application.evaluate(async () => {
      const h = global.desktopIndicatorHarness;
      h.release();
      await h.work;
      return h.outcome;
    });
  try {
    assert.equal(await indicatorWindows(), 0, "Inspeção/espera de aprovação não mostram bordas.");
    await expect
      .poll(() => application.evaluate(() => global.desktopIndicatorHarness.target.isFocused()))
      .toBe(true);
    await begin();
    await running();
    const state = await application.evaluate(async ({ BrowserWindow, screen }) => {
      const h = global.desktopIndicatorHarness;
      const windows = BrowserWindow.getAllWindows().filter(
        (window) => window.getTitle() === "STAG · controle Windows",
      );
      const image = await windows[0].webContents.capturePage();
      const bitmap = image.toBitmap();
      const { width, height } = image.getSize();
      const pixel = (x, y) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
      return {
        displays: screen.getAllDisplays().map(({ bounds }) => bounds),
        windows: windows.map((window) => ({
          bounds: window.getBounds(),
          visible: window.isVisible(),
          focusable: window.isFocusable(),
          enabled: window.isEnabled(),
          top: window.isAlwaysOnTop(),
          preferences: window.webContents.getLastWebPreferences(),
        })),
        targetFocused: h.target.isFocused(),
        minimized: h.host.isMinimized(),
        hostVisible: h.host.isVisible(),
        center: pixel(Math.floor(width / 2), Math.floor(height / 2)),
        edge: pixel(1, Math.floor(height / 2)),
        png: image.toPNG().toString("base64"),
        targetHandle:
          process.platform === "win32"
            ? h.target.getNativeWindowHandle().readBigUInt64LE().toString()
            : "",
      };
    });
    // Chromium X11 deliberately subtracts one pixel at monitor size to avoid implicit fullscreen.
    // Windows must retain the exact display bounds; do not weaken the native acceptance criterion.
    const expectedBounds = state.displays.map((bounds) =>
      process.platform === "linux"
        ? { ...bounds, width: bounds.width - 1, height: bounds.height - 1 }
        : bounds,
    );
    assert.deepEqual(
      state.windows.map(({ bounds }) => bounds),
      expectedBounds,
    );
    assert.ok(state.targetFocused, "A borda não rouba o foco do alvo.");
    if (process.platform === "win32")
      assert.ok(state.minimized, "A borda funciona com STAG minimizado.");
    else assert.equal(state.hostVisible, false, "No Xvfb, o host deve estar realmente oculto.");
    for (const window of state.windows) {
      assert.ok(window.visible && window.top && !window.focusable && !window.enabled);
      assert.equal(window.preferences.sandbox, true);
      assert.equal(window.preferences.contextIsolation, true);
      assert.equal(window.preferences.nodeIntegration, false);
      assert.equal(window.preferences.javascript, false);
      assert.equal(window.preferences.preload, undefined);
    }
    assert.equal(state.center[3], 0, "Centro do indicador deve continuar transparente.");
    assert.ok(
      state.edge[0] > state.edge[2] + 50 && state.edge[3] > 200,
      "Borda deve ser azul e visível.",
    );
    await writeFile(
      `.local/screenshots/desktop-control-${process.platform}.png`,
      Buffer.from(state.png, "base64"),
    );
    if (process.platform === "win32") {
      const probe = await promisify(execFile)(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolve("tests/fixtures/desktop-indicator.ps1"),
          "-ScriptPath",
          resolve("native/windows-control.ps1"),
          "-TargetHandle",
          state.targetHandle,
        ],
        {
          windowsHide: true,
          timeout: 60000,
          maxBuffer: 1024 * 1024,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
          ),
        },
      );
      assert.deepEqual(JSON.parse(probe.stdout.replace(/^\uFEFF/, "").trim()), {
        hitTarget: true,
        foreground: true,
        captureIsolated: true,
      });
    }
    const target = application
      .windows()
      .find((candidate) => candidate.url().includes("STAG%20synthetic%20indicator%20target"));
    assert.ok(target);
    await target
      .getByRole("button", { name: "Alvo sintético" })
      .click({ position: { x: 2, y: 15 } });
    await expect(target.getByRole("button", { name: "Clicado" })).toBeVisible();
    await target.getByLabel("Texto sintético").fill("Texto de teste");
    await expect(target.getByLabel("Texto sintético")).toHaveValue("Texto de teste");
    assert.equal(await finish(), "ok");
    assert.equal(await indicatorWindows(), 0);

    await begin();
    await running();
    await application.evaluate(() => global.desktopIndicatorHarness.control.cancel());
    assert.equal(await indicatorWindows(), 0, "Parar remove o indicador imediatamente.");
    assert.ok(await application.evaluate(() => global.desktopIndicatorHarness.signal.aborted));
    assert.match(await finish(), /interrompida/);

    await begin();
    await running();
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.getTitle() === "STAG · controle Windows")
        .webContents.forcefullyCrashRenderer();
    });
    await expect.poll(indicatorWindows).toBe(0);
    assert.match(await finish(), /interrompida/);

    await begin(true);
    await running();
    assert.ok((await indicatorWindows()) > 0, "Movimento periódico usa o mesmo indicador.");
    assert.equal(await finish(), "ok");
    // Exercise main-context construction and child views on Linux too, before native platform gating.
    await application.evaluate(async ({ WebContentsView }) => {
      const h = global.desktopIndicatorHarness;
      const view = new WebContentsView({
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      h.target.contentView.addChildView(view);
      const { width, height } = h.target.getContentBounds();
      view.setBounds({ x: Math.floor(width / 2), y: 0, width: Math.floor(width / 2), height });
      await view.webContents.loadURL(
        "data:text/html,<title>Navegador sintetico</title><body style='background:ivory'>Pagina sintetica</body>",
      );
      h.pulseView = view;
    });
    const pulse = () =>
      application.evaluate(async (_electron, scriptPath) => {
        const h = global.desktopIndicatorHarness;
        const driver = new global.DesktopDriverHarness.DesktopTools(
          scriptPath,
          process.platform,
          () => (h.target.isDestroyed() ? null : h.target.getNativeWindowHandle()),
        );
        const control = global.DesktopIndicatorHarness.createDesktopControl(
          h.target,
          driver,
          h.indicator,
        );
        return control.pulseCursor(new AbortController().signal);
      }, resolve("native/windows-control.ps1"));
    if (process.platform === "win32") {
      // Real gesture only on the exact, test-owned Electron window; no client windows or accounts.
      const binding = await application.evaluate(() => ({
        processId: process.pid,
        handle: global.desktopIndicatorHarness.target
          .getNativeWindowHandle()
          .readBigUInt64LE()
          .toString(),
      }));
      const probe = async (mode) => {
        const result = await promisify(execFile)(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("tests/fixtures/desktop-indicator.ps1"),
            "-ScriptPath",
            resolve("native/windows-control.ps1"),
            "-TargetHandle",
            binding.handle,
            "-TargetProcessId",
            String(binding.processId),
            "-Mode",
            mode,
          ],
          {
            windowsHide: true,
            timeout: 60000,
            maxBuffer: 1024 * 1024,
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PSMODULEPATH"),
            ),
          },
        );
        return JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim());
      };
      for (const embedded of [false, true]) {
        await application.evaluate(
          (_electron, embedded) => global.desktopIndicatorHarness.pulseView.setVisible(embedded),
          embedded,
        );
        assert.deepEqual(await probe("preparePulse"), { ready: true });
        const result = await pulse();
        assert.deepEqual(
          result,
          { moved: true },
          "Gesto de produção deve funcionar sobre a janela principal e o navegador filho.",
        );
        assert.deepEqual(await probe("verifyPulse"), { restored: true });
        assert.equal(await indicatorWindows(), 0);
      }
      console.log(
        "Movimento Windows nativo: driver de produção, HWND/PID do main, navegador filho, foco/retorno e bordas OK; somente janela sintética.",
      );
    } else {
      await assert.rejects(pulse(), /somente no Windows/);
      assert.equal(await indicatorWindows(), 0);
      console.log(
        "Gesto do main e navegador filho: construção real e recusa de plataforma Linux OK; nenhuma API Windows executada.",
      );
    }
    await begin();
    await running();
    await application.evaluate(() => global.desktopIndicatorHarness.control.dispose());
    assert.equal(await indicatorWindows(), 0);
    assert.match(await finish(), /interrompida/);
    assert.equal(await application.evaluate(() => global.desktopIndicatorHarness.executions), 5);
    console.log(
      `Indicador desktop: bordas/alpha, foco, ${process.platform === "win32" ? "minimização nativa" : "host oculto no Xvfb"}, entrada sintética, cancelamento, crash, recuperação e gesto periódico OK.`,
    );
  } finally {
    await application.evaluate(async () => {
      const h = global.desktopIndicatorHarness;
      h.control.dispose();
      h.release?.();
      await h.work;
      h.pulseView?.webContents.close();
      h.target.destroy();
      h.host.restore();
      h.host.show();
      h.host.focus();
      delete global.desktopIndicatorHarness;
    });
  }
  const after = await page.evaluate(() => window.stag.getSnapshot());
  assert.deepEqual(after.metrics, before.metrics);
  assert.equal(after.threadId, before.threadId);
  assert.equal(after.mode, before.mode);
}

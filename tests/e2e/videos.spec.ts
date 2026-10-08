import { test, expect } from "@playwright/test";
import { installBridge } from "../fixtures/browser-bridge";

test.beforeEach(async ({ page }) => {
  await installBridge(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Entrar com ChatGPT" }).click();
  await page.getByRole("button", { name: "Escolher meu projeto" }).click();
});
test("anexa vídeo e envia só pelo botão, sem duplicar o texto", async ({ page }, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  const attachment = page.getByRole("region", { name: "Vídeo da solicitação" });
  await expect(attachment).toContainText("fala transcrita");
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Aprenda as regras deste projeto");
  await input.press("Enter");
  await expect(input).toHaveValue("Aprenda as regras deste projeto\n");
  await expect(page.locator(".user-message")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-video.png` });
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(attachment).toHaveCount(0);
  await expect(page.locator(".user-message")).toHaveCount(1);
  await expect(page.locator(".user-message")).toContainText("projeto-sintetico.mp4");
  await expect(input).toHaveValue("");
});
test("Leitura, remoção, troca de conversa e falha preservam o rascunho", async ({ page }) => {
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  const attachment = page.getByRole("region", { name: "Vídeo da solicitação" });
  await expect(attachment).toContainText("sem salvar anotações");
  await page.getByLabel("Mensagem para o assistente").fill("Observe as regras");
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failure = true;
    window.stag!.request = async (action) => {
      if (action.type === "send" && failure) {
        failure = false;
        throw new Error("Falha sintética de vídeo");
      }
      return original(action);
    };
  });
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(attachment).toBeVisible();
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Remover vídeo", exact: true }).click();
  await expect(attachment).toHaveCount(0);
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Anexar vídeo", exact: true }).click();
  await page.getByRole("button", { name: "Nova conversa", exact: true }).click();
  await expect(attachment).toHaveCount(0);
});

test("vídeo longo tem progresso, pausa, retomada e cancelamento sem perder o rascunho", async ({
  page,
}, info) => {
  if (info.project.name === "desktop") await page.setViewportSize({ width: 1280, height: 900 });
  const input = page.getByLabel("Mensagem para o assistente");
  await input.fill("Pergunta para depois da análise");
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
  await expect(panel).toContainText("0 de 19 trechos");
  await expect(panel).toContainText("Vídeo em processamento");
  await expect(panel).toContainText("Trecho atual 1 de 19 · 00:00–05:00");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCount(1);
  await expect(panel).toContainText("Nesta etapa há");
  await expect(panel).toContainText("Continua minimizado");
  await expect(page.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
  await expect(input).toHaveValue("Pergunta para depois da análise");
  await page.getByRole("button", { name: "Pausar análise", exact: true }).click();
  await expect(panel).toContainText("1 de 19 trechos");
  await expect(panel).toContainText("Análise pausada");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCount(0);
  await expect(panel).toContainText("5%");
  await expect(panel).toContainText("Próximo trecho 2 de 19 · 05:00–10:00");
  await expect(
    page.getByRole("progressbar", { name: "Progresso da análise de vídeo" }),
  ).toHaveAttribute("value", "1");
  await page.getByRole("button", { name: "Retomar análise", exact: true }).click();
  await expect(panel).toContainText("próximo trecho");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-background-video.png` });
  await page.getByRole("button", { name: "Cancelar análise", exact: true }).click();
  await expect(panel).toContainText("Análise cancelada");
  await expect(input).toHaveValue("Pergunta para depois da análise");
});
test("vídeo distingue decisão, pausa em limpeza, falha e conclusão sem progresso inventado", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
  const update = async (
    status: "question" | "approval" | "stopping" | "failed" | "completed" | "uncertain",
  ) =>
    page.evaluate(async (status) => {
      const state = await window.stag!.getSnapshot();
      const job = state.videoAnalysis!;
      if (status === "question" || status === "approval") {
        state.approvals = [
          {
            id: "synthetic-wait",
            kind: status === "question" ? "questions" : "file",
            title: "Decisão sintética",
            detail: "Somente teste",
            ...(status === "question"
              ? { questions: [{ id: "stack", question: "Qual stack?", options: [] }] }
              : {}),
          },
        ];
        job.stage = "analyzing";
      } else {
        state.approvals = [];
        job.status = status === "stopping" ? "paused" : status;
        job.working = status === "stopping";
        job.stage = status === "stopping" ? "stopping" : "idle";
        job.phaseStartedAt = status === "stopping" ? Date.now() : null;
        job.phase =
          status === "stopping"
            ? "Pausa solicitada; concluindo o trecho atual…"
            : "Confira as respostas na conversa.";
        job.completed = status === "completed" ? job.total : 2;
        job.error = status === "failed" ? "Não foi possível preparar o vídeo." : null;
      }
      window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
    }, status);
  await update("question");
  await expect(panel).toContainText("Aguardando sua resposta");
  await expect(panel).toContainText("Responda à pergunta na conversa");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCount(0);
  await expect(panel).not.toContainText("Nesta etapa há");
  await expect(panel).toContainText("0%");
  await update("approval");
  await expect(panel).toContainText("Aguardando autorização");
  await expect(panel).toContainText("Confira a aprovação na conversa");
  await update("stopping");
  await expect(panel).toContainText("Pausando análise");
  await expect(page.getByRole("button", { name: "Retomar análise", exact: true })).toBeDisabled();
  await update("failed");
  await expect(panel).toContainText("Falha na análise");
  await expect(panel.getByRole("alert")).toContainText("Não foi possível preparar");
  await expect(panel).toContainText("10%");
  await update("uncertain");
  await expect(panel).toContainText("Envio não confirmado");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reprocessar trecho", exact: true })).toBeEnabled();
  await update("completed");
  await expect(panel).toContainText("Análise concluída");
  await expect(panel).toContainText("100%");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retomar análise", exact: true })).toHaveCount(0);
});

test("retomada explica conexão e autorização Windows, mantendo o modo original", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await page.getByRole("button", { name: "Pausar análise", exact: true }).click();
  const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
  await page.evaluate(async () => {
    const state = await window.stag!.getSnapshot();
    state.videoAnalysis!.mode = "windows";
    window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
  });
  await expect(panel).toContainText("Autorize o desktop no modo Windows");
  await expect(page.getByRole("button", { name: "Retomar análise", exact: true })).toBeDisabled();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("stag-fixture-snapshot", { detail: { connection: "disconnected" } }),
    ),
  );
  await expect(panel).toContainText("Entre com sua conta e conecte o STAG");
  await expect(panel).not.toContainText("Vídeo em processamento");
});

test("tempo de etapa é visível, não altera percentual e respeita movimento reduzido", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const panel = page.getByRole("region", { name: "Análise de vídeo em segundo plano" });
  await page.evaluate(async () => {
    const state = await window.stag!.getSnapshot();
    state.videoAnalysis!.phaseStartedAt = Date.now() - 65000;
    window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
  });
  await expect(panel).toContainText(/Nesta etapa há 01:0[5-9]/);
  await expect(panel.getByRole("progressbar")).toHaveAttribute("value", "0");
  await expect(panel.locator(".video-analysis-spinner")).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Pausar análise", exact: true }).click();
  await expect(panel).not.toContainText("Nesta etapa há");
});
test("vídeo longo em Leitura mantém aviso e falha de início preserva texto", async ({ page }) => {
  await page.getByLabel("Acesso", { exact: true }).selectOption("read");
  await page.getByLabel("Mensagem para o assistente").fill("Observe as regras");
  await page.evaluate(() => {
    const original = window.stag!.request;
    let failure = true;
    window.stag!.request = async (action) => {
      if (action.type === "analyzeVideo" && failure) {
        failure = false;
        throw new Error("Falha sintética ao preparar vídeo longo");
      }
      return original(action);
    };
  });
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Falha sintética");
  await expect(page.getByLabel("Mensagem para o assistente")).toHaveValue("Observe as regras");
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Análise de vídeo em segundo plano" }),
  ).toContainText("sem salvar anotações");
});

test("controles de vídeo longo cabem na janela mínima", async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  const pause = page.getByRole("button", { name: "Pausar análise", exact: true });
  await expect(pause).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Cancelar análise", exact: true }),
  ).toBeInViewport();
  await expect(page.getByLabel("Mensagem para o assistente")).toBeInViewport();
  const box = await page.locator(".composer-controls").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  await page.screenshot({ path: `.local/screenshots/${info.project.name}-video-minimum.png` });
});

test("vídeo longo e movimento ativo cabem juntos na janela mínima Windows", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 360, height: 600 });
  await page.getByRole("button", { name: "Autorizar desktop", exact: true }).click();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Mensagem para o assistente").fill("Explique a arquitetura");
  await page.getByRole("button", { name: "Enviar mensagem" }).click();
  await expect(page.getByText("Pronto para o próximo passo.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Mover mouse a cada 5 min", exact: true }).click();
  await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Desligar movimento do mouse", exact: true }),
  ).toBeInViewport();
  await expect(page.getByRole("button", { name: "Pausar análise", exact: true })).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Cancelar análise", exact: true }),
  ).toBeInViewport();
  const box = await page.locator(".composer-controls").boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(600);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `.local/screenshots/${info.project.name}-video-mouse-minimum.png`,
  });
  await page.getByRole("button", { name: "Pausar análise", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Mover mouse a cada 5 min", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
});

for (const status of ["completed", "cancelled"] as const) {
  test(`janela mínima permite outro vídeo após análise ${status}`, async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 600 });
    await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
    if (status === "cancelled") {
      await page.getByRole("button", { name: "Cancelar análise", exact: true }).click();
    } else {
      await page.evaluate(async () => {
        const state = await window.stag!.getSnapshot();
        Object.assign(state.videoAnalysis!, {
          status: "completed",
          working: false,
          completed: 19,
          stage: "idle",
          phaseStartedAt: null,
          phase:
            "Análise concluída. Confira as respostas e as anotações verificadas pelo assistente.",
        });
        window.dispatchEvent(new CustomEvent("stag-fixture-snapshot", { detail: state }));
      });
    }
    await expect(
      page.getByRole("button", { name: "Analisar em segundo plano", exact: true }),
    ).toBeInViewport();
    await expect(page.getByRole("button", { name: "Anexar vídeo", exact: true })).toBeInViewport();
    await expect(page.getByLabel("Mensagem para o assistente")).toBeInViewport();
    const box = await page.locator(".composer-controls").boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);
    await page.getByRole("button", { name: "Analisar em segundo plano", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "Análise de vídeo em segundo plano" }),
    ).toContainText("Vídeo em processamento");
  });
}

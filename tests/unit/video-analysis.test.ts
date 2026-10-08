import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  VideoAnalysisManager,
  VideoAnalysisStore,
  type VideoAnalysisJob,
  type AnalysisContext,
} from "../../src/main/video-analysis";
import type { BackgroundVideoProcessor, PreparedVideo } from "../../src/main/request-video";
import { actionSchema } from "../../src/shared/validation";
import fixture from "../fixtures/request-image.json";

let dir: string;
let store: VideoAnalysisStore;
let manager: VideoAnalysisManager;
let context: AnalysisContext;
let job: VideoAnalysisJob;
const processor: BackgroundVideoProcessor = {
  inspect: vi.fn(),
  validate: vi.fn(),
  prepare: vi.fn(),
};
const hooks = {
  context: () => context,
  changed: vi.fn(),
  ready: vi.fn(),
  submit: vi.fn(),
  recover: vi.fn(),
  waitTurn: vi.fn(),
  interrupt: vi.fn(),
  failure: vi.fn(),
};
function segment(index: number): PreparedVideo {
  return {
    summary: {
      id: job.id,
      name: "sintetico.mp4",
      seconds: job.source.seconds,
      frames: 1,
      audio: "silent",
      segment: {
        index,
        total: 3,
        start: index * 300,
        end: Math.min(job.source.seconds, (index + 1) * 300),
      },
    },
    frames: [{ seconds: index * 300, image: fixture }],
    transcript: [],
  };
}
async function create() {
  manager = new VideoAnalysisManager(store, processor, hooks);
  await manager.init();
}
beforeEach(async () => {
  await mkdir(resolve(".local"), { recursive: true });
  dir = await mkdtemp(resolve(".local/background-test-"));
  store = new VideoAnalysisStore(resolve(dir, "jobs.json"));
  context = {
    projectPath: dir,
    threadId: "synthetic-thread",
    mode: "project",
    accountKey: "a".repeat(64),
  };
  job = {
    id: randomUUID(),
    projectPath: dir,
    threadId: context.threadId!,
    mode: "project",
    accountKey: context.accountKey!,
    source: {
      path: resolve(dir, "sintetico.mp4"),
      name: "sintetico.mp4",
      size: 3e9,
      mtimeMs: 1,
      dev: 1,
      ino: 1,
      fingerprint: "b".repeat(64),
      seconds: 601,
      audio: false,
    },
    next: 0,
    status: "running",
    pending: null,
  };
  vi.mocked(processor.validate).mockResolvedValue();
  vi.mocked(processor.prepare).mockImplementation(async (_source, index) => segment(index));
  hooks.ready.mockResolvedValue(undefined);
  hooks.submit.mockImplementation(async (_job: VideoAnalysisJob, prepared: PreparedVideo) => ({
    id: `turn-${prepared.summary.segment!.index}`,
    status: "completed",
  }));
  hooks.recover.mockResolvedValue(null);
  await create();
});
afterEach(async () => {
  manager.dispose();
  await manager.settled();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await rm(dir, { recursive: true, force: true });
});
it("envia trechos em sequência e salva só checkpoints, sem mídia/transcrição", async () => {
  hooks.submit.mockImplementation(async (entry, prepared) => {
    const persisted = await store.load();
    expect(persisted[0].next).toBe(prepared.summary.segment!.index);
    expect(persisted[0].pending).toEqual({ index: entry.next });
    expect(hooks.submit.mock.calls.length).toBe(hooks.ready.mock.calls.length);
    return { id: `turn-${entry.next}`, status: "completed" };
  });
  await manager.start(job);
  await manager.settled();
  expect(processor.prepare).toHaveBeenCalledTimes(3);
  expect(manager.summary()).toMatchObject({ completed: 3, total: 3, status: "completed" });
  const saved = await readFile(resolve(dir, "jobs.json"), "utf8");
  expect(saved).not.toContain("data:image");
  expect(saved).not.toContain("transcript");
  expect(saved).not.toContain("consent");
  expect(JSON.stringify(manager.summary())).not.toContain(job.source.path);
});
it("expõe etapa e tempo reais na preparação, fila, análise e pausa; não avança pelo relógio", async () => {
  let time = 10000;
  vi.spyOn(Date, "now").mockImplementation(() => time);
  let releasePreparation!: () => void;
  let releaseQueue!: () => void;
  let releaseTurn!: () => void;
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const queue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  vi.mocked(processor.prepare).mockImplementationOnce(
    async (_source, _index, _id, _signal, progress) => {
      progress("Extraindo imagem 1 de 12…");
      await preparation;
      return segment(0);
    },
  );
  hooks.ready.mockImplementationOnce(() => queue);
  hooks.submit.mockImplementationOnce(async () => {
    await turn;
    return { id: "turn-0", status: "completed" };
  });
  try {
    await manager.start(job);
    await vi.waitFor(() => expect(manager.summary()?.stage).toBe("preparing"));
    expect(manager.summary()).toMatchObject({ working: true, completed: 0, phaseStartedAt: 10000 });
    time = 30000;
    expect(manager.summary()?.phaseStartedAt).toBe(10000);
    releasePreparation();
    await vi.waitFor(() => expect(manager.summary()?.stage).toBe("waiting"));
    expect(manager.summary()?.phase).toContain("fila de ferramentas");
    expect(manager.summary()?.completed).toBe(0);
    expect(hooks.submit).not.toHaveBeenCalled();
    time = 40000;
    releaseQueue();
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
    expect(manager.summary()).toMatchObject({
      stage: "analyzing",
      phaseStartedAt: 40000,
      completed: 0,
    });
    await manager.control(job.id, "pause");
    expect(manager.summary()).toMatchObject({
      stage: "stopping",
      working: true,
      status: "paused",
      completed: 0,
    });
    releaseTurn();
    await manager.settled();
    expect(manager.summary()).toMatchObject({
      stage: "idle",
      working: false,
      phaseStartedAt: null,
      completed: 1,
      status: "paused",
    });
    expect(await readFile(resolve(dir, "jobs.json"), "utf8")).not.toContain("phaseStartedAt");
  } finally {
    releasePreparation();
    releaseQueue();
    releaseTurn();
  }
});
it("pausar análise espera o trecho atual e retoma sem reenviar o trecho concluído", async () => {
  let finish!: () => void;
  hooks.submit.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { id: "turn-0", status: "completed" };
  });
  await manager.start(job);
  await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
  await manager.control(job.id, "pause");
  expect(manager.summary()?.completed).toBe(0);
  expect(manager.working).toBe(true);
  finish();
  await manager.settled();
  expect(manager.summary()).toMatchObject({ status: "paused", completed: 1 });
  expect(processor.prepare).toHaveBeenCalledTimes(1);
  await manager.control(job.id, "resume");
  await manager.settled();
  expect(vi.mocked(processor.prepare).mock.calls.map((args) => args[1])).toEqual([0, 1, 2]);
});
it("pausa na extração aguarda o fechamento, descarta conteúdo parcial e recupera", async () => {
  let closed = false;
  vi.mocked(processor.prepare).mockImplementationOnce(async (_source, _index, _id, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        "abort",
        () => {
          closed = true;
          resolve();
        },
        { once: true },
      ),
    );
    signal.throwIfAborted();
    return segment(0);
  });
  await manager.start(job);
  await vi.waitFor(() => expect(processor.prepare).toHaveBeenCalledTimes(1));
  await manager.control(job.id, "pause");
  await manager.settled();
  expect(closed).toBe(true);
  expect(hooks.submit).not.toHaveBeenCalled();
  expect(manager.summary()).toMatchObject({ completed: 0, status: "paused" });
  await manager.control(job.id, "resume");
  await manager.settled();
  expect(manager.summary()?.status).toBe("completed");
});
it("cancelamento interrompe análise e preserva avanço anterior", async () => {
  let finish!: () => void;
  hooks.submit.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { id: "turn-0", status: "interrupted" };
  });
  hooks.interrupt.mockImplementation(async () => finish());
  await manager.start(job);
  await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(1));
  await manager.control(job.id, "cancel");
  expect(hooks.interrupt).toHaveBeenCalledTimes(1);
  expect(manager.summary()).toMatchObject({ completed: 0, status: "cancelled" });
  expect(processor.prepare).toHaveBeenCalledTimes(1);
});
it.each(["failed", "interrupted"])(
  "turno %s não confirma avanço e requer retomada explícita",
  async (status) => {
    hooks.submit.mockResolvedValueOnce({ id: "turn-0", status });
    await manager.start(job);
    await manager.settled();
    expect(manager.summary()?.completed).toBe(0);
    expect(hooks.submit).toHaveBeenCalledTimes(1);
    hooks.recover.mockResolvedValueOnce({ id: "turn-0", status });
    await manager.control(job.id, "resume");
    await manager.settled();
    expect(manager.summary()?.completed).toBe(3);
  },
);
it.each(["completed", "inProgress"])(
  "reinício concilia turno %s antes de enviar outro trecho",
  async (status) => {
    job.pending = { index: 0 };
    await store.save([job]);
    await create();
    expect(manager.summary()?.status).toBe("paused");
    expect(hooks.submit).not.toHaveBeenCalled();
    hooks.recover.mockResolvedValueOnce({ id: "turn-0", status });
    hooks.waitTurn.mockResolvedValueOnce({ id: "turn-0", status: "completed" });
    await manager.control(job.id, "resume");
    await manager.settled();
    expect(vi.mocked(processor.prepare).mock.calls.map((args) => args[1])).toEqual([1, 2]);
    expect(manager.summary()?.status).toBe("completed");
  },
);
it("envio sem resposta não é repetido automaticamente nem ao simplesmente retomar", async () => {
  hooks.submit.mockRejectedValueOnce(new Error("synthetic lost response private path"));
  await manager.start(job);
  await manager.settled();
  expect(manager.summary()).toMatchObject({ status: "uncertain", completed: 0 });
  expect(JSON.stringify(manager.summary())).not.toContain("private path");
  await manager.control(job.id, "resume");
  await manager.settled();
  expect(hooks.submit).toHaveBeenCalledTimes(1);
  await manager.control(job.id, "retry");
  await manager.settled();
  expect(hooks.submit).toHaveBeenCalledTimes(4);
});
it("retry confere novamente o histórico e não duplica turno concluído", async () => {
  job.pending = { index: 0 };
  job.status = "uncertain";
  await store.save([job]);
  await create();
  hooks.recover.mockResolvedValueOnce({ id: "turn-0", status: "completed" });
  await manager.control(job.id, "retry");
  await manager.settled();
  expect(vi.mocked(processor.prepare).mock.calls.map((args) => args[1])).toEqual([1, 2]);
});
it("falha ao salvar conclusão não avança progresso e recupera pelo histórico", async () => {
  const original = store.save.bind(store);
  const spy = vi.spyOn(store, "save");
  spy.mockImplementation(async (jobs) => {
    if (jobs[0].next === 1) throw new Error("Não foi possível salvar o progresso do vídeo.");
    await original(jobs);
  });
  await manager.start(job);
  await manager.settled();
  expect(manager.summary()).toMatchObject({ status: "uncertain", completed: 0 });
  expect((await store.load())[0].pending).toEqual({ index: 0 });
  spy.mockRestore();
  hooks.recover.mockResolvedValueOnce({ id: "turn-0", status: "completed" });
  await manager.control(job.id, "resume");
  await manager.settled();
  expect(vi.mocked(processor.prepare).mock.calls.map((args) => args[1])).toEqual([0, 1, 2]);
});
it.each(["projectPath", "threadId", "mode", "accountKey"] as const)(
  "checkpoint não transfere autoridade por %s",
  async (key) => {
    await store.save([{ ...job, status: "paused" }]);
    await create();
    (context as unknown as Record<string, unknown>)[key] = key === "mode" ? "read" : "other";
    await expect(manager.control(job.id, "resume")).rejects.toThrow("indisponível");
    expect(processor.validate).not.toHaveBeenCalled();
    if (key !== "mode") expect(manager.summary()).toBeNull();
  },
);
it("arquivo alterado/ausente pausa sem encaminhar mídia", async () => {
  vi.mocked(processor.validate).mockRejectedValueOnce(
    new Error("O arquivo mudou. Selecione o vídeo novamente."),
  );
  await manager.start(job);
  await manager.settled();
  expect(manager.summary()).toMatchObject({ status: "failed", completed: 0 });
  expect(processor.prepare).not.toHaveBeenCalled();
  expect(hooks.failure).toHaveBeenCalledTimes(1);
});
it("checkpoint inválido não autoriza sobrescrever progresso nem vaza conteúdo", async () => {
  await writeFile(resolve(dir, "jobs.json"), '{"private-synthetic-path":');
  manager = new VideoAnalysisManager(store, processor, hooks);
  await expect(manager.init()).rejects.toThrow("ler o progresso");
  await expect(manager.start(job)).rejects.toThrow("ler o progresso");
  expect(await readFile(resolve(dir, "jobs.json"), "utf8")).toBe('{"private-synthetic-path":');
});
it("IPC de segundo plano aceita apenas operação e identificador opaco", () => {
  expect(actionSchema.safeParse({ type: "analyzeVideo", path: job.source.path }).success).toBe(
    false,
  );
  expect(
    actionSchema.safeParse({
      type: "videoAnalysis",
      id: job.id,
      control: "resume",
      source: job.source,
    }).success,
  ).toBe(false);
  expect(
    actionSchema.safeParse({ type: "videoAnalysis", id: job.id, control: "resume" }).success,
  ).toBe(true);
});

it("falha de limpeza após pausar fica explícita e permite recuperação", async () => {
  vi.mocked(processor.prepare).mockImplementationOnce(async (_source, _index, _id, signal) => {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Error("Não foi possível limpar os arquivos temporários do vídeo.");
  });
  await manager.start(job);
  await vi.waitFor(() => expect(processor.prepare).toHaveBeenCalledTimes(1));
  await manager.control(job.id, "pause");
  await manager.settled();
  expect(manager.summary()?.error).toContain("limpar");
  expect(manager.summary()?.completed).toBe(0);
  await manager.control(job.id, "resume");
  await manager.settled();
  expect(manager.summary()?.status).toBe("completed");
});

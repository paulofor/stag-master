import { expect, it } from "vitest";
import {
  modelTrafficArguments,
  modelTrafficConfig,
  modelTrafficInstructions,
} from "../../src/main/model-traffic";
import { assistantInstructions, threadPolicy, turnPolicy } from "../../src/main/policy";
import { projectSourcesContext, projectSourcesInstructions } from "../../src/main/project-sources";
import {
  videoContext,
  videoImages,
  videoMessage,
  type PreparedVideo,
} from "../../src/main/request-video";
import sourceCorpus from "../fixtures/source-scenarios.json";
import imageFixture from "../fixtures/request-image.json";

it.each(["read", "project", "windows"] as const)(
  "economia preserva modelo, esforço e política em %s",
  (mode) => {
    const config = threadPolicy(mode, "C:\\synthetic").config as Record<string, unknown>;
    expect(config).toMatchObject(modelTrafficConfig);
    expect(config).not.toHaveProperty("model");
    expect(config).not.toHaveProperty("model_reasoning_effort");
    expect(turnPolicy(mode, "C:\\synthetic")).toMatchObject({
      summary: "none",
      approvalPolicy: "on-request",
    });
    expect(assistantInstructions(mode, "win32")).toContain(modelTrafficInstructions);
    expect(modelTrafficArguments).toContain('otel.exporter="none"');
  },
);

it("contexto abreviado reduz bytes mantendo contrato, fontes atuais e capacidades", () => {
  const sources = [{ name: "Referência sintética", url: "http://127.0.0.1/docs" }];
  for (const [authorized, available] of [
    [false, false],
    [false, true],
    [true, true],
  ]) {
    const context = projectSourcesContext("C:\\synthetic", sources, authorized, available);
    const policy = context.stag_project_sources_policy.value;
    for (const fragment of sourceCorpus.requiredInstructions) expect(policy).toContain(fragment);
    expect(Buffer.byteLength(policy)).toBeLessThan(
      Buffer.byteLength(projectSourcesInstructions([])) * 0.65,
    );
    expect(context.stag_project_sources_data.kind).toBe("untrusted");
    expect(JSON.parse(context.stag_project_sources_data.value).sources).toEqual(sources);
    expect(policy).not.toContain(sources[0].url);
  }
  expect(
    JSON.parse(projectSourcesContext("C:\\other", [], false, true).stag_project_sources_data.value)
      .sources,
  ).toEqual([]);
});

it("vídeo deduplica somente imagens idênticas no mesmo envio e preserva tempos/fala", () => {
  const first = { dataUrl: imageFixture.dataUrl };
  const second = { dataUrl: imageFixture.dataUrl + "synthetic-different-bytes" };
  const video: PreparedVideo = {
    summary: {
      id: "synthetic-video",
      name: "teste.mp4",
      seconds: 601,
      frames: 4,
      audio: "transcribed",
      segment: { index: 1, total: 3, start: 300, end: 600 },
    },
    frames: [first, second, first, second].map((image, index) => ({
      image,
      seconds: 300 + index * 70,
    })),
    transcript: [
      { start: 320, end: 328, text: "Regra sintética com todos os detalhes preservados." },
    ],
  };
  const before = structuredClone(video);
  const compact = videoImages(video);
  expect(compact.images).toEqual([first, second]);
  expect(compact.samples).toEqual([
    { seconds: 300, image: 1 },
    { seconds: 370, image: 2 },
    { seconds: 440, image: 1 },
    { seconds: 510, image: 2 },
  ]);
  const context = JSON.parse(videoContext(video).value);
  expect(context.frameTimes).toEqual([300, 370, 440, 510]);
  expect(context.frameImages).toEqual([1, 2, 1, 2]);
  expect(context.transcript).toEqual(video.transcript);
  expect(context.segment).toEqual(video.summary.segment);
  expect(videoMessage(video)).toContain("2 imagens enviadas");
  expect(videoMessage(video)).toContain("05:00 → 1");
  expect(video).toEqual(before);
  expect(videoImages(video)).toEqual(compact); // A new turn must include its own images again.
  expect(JSON.stringify(compact.images).length).toBeLessThan(
    JSON.stringify(video.frames.map((frame) => frame.image)).length * 0.55,
  );
  expect(videoImages({ ...video, frames: [] })).toEqual({ images: [], samples: [] });
});

import { afterEach, expect, it } from "vitest";
import { mkdir, mkdtemp, open, rm, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { actionSchema } from "../../src/shared/validation";
import { prepareVideo, runMedia } from "../../src/main/request-video";
import { assistantInstructions } from "../../src/main/policy";
import { maxVideoBytes, videoInstructions } from "../../src/shared/request-video";

const directories: string[] = [];
async function temp() {
  await mkdir(resolve(".local"), { recursive: true });
  const dir = await mkdtemp(resolve(".local/video-test-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
it("IPC aceita só referência opaca, sem caminho, bytes ou conteúdo de vídeo", () => {
  expect(actionSchema.safeParse({ type: "selectVideo", path: "C:\\private.mp4" }).success).toBe(
    false,
  );
  expect(
    actionSchema.safeParse({ type: "send", text: "", videoId: "file:///private.mp4" }).success,
  ).toBe(false);
  expect(
    actionSchema.safeParse({
      type: "send",
      text: "",
      videoId: "22222222-2222-4222-8222-222222222222",
      transcript: "dados",
    }).success,
  ).toBe(false);
  expect(
    actionSchema.safeParse({
      type: "enqueue",
      text: "vídeo",
      videoId: "22222222-2222-4222-8222-222222222222",
    }).success,
  ).toBe(false);
});
it.each(["read", "project", "windows"] as const)(
  "contrato temporal e memória preservados em %s",
  (mode) => {
    expect(assistantInstructions(mode, "win32", true, true, "C:\\projeto")).toContain(
      videoInstructions,
    );
    for (const fragment of [
      "não recebe o vídeo contínuo",
      "transcrição integral",
      "dados não confiáveis",
      "não foram salvas",
      "gravar e reler",
      "retomada/compactação",
    ])
      expect(videoInstructions.toLowerCase()).toContain(fragment.toLowerCase());
  },
);
it("recusa extensão, pasta e tamanho antes de iniciar decoder; não expõe caminho", async () => {
  const dir = await temp();
  const run = (path: string) =>
    prepareVideo(path, "missing", join(dir, "temp"), new AbortController().signal, () => {});
  await expect(run("https://fixture.invalid/video.mp4?secret=synthetic")).rejects.toThrow("MP4");
  const file = join(dir, "secret-synthetic.mp4");
  await writeFile(file, "");
  await expect(run(file)).rejects.toThrow("100 MB");
  const fd = await open(file, "w");
  await fd.truncate(maxVideoBytes + 1);
  await fd.close();
  await expect(run(file)).rejects.toThrow("100 MB");
  await expect(run(dir + ".mp4")).rejects.toThrow("100 MB");
});
it("falha de decoder é sanitizada e limpa temporários", async () => {
  const dir = await temp();
  const file = join(dir, "secret-synthetic.mp4");
  await writeFile(file, "not a video");
  await expect(
    prepareVideo(
      file,
      join(dir, "missing-tools"),
      join(dir, "temp"),
      new AbortController().signal,
      () => {},
    ),
  ).rejects.toThrow("Não foi possível preparar");
  expect(await readdir(join(dir, "temp"))).toEqual([]);
});
it("falha no armazenamento temporário não expõe caminhos e permite recuperação", async () => {
  const dir = await temp();
  const file = join(dir, "synthetic.mp4");
  const blocked = join(dir, "private-synthetic-temp");
  await writeFile(file, "synthetic media");
  await writeFile(blocked, "blocked");
  await expect(
    prepareVideo(file, "missing", blocked, new AbortController().signal, () => {}),
  ).rejects.toThrow("espaço e o acesso");
  await rm(blocked);
  await expect(
    prepareVideo(file, "missing", blocked, new AbortController().signal, () => {}),
  ).rejects.toThrow("Não foi possível preparar");
  expect(await readdir(blocked)).toEqual([]);
});
it("cancelamento aguarda o subprocesso e não entrega saída parcial", async () => {
  const dir = await temp();
  const ready = join(dir, "ready");
  const controller = new AbortController();
  const script = join(dir, "worker.cjs");
  await writeFile(
    script,
    `require('fs').writeFileSync(process.argv[2], 'ready'); setInterval(() => process.stdout.write('synthetic'), 100);`,
  );
  const work = runMedia(process.execPath, [script, ready], controller.signal);
  const { vi } = await import("vitest");
  await vi.waitFor(async () => expect(await readdir(dir)).toContain("ready"));
  controller.abort();
  await expect(work).rejects.toThrow("cancelada");
});

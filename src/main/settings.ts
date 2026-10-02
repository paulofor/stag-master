import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const settingsSchema = z.object({
  project: z.string().optional(),
  threads: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        mode: z.enum(["read", "project", "windows"]),
        browserTool: z.boolean().optional(),
      }),
    )
    .default({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export class SettingsStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load(): Promise<Settings> {
    try {
      return settingsSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return { threads: {} };
    }
  }
  save(settings: Settings): Promise<void> {
    const content = JSON.stringify(settingsSchema.parse(settings));
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, content, { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
    });
    this.queue = write.catch(() => {});
    return write;
  }
}

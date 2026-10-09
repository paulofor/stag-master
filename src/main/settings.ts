import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { projectSourcesSchema } from "../shared/project-sources";

const settingsSchema = z.object({
  project: z.string().optional(),
  projectSources: z.record(z.string(), projectSourcesSchema).default({}),
  browserProfiles: z.record(z.string(), z.string().uuid()).default({}),
  threads: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        mode: z.enum(["read", "project", "windows"]),
        browserTool: z.boolean().optional(),
        httpTool: z.boolean().optional(),
        sqlTool: z.boolean().optional(),
        userInputTool: z.boolean().optional(),
        backgroundVideo: z.boolean().optional(),
      }),
    )
    .default({}),
});
const storedSettingsSchema = settingsSchema.extend({
  browserProfiles: z.record(z.string(), z.string().uuid()).default({}).catch({}),
  projectSources: z.record(z.string(), projectSourcesSchema.catch([])).default({}).catch({}),
});
export type Settings = z.infer<typeof settingsSchema>;
export class SettingsStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load(): Promise<Settings> {
    try {
      return storedSettingsSchema.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return { threads: {}, projectSources: {}, browserProfiles: {} };
    }
  }
  save(settings: z.input<typeof settingsSchema>): Promise<void> {
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

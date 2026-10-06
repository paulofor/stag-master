import { z } from "zod";

// Full ref validation is repeated by Git in main. Do not accept revision expressions or options.
export const branchNameSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      name !== "HEAD" &&
      name !== "@" &&
      !name.startsWith("-") &&
      !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(name) &&
      !name.includes("..") &&
      !name.includes("@{") &&
      !name.endsWith(".") &&
      name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
    "Nome de branch inválido. Use, por exemplo, feature/cadastro, sem espaços.",
  );
export const branchOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("create"), name: branchNameSchema, from: z.string().min(1).max(240) })
    .strict(),
  z.object({ kind: z.literal("switch"), branch: branchNameSchema }).strict(),
  z
    .object({ kind: z.literal("rename"), branch: branchNameSchema, name: branchNameSchema })
    .strict(),
  z.object({ kind: z.literal("delete"), branch: branchNameSchema }).strict(),
]);
export type BranchOperation = z.infer<typeof branchOperationSchema>;
export interface GitBranch {
  name: string;
  ref: string;
  kind: "local" | "remote";
  current: boolean;
  occupied: boolean;
}
export interface BranchRepository {
  id: string;
  path: string;
  name: string;
  current: string | null;
  detached: boolean;
  unborn: boolean;
  dirty: boolean;
  branches: GitBranch[];
  error: string | null;
}
export interface ProjectBranches {
  projectPath: string;
  revision: string;
  observedAt: string;
  repositories: BranchRepository[];
  incomplete: boolean;
  issues: { path: string; message: string }[];
  message: string | null;
}

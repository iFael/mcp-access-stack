import { z } from "zod";

export const ORACLE_EDITOR_DEPENDENCY_ROOT = "tooling/smoke/browser/editor-fixtures" as const;
export const ORACLE_EDITOR_DEPENDENCY_GRANT = "dependency.install.editor-fixtures" as const;

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
export const workspaceDependencyInstallInputSchema = z.object({
  workspaceId: z.string().trim().min(1),
  root: z.string().min(1).max(512).regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u)
    .refine((value) => value.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
  operationId: z.string().uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u),
  action: z.enum(["resolve", "install"]),
  expectedManifestSha256: sha,
  expectedLockSha256: sha.nullable(),
}).strict().refine((input) => (input.action === "resolve") === (input.expectedLockSha256 === null),
  "Resolve requires an absent lock; install requires the exact existing lock hash.");
export type WorkspaceDependencyInstallInput = z.input<typeof workspaceDependencyInstallInputSchema>;

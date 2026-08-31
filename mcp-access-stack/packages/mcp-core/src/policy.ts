import { z } from "zod";

export const supportedShells = [
  "powershell",
  "pwsh",
  "cmd",
  "wsl",
  "git-bash",
] as const;

export const shellNameSchema = z.enum(supportedShells);
export type ShellName = z.infer<typeof shellNameSchema>;

export const permissionProfileSchema = z.enum([
  "planning-readonly",
  "planning-handoff",
  "builder-review",
  "restricted-area",
  "full-repo-readonly",
  "full-repo-write",
]);

export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

export const confirmationModeSchema = z.enum(["standard", "trusted-workspace"]);
export type ConfirmationMode = z.infer<typeof confirmationModeSchema>;

export const workspaceKindSchema = z.enum(["repository", "aggregate"]);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export const workspaceLimitsSchema = z
  .object({
    maxFileBytes: z.number().int().positive(),
    maxSearchResults: z.number().int().positive(),
    maxSearchSnippetBytes: z.number().int().positive(),
    maxDiffBytes: z.number().int().positive(),
    maxListedFiles: z.number().int().positive(),
    maxDiscoveryDirectories: z.number().int().positive().optional(),
    maxDiscoveryEntries: z.number().int().positive().optional(),
    maxDiscoveryDurationMs: z.number().int().positive().optional(),
  })
  .strict();

export type WorkspaceLimits = z.infer<typeof workspaceLimitsSchema>;

export const workspacePolicySchema = z
  .object({
    id: z.string().trim().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    name: z.string().trim().min(1),
    rootPath: z.string().trim().min(1),
    workspaceKind: workspaceKindSchema.optional(),
    enabled: z.boolean().default(true),
    permissionProfile: permissionProfileSchema,
    confirmationMode: confirmationModeSchema.default("standard"),
    allowedRoots: z.array(z.string().trim().min(1)).min(1),
    blockedGlobs: z.array(z.string().trim().min(1)).default([]),
    limits: workspaceLimitsSchema,
    allowWrites: z.array(z.string().trim().min(1)).default([]),
    allowShell: z.array(z.string().trim().min(1)).default([]),
    allowedShells: z.array(shellNameSchema).default(["powershell"]),
  })
  .strict()
  .superRefine((workspace, context) => {
    if (
      workspace.confirmationMode === "trusted-workspace" &&
      workspace.permissionProfile !== "full-repo-write"
    ) {
      context.addIssue({
        code: "custom",
        message: "trusted-workspace confirmation mode requires full-repo-write.",
        path: ["confirmationMode"],
      });
    }
  });

export type WorkspacePolicyInput = z.input<typeof workspacePolicySchema>;
export type WorkspacePolicy = z.output<typeof workspacePolicySchema>;

function refineUniqueWorkspaceIds(
  policy: { workspaces: Array<{ id: string }> },
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  for (const [index, workspace] of policy.workspaces.entries()) {
    if (ids.has(workspace.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate workspace id: ${workspace.id}`,
        path: ["workspaces", index, "id"],
      });
    }
    ids.add(workspace.id);
  }
}

export const loopbackBasePolicySchema = z
  .object({
    version: z.literal(1),
    workspaces: z.array(workspacePolicySchema),
  })
  .strict()
  .superRefine(refineUniqueWorkspaceIds);

export type LoopbackBasePolicy = z.output<typeof loopbackBasePolicySchema>;

export const policyFileSchema = z
  .object({
    version: z.literal(1),
    workspaces: z.array(workspacePolicySchema).min(1),
  })
  .strict()
  .superRefine(refineUniqueWorkspaceIds);

export type PolicyFile = z.output<typeof policyFileSchema>;

export const mandatoryBlockedGlobs = [
  "**/.env",
  "**/.env.!(example|sample|template)",
  "**/*.pem",
  "**/*.key",
  "**/*.pfx",
  "**/*.crt",
  "**/secrets.*",
  "**/credentials.*",
  "**/id_rsa",
  "**/id_dsa",
  "**/.git/**",
  "**/.runtime-private",
  "**/.runtime-private/**",
  "**/node_modules/**",
  "**/bin/**",
  "**/obj/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
] as const;

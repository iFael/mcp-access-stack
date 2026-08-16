import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const releaseIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const relativeArtifactPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(value), {
    message: "artifact path must be relative.",
  })
  .refine(
    (value) =>
      !value
        .replaceAll("\\", "/")
        .split("/")
        .some((segment) => segment === ".." || segment === "." || segment.length === 0),
    { message: "artifact path must not contain traversal or empty segments." },
  );

export const WINDOWS_EXECUTION_ARTIFACT_ROLES = [
  "mcp-host",
  "workspace-agent",
  "browser-worker",
  "node-runtime",
] as const;

export const windowsExecutionArtifactRoleSchema = z.enum(
  WINDOWS_EXECUTION_ARTIFACT_ROLES,
);
export type WindowsExecutionArtifactRole = z.infer<
  typeof windowsExecutionArtifactRoleSchema
>;

export const WINDOWS_EXECUTION_RUNTIME_MODES = [
  "bundled-node",
  "self-contained",
] as const;

export const windowsExecutionRuntimeModeSchema = z.enum(
  WINDOWS_EXECUTION_RUNTIME_MODES,
);
export type WindowsExecutionRuntimeMode = z.infer<
  typeof windowsExecutionRuntimeModeSchema
>;

export const windowsExecutionArtifactSchema = z
  .object({
    role: windowsExecutionArtifactRoleSchema,
    path: relativeArtifactPathSchema,
    sha256: sha256Schema,
    sizeBytes: z.number().int().positive(),
    authenticodeRequired: z.boolean(),
  })
  .strict();
export type WindowsExecutionArtifact = z.infer<
  typeof windowsExecutionArtifactSchema
>;

export const windowsExecutionReleaseManifestSchema = z
  .object({
    version: z.literal(1),
    releaseId: releaseIdSchema,
    commit: commitSchema,
    platform: z.literal("win32-x64"),
    createdAt: z.iso.datetime(),
    runtimeMode: windowsExecutionRuntimeModeSchema,
    integrityRoot: z.literal("signed-distribution-manifest"),
    artifacts: z.array(windowsExecutionArtifactSchema).min(3).max(4),
  })
  .strict()
  .superRefine((manifest, context) => {
    const byRole = new Map<WindowsExecutionArtifactRole, WindowsExecutionArtifact>();
    for (const artifact of manifest.artifacts) {
      if (byRole.has(artifact.role)) {
        context.addIssue({
          code: "custom",
          message: `duplicate artifact role: ${artifact.role}`,
          path: ["artifacts"],
        });
      }
      byRole.set(artifact.role, artifact);
    }

    for (const requiredRole of [
      "mcp-host",
      "workspace-agent",
      "browser-worker",
    ] as const) {
      if (!byRole.has(requiredRole)) {
        context.addIssue({
          code: "custom",
          message: `missing required artifact role: ${requiredRole}`,
          path: ["artifacts"],
        });
      }
    }

    const mcpHost = byRole.get("mcp-host");
    if (mcpHost && !mcpHost.authenticodeRequired) {
      context.addIssue({
        code: "custom",
        message: "mcp-host must require Authenticode validation",
        path: ["artifacts"],
      });
    }

    const nodeRuntime = byRole.get("node-runtime");
    if (manifest.runtimeMode === "bundled-node" && !nodeRuntime) {
      context.addIssue({
        code: "custom",
        message: "bundled-node releases must include a node-runtime artifact",
        path: ["artifacts"],
      });
    }
    if (manifest.runtimeMode === "self-contained" && nodeRuntime) {
      context.addIssue({
        code: "custom",
        message: "self-contained releases must not include a node-runtime artifact",
        path: ["artifacts"],
      });
    }
  });
export type WindowsExecutionReleaseManifest = z.infer<
  typeof windowsExecutionReleaseManifestSchema
>;

export const windowsExecutionReleasePointerSchema = z
  .object({
    releaseId: releaseIdSchema,
    manifestSha256: sha256Schema,
    materializedAt: z.iso.datetime(),
  })
  .strict();
export type WindowsExecutionReleasePointer = z.infer<
  typeof windowsExecutionReleasePointerSchema
>;

export const windowsExecutionNodeStateSchema = z
  .object({
    version: z.literal(1),
    active: windowsExecutionReleasePointerSchema.nullable(),
    candidate: windowsExecutionReleasePointerSchema.nullable(),
    previous: windowsExecutionReleasePointerSchema.nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((state, context) => {
    if (
      state.active &&
      state.candidate &&
      state.active.releaseId === state.candidate.releaseId
    ) {
      context.addIssue({
        code: "custom",
        message: "candidate must differ from the active release",
        path: ["candidate"],
      });
    }

    if (
      state.active &&
      state.previous &&
      state.active.releaseId === state.previous.releaseId
    ) {
      context.addIssue({
        code: "custom",
        message: "previous must differ from the active release",
        path: ["previous"],
      });
    }
  });
export type WindowsExecutionNodeState = z.infer<
  typeof windowsExecutionNodeStateSchema
>;

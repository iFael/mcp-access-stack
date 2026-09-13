import { z } from "zod";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const releaseIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const artifactIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{0,63}$/u);
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

export const WINDOWS_EXECUTION_SERVICE_IDS = [
  "edge-runtime",
  "browser-worker",
] as const;

export const windowsExecutionServiceIdSchema = z.enum(
  WINDOWS_EXECUTION_SERVICE_IDS,
);
export type WindowsExecutionServiceId = z.infer<
  typeof windowsExecutionServiceIdSchema
>;

export const WINDOWS_EXECUTION_ARTIFACT_OWNERS = [
  ...WINDOWS_EXECUTION_SERVICE_IDS,
  "shared",
] as const;

export const windowsExecutionArtifactOwnerSchema = z.enum(
  WINDOWS_EXECUTION_ARTIFACT_OWNERS,
);
export type WindowsExecutionArtifactOwner = z.infer<
  typeof windowsExecutionArtifactOwnerSchema
>;

export const windowsExecutionServiceSchema = z
  .object({
    id: windowsExecutionServiceIdSchema,
    entryArtifactId: artifactIdSchema,
  })
  .strict();
export type WindowsExecutionService = z.infer<
  typeof windowsExecutionServiceSchema
>;

export const windowsExecutionArtifactSchema = z
  .object({
    id: artifactIdSchema,
    owner: windowsExecutionArtifactOwnerSchema,
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
    version: z.literal(2),
    releaseId: releaseIdSchema,
    commit: commitSchema,
    platform: z.literal("win32-x64"),
    createdAt: z.iso.datetime(),
    runtimeMode: z.literal("bundled-node"),
    integrityRoot: z.literal("signed-distribution-manifest"),
    services: z.array(windowsExecutionServiceSchema),
    artifacts: z.array(windowsExecutionArtifactSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    const services = new Map<WindowsExecutionServiceId, WindowsExecutionService>();
    for (const service of manifest.services) {
      if (services.has(service.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate service id: ${service.id}`,
          path: ["services"],
        });
      }
      services.set(service.id, service);
    }

    for (const requiredService of WINDOWS_EXECUTION_SERVICE_IDS) {
      if (!services.has(requiredService)) {
        context.addIssue({
          code: "custom",
          message: `missing required service: ${requiredService}`,
          path: ["services"],
        });
      }
    }

    const artifacts = new Map<string, WindowsExecutionArtifact>();
    for (const artifact of manifest.artifacts) {
      if (artifacts.has(artifact.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate artifact id: ${artifact.id}`,
          path: ["artifacts"],
        });
      }
      artifacts.set(artifact.id, artifact);
    }

    for (const service of services.values()) {
      const entry = artifacts.get(service.entryArtifactId);
      if (!entry) {
        context.addIssue({
          code: "custom",
          message: `service ${service.id} entry artifact is missing: ${service.entryArtifactId}`,
          path: ["services"],
        });
        continue;
      }
      if (entry.owner !== service.id) {
        context.addIssue({
          code: "custom",
          message: `service ${service.id} entry artifact must be owned by ${service.id}`,
          path: ["services"],
        });
      }
      if (!entry.authenticodeRequired) {
        context.addIssue({
          code: "custom",
          message: `service ${service.id} entry artifact must require Authenticode validation`,
          path: ["services"],
        });
      }
    }

    const nodeRuntime = artifacts.get("node-runtime");
    if (!nodeRuntime) {
      context.addIssue({
        code: "custom",
        message: "bundled-node runtime requires the node-runtime artifact",
        path: ["artifacts"],
      });
    } else if (nodeRuntime.owner !== "shared") {
      context.addIssue({
        code: "custom",
        message: "node-runtime artifact must be shared",
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

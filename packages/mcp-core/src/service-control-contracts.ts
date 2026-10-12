import { z } from "zod";

export const managedLinuxServiceNames = [
  "mcp-v3-oracle-read-api.service",
  "mcp-v3-update-control-oracle-channel.service",
] as const;

export const managedLinuxServiceNameSchema = z.enum(managedLinuxServiceNames);

const workspaceIdSchema = z.string().trim().min(1).max(256);
const safeSystemdStateSchema = z.string().trim().min(1).max(64);

const diagnosticsWindowSchema = z.object({
  since: z.iso.datetime({ offset: true }),
  until: z.iso.datetime({ offset: true }),
}).strict().refine(
  (value) => Date.parse(value.until) > Date.parse(value.since) &&
    Date.parse(value.until) - Date.parse(value.since) <= 2 * 60 * 60 * 1_000,
  "The diagnostic time window must be positive and at most two hours.",
);

const serviceDiagnosticsSchema = z.object({
  journal: z.object({
    status: z.enum(["available", "permission_denied", "unavailable"]),
    events: z.array(z.object({
      timestamp: z.string().max(64),
      kind: z.enum(["starting", "stopping", "started", "stopped", "exit", "other"]),
      origin: z.enum(["systemd_manager", "service", "other"]),
    }).strict()).max(50),
  }).strict(),
  polkit: z.object({
    status: z.enum(["available", "missing", "permission_denied", "unavailable"]),
    owner: z.string().max(64).nullable(),
    mode: z.string().max(8).nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  }).strict(),
}).strict();

export const managedServiceSnapshotSchema = z
  .object({
    serviceName: managedLinuxServiceNameSchema,
    loadState: safeSystemdStateSchema,
    unitFileState: safeSystemdStateSchema,
    activeState: safeSystemdStateSchema,
    subState: safeSystemdStateSchema,
    result: safeSystemdStateSchema,
    mainPid: z.number().int().nonnegative(),
    nRestarts: z.number().int().nonnegative(),
    execMainStatus: z.number().int().nonnegative().nullable(),
    stateChangeTimestamp: z.string().trim().min(1).max(128).nullable(),
    diagnostics: serviceDiagnosticsSchema.optional(),
  })
  .strict();

export const serviceGetStatusInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    serviceName: managedLinuxServiceNameSchema,
    diagnostics: diagnosticsWindowSchema.optional(),
  })
  .strict();

export const serviceStartInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    serviceName: managedLinuxServiceNameSchema,
    operationId: z.uuid(),
    expectedActiveState: z.literal("inactive"),
    expectedUnitFileState: z.literal("enabled"),
  })
  .strict();

export const serviceStartResultSchema = z
  .object({
    status: z.literal("started"),
    operationId: z.uuid(),
    serviceName: managedLinuxServiceNameSchema,
    before: managedServiceSnapshotSchema,
    after: managedServiceSnapshotSchema,
  })
  .strict();

export type ManagedLinuxServiceName = z.infer<typeof managedLinuxServiceNameSchema>;
export type ManagedServiceSnapshot = z.infer<typeof managedServiceSnapshotSchema>;
export type ServiceGetStatusInput = z.infer<typeof serviceGetStatusInputSchema>;
export type ServiceStartInput = z.infer<typeof serviceStartInputSchema>;
export type ServiceStartResult = z.infer<typeof serviceStartResultSchema>;

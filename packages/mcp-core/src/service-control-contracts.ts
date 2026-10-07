import { z } from "zod";

export const managedLinuxServiceNames = [
  "mcp-v3-oracle-read-api.service",
  "mcp-v3-update-control-oracle-channel.service",
] as const;

export const managedLinuxServiceNameSchema = z.enum(managedLinuxServiceNames);

const workspaceIdSchema = z.string().trim().min(1).max(256);
const safeSystemdStateSchema = z.string().trim().min(1).max(64);

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
  })
  .strict();

export const serviceGetStatusInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    serviceName: managedLinuxServiceNameSchema,
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

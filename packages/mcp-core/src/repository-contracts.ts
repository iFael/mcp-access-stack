import { z } from "zod";

const idBody = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const userIdSchema = z.string().regex(new RegExp(`^usr_${idBody}$`, "iu"));
export const repositoryIdSchema = z.string().regex(new RegExp(`^repo_${idBody}$`, "iu"));
export const deviceIdSchema = z.string().regex(new RegExp(`^dev_${idBody}$`, "iu"));
export const materializationIdSchema = z.string().regex(new RegExp(`^mat_${idBody}$`, "iu"));

export const repositoryRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const repositoryVisibilitySchema = z.enum(["private", "shared"]);
export const devicePlatformSchema = z.enum(["windows", "linux", "macos", "unknown"]);
export const deviceStatusSchema = z.enum(["online", "offline", "revoked"]);
export const materializationStatusSchema = z.enum(["online", "offline", "unavailable"]);

export const repositorySummarySchema = z.object({
  id: repositoryIdSchema,
  name: z.string().min(1).max(200),
  role: repositoryRoleSchema,
  visibility: repositoryVisibilitySchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type RepositorySummary = z.infer<typeof repositorySummarySchema>;

export const repositoryMaterializationSchema = z.object({
  id: materializationIdSchema,
  repositoryId: repositoryIdSchema,
  deviceId: deviceIdSchema,
  workspaceId: z.string().min(1).max(200),
  platform: devicePlatformSchema,
  path: z.string().min(1).max(4096),
  status: materializationStatusSchema,
}).strict();
export type RepositoryMaterialization = z.infer<typeof repositoryMaterializationSchema>;

export const repositoryDetailsSchema = repositorySummarySchema.extend({
  materializations: z.array(repositoryMaterializationSchema).max(256),
}).strict();
export type RepositoryDetails = z.infer<typeof repositoryDetailsSchema>;

export const deviceSummarySchema = z.object({
  id: deviceIdSchema,
  displayName: z.string().min(1).max(200),
  platform: devicePlatformSchema,
  status: deviceStatusSchema,
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
}).strict();
export type DeviceSummary = z.infer<typeof deviceSummarySchema>;

export const onboardingStateSchema = z.object({
  user: z.object({
    id: userIdSchema,
    displayName: z.string().min(1).max(200),
  }).strict().nullable(),
  repositoryCount: z.number().int().nonnegative(),
  devices: z.array(deviceSummarySchema).max(256),
  status: z.enum(["identity_required", "device_required", "ready"]),
}).strict();
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const discoveredRepositorySchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
  workspaceId: z.string().min(1).max(200),
  git: z.literal(true),
  remoteUrls: z.array(z.string().max(4096)).max(32),
  dirty: z.boolean(),
}).strict();
export type DiscoveredRepository = z.infer<typeof discoveredRepositorySchema>;

export const getOnboardingStateInputSchema = z.object({}).strict();
export type GetOnboardingStateInput = z.infer<typeof getOnboardingStateInputSchema>;

export const listRepositoriesInputSchema = z.object({}).strict();
export type ListRepositoriesInput = z.infer<typeof listRepositoriesInputSchema>;

export const getRepositoryInputSchema = z.object({ repositoryId: repositoryIdSchema }).strict();
export type GetRepositoryInput = z.infer<typeof getRepositoryInputSchema>;

export const createRepositoryInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
}).strict();
export type CreateRepositoryInput = z.infer<typeof createRepositoryInputSchema>;

export const discoverLocalRepositoriesInputSchema = z.object({
  deviceId: deviceIdSchema.optional(),
  root: z.string().min(1).max(4096),
  maxDepth: z.number().int().min(1).max(8).optional(),
}).strict();
export type DiscoverLocalRepositoriesInput = z.infer<typeof discoverLocalRepositoriesInputSchema>;

export const importRepositoriesInputSchema = z.object({
  deviceId: deviceIdSchema.optional(),
  root: z.string().min(1).max(4096),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(128),
  mode: z.enum(["preserve-path", "copy-to-managed-root"]).default("preserve-path"),
  confirmationId: z.string().min(1).max(128).optional(),
}).strict();
export type ImportRepositoriesInput = z.infer<typeof importRepositoriesInputSchema>;

export const materializeRepositoryInputSchema = z.object({
  deviceId: deviceIdSchema.optional(),
  repositoryId: repositoryIdSchema,
  targetName: z.string().trim().min(1).max(200).optional(),
  confirmationId: z.string().min(1).max(128).optional(),
}).strict();
export type MaterializeRepositoryInput = z.infer<typeof materializeRepositoryInputSchema>;

export const syncRepositoryInputSchema = z.object({
  deviceId: deviceIdSchema.optional(),
  repositoryId: repositoryIdSchema,
  mode: z.enum(["status", "fetch", "pull-fast-forward", "push"]).default("status"),
  confirmationId: z.string().min(1).max(128).optional(),
}).strict();
export type SyncRepositoryInput = z.infer<typeof syncRepositoryInputSchema>;

export const listDevicesInputSchema = z.object({}).strict();
export type ListDevicesInput = z.infer<typeof listDevicesInputSchema>;

export const revokeDeviceInputSchema = z.object({
  deviceId: deviceIdSchema,
  confirmationId: z.string().min(1).max(128).optional(),
}).strict();
export type RevokeDeviceInput = z.infer<typeof revokeDeviceInputSchema>;

export const listRepositoriesResultSchema = z.object({
  repositories: z.array(repositorySummarySchema).max(4096),
}).strict();
export type ListRepositoriesResult = z.infer<typeof listRepositoriesResultSchema>;

export const discoverLocalRepositoriesResultSchema = z.object({
  repositories: z.array(discoveredRepositorySchema).max(128),
}).strict();
export type DiscoverLocalRepositoriesResult = z.infer<typeof discoverLocalRepositoriesResultSchema>;

export const importRepositoriesResultSchema = z.object({
  repositories: z.array(repositoryDetailsSchema).max(128),
}).strict();
export type ImportRepositoriesResult = z.infer<typeof importRepositoriesResultSchema>;

export const materializeRepositoryResultSchema = z.object({
  repository: repositoryDetailsSchema,
  materialization: repositoryMaterializationSchema,
}).strict();
export type MaterializeRepositoryResult = z.infer<typeof materializeRepositoryResultSchema>;

export const syncRepositoryResultSchema = z.object({
  repositoryId: repositoryIdSchema,
  status: z.enum(["clean", "dirty", "fetched", "updated", "pushed", "conflict", "blocked"]),
  detail: z.string().max(4000).optional(),
}).strict();
export type SyncRepositoryResult = z.infer<typeof syncRepositoryResultSchema>;

export const listDevicesResultSchema = z.object({
  devices: z.array(deviceSummarySchema).max(256),
}).strict();
export type ListDevicesResult = z.infer<typeof listDevicesResultSchema>;

export const revokeDeviceResultSchema = z.object({
  device: deviceSummarySchema,
}).strict();
export type RevokeDeviceResult = z.infer<typeof revokeDeviceResultSchema>;

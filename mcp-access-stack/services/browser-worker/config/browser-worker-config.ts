import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  authorizedSitePolicySchema,
  type AuthorizedSitePolicy,
} from "../domain/authorized-site-policy.js";
import {
  browserOperationModeSchema,
  DEFAULT_BROWSER_OPERATION_MODE,
  type BrowserOperationMode,
} from "../policies/browser-operation-mode.js";

export const browserProfileModeSchema = z.literal("persistent");
export type BrowserProfileMode = z.infer<typeof browserProfileModeSchema>;
export const browserChannelSchema = z.enum(["chromium", "chrome"]);
export type BrowserChannel = z.infer<typeof browserChannelSchema>;

const configSchema = z
  .object({
    BROWSER_WORKER_PORT: z.coerce.number().int().min(1).max(65_535).default(3350),
    BROWSER_WORKER_TOKEN: z.string().min(32),
    BROWSER_WORKER_MODE: browserOperationModeSchema.default(
      DEFAULT_BROWSER_OPERATION_MODE,
    ),
    BROWSER_WORKER_PROFILE_MODE: browserProfileModeSchema.default("persistent"),
    BROWSER_WORKER_BROWSER_CHANNEL: browserChannelSchema.default("chromium"),
    BROWSER_WORKER_USER_DATA_DIR: z.string().min(1).optional(),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    BROWSER_WORKER_MAX_OWNED_TABS: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(8),
    BROWSER_WORKER_MAX_CONCURRENT_TABS: z.coerce
      .number()
      .int()
      .min(1)
      .max(16)
      .default(4),
    BROWSER_WORKER_NAVIGATION_CACHE_MAX_ENTRIES: z.coerce
      .number()
      .int()
      .min(1)
      .max(1_000)
      .default(100),
    BROWSER_WORKER_IDEMPOTENCY_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .default(5 * 60 * 1000),
    BROWSER_TASK_REAPER_INTERVAL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .default(30_000),
    BROWSER_TASK_IDLE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .default(10 * 60 * 1000),
    BROWSER_CONTEXT_IDLE_SHUTDOWN_MS: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(60 * 60 * 1000)
      .default(60_000),
    BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100_000)
      .default(4_096),
    BROWSER_WORKER_NAVIGATION_CACHE_RETENTION_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(365 * 24 * 60 * 60 * 1000)
      .default(30 * 24 * 60 * 60 * 1000),
    BROWSER_WORKER_RUNTIME_DIR: z.string().min(1).default("runtime/browser"),
    BROWSER_WORKER_PRIVATE_DIR: z.string().min(1).default(".runtime-private/browser"),
    BROWSER_WORKER_SITE_POLICIES_PATH: z.string().min(1).optional(),
    BROWSER_WORKER_PRIMARY_SITE_ID: z.string().min(1).max(128).optional(),
    BROWSER_WORKER_CREDENTIAL_BROKER_PATH: z.string().min(1).optional(),
    BROWSER_WORKER_CREDENTIAL_BROKER_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60_000)
      .default(10_000),
    BROWSER_WORKER_LOGIN_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(30_000),
    BROWSER_WORKER_LOGIN_INVALID_BACKOFF_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .default(5 * 60 * 1000),
    BROWSER_WORKER_CONNECT_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(180_000)
      .default(90_000),
    BROWSER_WORKER_OPERATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(180_000)
      .default(120_000),
    BROWSER_WORKER_ACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(60_000)
      .default(10_000),
    BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(180_000)
      .default(90_000),
    BROWSER_WORKER_OUTPUT_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(1024 * 1024 * 1024)
      .default(256 * 1024 * 1024),
    BROWSER_WORKER_EXTRACTION_MAX_SCROLLS: z.coerce
      .number()
      .int()
      .min(1)
      .max(200)
      .default(24),
    BROWSER_WORKER_EXTRACTION_MAX_PAGES: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5),
    BROWSER_WORKER_EXTRACTION_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(64 * 1024 * 1024)
      .default(8 * 1024 * 1024),
    BROWSER_WORKER_EXTRACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(120_000)
      .default(20_000),
    BROWSER_WORKER_EXTRACTION_NO_PROGRESS_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),
    BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(300_000)
      .default(120_000),
    BROWSER_WORKER_DIAGNOSTIC_RETENTION_MS: z.coerce
      .number()
      .int()
      .positive()
      .max(30 * 24 * 60 * 60 * 1000)
      .default(7 * 24 * 60 * 60 * 1000),
    BROWSER_WORKER_DIAGNOSTIC_MAX_ARTIFACTS: z.coerce
      .number()
      .int()
      .positive()
      .max(5_000)
      .default(500),
    BROWSER_WORKER_DIAGNOSTIC_MAX_ENTRIES: z.coerce
      .number()
      .int()
      .positive()
      .max(5_000)
      .default(500),
  })
  .strict();

export interface BrowserWorkerConfig {
  host: "127.0.0.1";
  port: number;
  token: string;
  mode: BrowserOperationMode;
  profileMode?: BrowserProfileMode;
  browserChannel?: BrowserChannel;
  headless?: boolean;
  userDataDirectory?: string;
  maxPayloadBytes: number;
  maxOwnedTabs?: number;
  maxConcurrentTabs?: number;
  navigationCacheMaxEntries?: number;
  navigationCacheRetentionMs?: number;
  idempotencyTtlMs?: number;
  idempotencyMaxEntries?: number;
  taskReaperIntervalMs?: number;
  taskIdleTtlMs?: number;
  contextIdleShutdownMs?: number;
  runtimeDirectory: string;
  privateDirectory: string;
  primaryPrivateSiteId?: string;
  primaryPrivateSiteUrl?: URL;
  privateSitePolicies?: AuthorizedSitePolicy[];
  credentialBrokerPath?: string;
  credentialBrokerTimeoutMs?: number;
  loginTimeoutMs?: number;
  loginInvalidBackoffMs?: number;
  connectTimeoutMs: number;
  operationTimeoutMs: number;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
  outputMaxBytes: number;
  extractionMaxScrolls?: number;
  extractionMaxPages?: number;
  extractionMaxBytes?: number;
  extractionTimeoutMs?: number;
  extractionNoProgressLimit?: number;
  diagnosticTimeoutMs: number;
  diagnosticRetentionMs: number;
  diagnosticMaxArtifacts: number;
  diagnosticMaxEntries: number;
}

export function loadBrowserWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): BrowserWorkerConfig {
  const known: Record<string, string> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const value = environment[key];
    if (value !== undefined) known[key] = value;
  }
  const value = configSchema.parse(known);
  const privateDirectory = path.resolve(value.BROWSER_WORKER_PRIVATE_DIR);
  const userDataDirectory = path.resolve(
    value.BROWSER_WORKER_USER_DATA_DIR ?? path.join(privateDirectory, "chrome-profile"),
  );
  const sitePoliciesPath = path.resolve(
    value.BROWSER_WORKER_SITE_POLICIES_PATH ??
      path.join(privateDirectory, "site-policies.json"),
  );
  const privateSitePolicies = loadPrivateSitePolicies(sitePoliciesPath);
  const primaryPrivateSite = value.BROWSER_WORKER_PRIMARY_SITE_ID
    ? privateSitePolicies.find(
        (policy) => policy.siteId === value.BROWSER_WORKER_PRIMARY_SITE_ID,
      )
    : privateSitePolicies[0];
  if (value.BROWSER_WORKER_PRIMARY_SITE_ID && !primaryPrivateSite) {
    throw new Error(
      `BROWSER_WORKER_PRIMARY_SITE_ID is not configured: ${value.BROWSER_WORKER_PRIMARY_SITE_ID}`,
    );
  }
  const primaryPrivateSiteUrl = primaryPrivateSite
    ? new URL(primaryPrivateSite.entryUrl)
    : undefined;
  if (
    value.BROWSER_WORKER_PROFILE_MODE === "persistent" &&
    !isPathInside(privateDirectory, userDataDirectory)
  ) {
    throw new Error(
      "BROWSER_WORKER_USER_DATA_DIR must stay inside BROWSER_WORKER_PRIVATE_DIR in persistent mode.",
    );
  }
  return {
    host: "127.0.0.1",
    port: value.BROWSER_WORKER_PORT,
    token: value.BROWSER_WORKER_TOKEN,
    mode: value.BROWSER_WORKER_MODE,
    profileMode: value.BROWSER_WORKER_PROFILE_MODE,
    browserChannel: value.BROWSER_WORKER_BROWSER_CHANNEL,
    userDataDirectory,
    maxPayloadBytes: value.BROWSER_WORKER_MAX_PAYLOAD_BYTES,
    maxOwnedTabs: value.BROWSER_WORKER_MAX_OWNED_TABS,
    maxConcurrentTabs: value.BROWSER_WORKER_MAX_CONCURRENT_TABS,
    navigationCacheMaxEntries: value.BROWSER_WORKER_NAVIGATION_CACHE_MAX_ENTRIES,
    navigationCacheRetentionMs: value.BROWSER_WORKER_NAVIGATION_CACHE_RETENTION_MS,
    idempotencyTtlMs: value.BROWSER_WORKER_IDEMPOTENCY_TTL_MS,
    idempotencyMaxEntries: value.BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES,
    taskReaperIntervalMs: value.BROWSER_TASK_REAPER_INTERVAL_MS,
    taskIdleTtlMs: value.BROWSER_TASK_IDLE_TTL_MS,
    contextIdleShutdownMs: value.BROWSER_CONTEXT_IDLE_SHUTDOWN_MS,
    runtimeDirectory: path.resolve(value.BROWSER_WORKER_RUNTIME_DIR),
    privateDirectory,
    ...(primaryPrivateSite ? { primaryPrivateSiteId: primaryPrivateSite.siteId } : {}),
    ...(primaryPrivateSiteUrl ? { primaryPrivateSiteUrl } : {}),
    privateSitePolicies,
    ...(value.BROWSER_WORKER_CREDENTIAL_BROKER_PATH === undefined
      ? {}
      : {
          credentialBrokerPath: path.resolve(
            value.BROWSER_WORKER_CREDENTIAL_BROKER_PATH,
          ),
        }),
    credentialBrokerTimeoutMs: value.BROWSER_WORKER_CREDENTIAL_BROKER_TIMEOUT_MS,
    loginTimeoutMs: value.BROWSER_WORKER_LOGIN_TIMEOUT_MS,
    loginInvalidBackoffMs: value.BROWSER_WORKER_LOGIN_INVALID_BACKOFF_MS,
    connectTimeoutMs: value.BROWSER_WORKER_CONNECT_TIMEOUT_MS,
    operationTimeoutMs: value.BROWSER_WORKER_OPERATION_TIMEOUT_MS,
    actionTimeoutMs: value.BROWSER_WORKER_ACTION_TIMEOUT_MS,
    navigationTimeoutMs: value.BROWSER_WORKER_NAVIGATION_TIMEOUT_MS,
    outputMaxBytes: value.BROWSER_WORKER_OUTPUT_MAX_BYTES,
    extractionMaxScrolls: value.BROWSER_WORKER_EXTRACTION_MAX_SCROLLS,
    extractionMaxPages: value.BROWSER_WORKER_EXTRACTION_MAX_PAGES,
    extractionMaxBytes: value.BROWSER_WORKER_EXTRACTION_MAX_BYTES,
    extractionTimeoutMs: value.BROWSER_WORKER_EXTRACTION_TIMEOUT_MS,
    extractionNoProgressLimit: value.BROWSER_WORKER_EXTRACTION_NO_PROGRESS_LIMIT,
    diagnosticTimeoutMs: value.BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS,
    diagnosticRetentionMs: value.BROWSER_WORKER_DIAGNOSTIC_RETENTION_MS,
    diagnosticMaxArtifacts: value.BROWSER_WORKER_DIAGNOSTIC_MAX_ARTIFACTS,
    diagnosticMaxEntries: value.BROWSER_WORKER_DIAGNOSTIC_MAX_ENTRIES,
  };
}

function loadPrivateSitePolicies(policyPath: string): AuthorizedSitePolicy[] {
  if (!existsSync(policyPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read browser private-site policies: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return z.array(authorizedSitePolicySchema).max(20).parse(parsed);
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

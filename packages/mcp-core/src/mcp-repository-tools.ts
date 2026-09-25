import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AppError, asAppError } from "./errors.js";
import { withToolOperationContext, type ToolOperationContextFactory } from "./mcp-operation-context.js";
import {
  createRepositoryInputSchema,
  discoverLocalRepositoriesInputSchema,
  discoverLocalRepositoriesResultSchema,
  getOnboardingStateInputSchema,
  getRepositoryInputSchema,
  importRepositoriesInputSchema,
  importRepositoriesResultSchema,
  listDevicesInputSchema,
  listDevicesResultSchema,
  listRepositoriesInputSchema,
  listRepositoriesResultSchema,
  materializeRepositoryInputSchema,
  materializeRepositoryResultSchema,
  onboardingStateSchema,
  repositoryDetailsSchema,
  revokeDeviceInputSchema,
  revokeDeviceResultSchema,
  syncRepositoryInputSchema,
  syncRepositoryResultSchema,
} from "./repository-contracts.js";
import type { RepositoryExecutor } from "./repository-executor.js";
import { QUICK_OPERATION_TIMEOUT_MS } from "./timeout-policy.js";

export interface RegisterRepositoryToolsOptions {
  securitySchemes?: readonly unknown[];
  operationContextFactory?: ToolOperationContextFactory;
}

const annotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export function registerRepositoryTools(
  server: McpServer,
  executor: RepositoryExecutor,
  options: RegisterRepositoryToolsOptions = {},
): void {
  const meta = options.securitySchemes ? { securitySchemes: options.securitySchemes } : undefined;

  server.registerTool("get_onboarding_state", {
    title: "Get MCP V3 onboarding state",
    description: "Returns the authenticated user's MCP V3 identity, repository count and authorized devices. Use this to decide whether local runtime onboarding is required.",
    inputSchema: getOnboardingStateInputSchema,
    outputSchema: onboardingStateSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.getOnboardingState(input, context), onboardingStateSchema));

  server.registerTool("list_repositories", {
    title: "List repositories",
    description: "Lists repositories the authenticated user is authorized to access, independent of which runtime currently materializes them.",
    inputSchema: listRepositoriesInputSchema,
    outputSchema: listRepositoriesResultSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.listRepositories(input, context), listRepositoriesResultSchema));

  server.registerTool("get_repository", {
    title: "Get repository",
    description: "Returns one authorized repository and its current materializations. Repository identity is stable even when local paths differ across devices.",
    inputSchema: getRepositoryInputSchema,
    outputSchema: repositoryDetailsSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.getRepository(input, context), repositoryDetailsSchema));

  server.registerTool("create_repository", {
    title: "Create repository identity",
    description: "Creates a private MCP V3 repository identity for the authenticated user. This does not silently create or rewrite a GitHub/GitLab remote.",
    inputSchema: createRepositoryInputSchema,
    outputSchema: repositoryDetailsSchema,
    annotations: annotations,
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.createRepository(input, context), repositoryDetailsSchema));

  server.registerTool("discover_local_repositories", {
    title: "Discover local repositories",
    description: "Scans an explicitly supplied local root on an authorized MCP V3 device and returns Git repositories without registering, moving or modifying them.",
    inputSchema: discoverLocalRepositoriesInputSchema,
    outputSchema: discoverLocalRepositoriesResultSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.discoverLocalRepositories(input, context), discoverLocalRepositoriesResultSchema));

  server.registerTool("import_repositories", {
    title: "Import local repositories",
    description: "Registers selected discovered repositories and their local materializations. Existing paths and Git remotes are preserved by default; copy-to-managed-root requires explicit confirmation.",
    inputSchema: importRepositoriesInputSchema,
    outputSchema: importRepositoriesResultSchema,
    annotations: annotations,
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.importRepositories(input, context), importRepositoriesResultSchema));

  server.registerTool("materialize_repository", {
    title: "Materialize repository locally",
    description: "Creates a working materialization of an authorized repository on the selected local MCP V3 runtime. Existing dirty worktrees are never overwritten.",
    inputSchema: materializeRepositoryInputSchema,
    outputSchema: materializeRepositoryResultSchema,
    annotations: annotations,
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.materializeRepository(input, context), materializeRepositoryResultSchema));

  server.registerTool("sync_repository", {
    title: "Synchronize repository",
    description: "Inspects or synchronizes an authorized repository materialization using fail-closed Git semantics. Dirty/conflicting worktrees are not destructively replaced.",
    inputSchema: syncRepositoryInputSchema,
    outputSchema: syncRepositoryResultSchema,
    annotations: annotations,
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.syncRepository(input, context), syncRepositoryResultSchema));

  server.registerTool("list_devices", {
    title: "List MCP V3 devices",
    description: "Lists devices authorized for the authenticated user and their current connectivity state.",
    inputSchema: listDevicesInputSchema,
    outputSchema: listDevicesResultSchema,
    annotations: { ...annotations, readOnlyHint: true, idempotentHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.listDevices(input, context), listDevicesResultSchema));

  server.registerTool("revoke_device", {
    title: "Revoke MCP V3 device",
    description: "Revokes one device belonging to the authenticated user. Revoking a local device does not affect the Oracle primary or other devices.",
    inputSchema: revokeDeviceInputSchema,
    outputSchema: revokeDeviceResultSchema,
    annotations: { ...annotations, destructiveHint: true },
    ...(meta ? { _meta: meta } : {}),
  }, async (input, extra) => invoke(options, extra, QUICK_OPERATION_TIMEOUT_MS, (context) => executor.revokeDevice(input, context), revokeDeviceResultSchema));
}

async function invoke<T>(
  options: RegisterRepositoryToolsOptions,
  extra: { signal: AbortSignal; requestId: string | number },
  timeoutMs: number,
  operation: Parameters<typeof withToolOperationContext<T>>[3],
  schema: { parse(value: unknown): T },
) {
  try {
    const structuredContent = schema.parse(await withToolOperationContext(
      options.operationContextFactory,
      extra,
      timeoutMs,
      operation,
    ));
    return {
      content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  } catch (error) {
    const appError = asAppError(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: `${appError.code}: ${appError.message}` }],
    };
  }
}

export function unavailableRepositoryExecutor(): RepositoryExecutor {
  return new Proxy({} as RepositoryExecutor, {
    get: () => async () => {
      throw new AppError("AGENT_UNAVAILABLE", "Repository service unavailable.");
    },
  });
}

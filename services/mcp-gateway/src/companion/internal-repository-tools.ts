import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
  COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
} from "@mcp-access-stack/edge-protocol";
import { repositoryIdSchema } from "@vs-code-gpt/shared";
import { z } from "zod";

const repositoryBindingSchema = z.object({
  repositoryId: repositoryIdSchema,
  name: z.string().trim().min(1).max(200),
  path: z.string().min(1).max(4096),
  workspaceId: z.string().min(1).max(200),
  remoteUrls: z.array(z.string().max(4096)).max(32),
  managed: z.boolean().optional(),
}).strict();

const bindRepositoriesInputSchema = z.object({
  bindings: z.array(repositoryBindingSchema).min(1).max(128),
  dryRun: z.boolean().default(false),
  mode: z.enum(["preserve-path", "copy-to-managed-root"]).default("preserve-path"),
}).strict();

const boundRepositorySchema = z.object({
  repositoryId: repositoryIdSchema,
  workspaceId: z.string().min(1).max(200),
  path: z.string().min(1).max(4096),
}).strict();

const bindRepositoriesResultSchema = z.object({
  bound: z.array(boundRepositorySchema).max(128),
}).strict();

const materializeRepositoryInputSchema = z.object({
  repositoryId: repositoryIdSchema,
  name: z.string().trim().min(1).max(200),
  remoteUrls: z.array(z.string().min(1).max(4096)).min(1).max(32),
  targetName: z.string().trim().min(1).max(200).optional(),
  workspaceId: z.string().min(1).max(200).optional(),
  dryRun: z.boolean().default(false),
}).strict();

const materializeRepositoryResultSchema = z.object({
  materialization: boundRepositorySchema,
}).strict();

export type CompanionRepositoryBinding = z.infer<typeof repositoryBindingSchema>;

export interface CompanionRepositoryBinder {
  bindRepositories(
    bindings: CompanionRepositoryBinding[],
    signal?: AbortSignal,
    dryRun?: boolean,
    mode?: "preserve-path" | "copy-to-managed-root",
  ): Promise<Array<{
    repositoryId: string;
    workspaceId: string;
    path: string;
  }>>;
  materializeRepositoryFromCloud(
    input: {
      repositoryId: string;
      name: string;
      remoteUrls: string[];
      targetName?: string;
      workspaceId?: string;
    },
    signal?: AbortSignal,
    dryRun?: boolean,
  ): Promise<{
    repositoryId: string;
    workspaceId: string;
    path: string;
  }>;
}

export function registerCompanionInternalRepositoryTools(
  server: McpServer,
  binder: CompanionRepositoryBinder,
): void {
  server.registerTool(
    COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
    {
      title: "MCP V3 internal repository binding",
      description: "Internal Edge-to-companion repository binding operation.",
      inputSchema: bindRepositoriesInputSchema,
      outputSchema: bindRepositoriesResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const bound = await binder.bindRepositories(
        input.bindings,
        extra.signal,
        input.dryRun,
        input.mode,
      );
      const structuredContent = bindRepositoriesResultSchema.parse({ bound });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  server.registerTool(
    COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
    {
      title: "MCP V3 internal repository materialization",
      description: "Internal Edge-to-companion managed repository materialization operation.",
      inputSchema: materializeRepositoryInputSchema,
      outputSchema: materializeRepositoryResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input, extra) => {
      const materialization = await binder.materializeRepositoryFromCloud(
        {
          repositoryId: input.repositoryId,
          name: input.name,
          remoteUrls: input.remoteUrls,
          ...(input.targetName === undefined ? {} : { targetName: input.targetName }),
          ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
        },
        extra.signal,
        input.dryRun,
      );
      const structuredContent = materializeRepositoryResultSchema.parse({
        materialization,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}

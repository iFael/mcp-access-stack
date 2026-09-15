import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolCatalogMetadata,
  type McpToolCatalogMetadata,
} from "@vs-code-gpt/shared";

const EMPTY_OBJECT_JSON_SCHEMA = {
  type: "object",
  properties: {},
} as const;

export interface ToolSecurityScheme {
  type: "noauth" | "oauth2";
  scopes?: string[];
}

interface RegisteredTool {
  enabled: boolean;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
  _meta?: Record<string, unknown>;
}

export interface PublishedTool extends Record<string, unknown> {
  name: string;
}

export function buildPublishedTools(
  server: McpServer,
  securitySchemes: readonly ToolSecurityScheme[],
): PublishedTool[] {
  const internals = server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
  };
  return Object.entries(internals._registeredTools)
    .filter(([, tool]) => tool.enabled)
    .map(([name, tool]): PublishedTool => {
      const definition: PublishedTool = {
        name,
        title: tool.title,
        description: tool.description,
        inputSchema: toInputJsonSchema(tool.inputSchema),
        annotations: tool.annotations,
        execution: tool.execution,
        securitySchemes,
        _meta: tool._meta,
      };
      if (tool.outputSchema) {
        definition.outputSchema = toOutputJsonSchema(tool.outputSchema);
      }
      return definition;
    });
}

export function createRegisteredMcpCatalogMetadata(
  server: McpServer,
  securitySchemes: readonly ToolSecurityScheme[],
): McpToolCatalogMetadata {
  return createMcpToolCatalogMetadata(buildPublishedTools(server, securitySchemes));
}

/**
 * ChatGPT Apps SDK reads securitySchemes from the root of each tool descriptor.
 * The MCP TypeScript SDK currently keeps that metadata only in _meta.
 */
export function installChatGptToolsListCompatibility(
  server: McpServer,
  securitySchemes: readonly ToolSecurityScheme[],
  expectedCatalog = createRegisteredMcpCatalogMetadata(server, securitySchemes),
): McpToolCatalogMetadata {
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = buildPublishedTools(server, securitySchemes);
    const actualCatalog = createMcpToolCatalogMetadata(tools);
    if (
      actualCatalog.contractRevision !== expectedCatalog.contractRevision ||
      actualCatalog.toolSetRevision !== expectedCatalog.toolSetRevision ||
      actualCatalog.toolCount !== expectedCatalog.toolCount ||
      actualCatalog.serverVersion !== expectedCatalog.serverVersion
    ) {
      throw new Error(
        "Registered MCP tool descriptors diverged from the server construction identity.",
      );
    }

    return {
      tools,
      _meta: {
        [MCP_TOOL_CATALOG_META_KEY]: actualCatalog,
      },
    };
  });

  return expectedCatalog;
}

function toInputJsonSchema(schema: unknown): unknown {
  const objectSchema = normalizeObjectSchema(schema as never);
  return objectSchema
    ? toJsonSchemaCompat(objectSchema, {
        strictUnions: true,
        pipeStrategy: "input",
      })
    : EMPTY_OBJECT_JSON_SCHEMA;
}

function toOutputJsonSchema(schema: unknown): unknown {
  const objectSchema = normalizeObjectSchema(schema as never);
  return objectSchema
    ? toJsonSchemaCompat(objectSchema, {
        strictUnions: true,
        pipeStrategy: "output",
      })
    : undefined;
}

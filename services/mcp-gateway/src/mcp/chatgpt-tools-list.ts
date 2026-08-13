import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_FULL_TOOL_CATALOG_METADATA,
  MCP_TOOL_CATALOG_CONTRACT_REVISION,
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolCatalogMetadata,
  createMcpToolDescriptorRevision,
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

interface PublishedTool extends Record<string, unknown> {
  name: string;
}

/**
 * ChatGPT Apps SDK reads securitySchemes from the root of each tool descriptor.
 * The MCP TypeScript SDK currently keeps that metadata only in _meta.
 */
export function installChatGptToolsListCompatibility(
  server: McpServer,
  securitySchemes: readonly ToolSecurityScheme[],
  expectedCatalog: McpToolCatalogMetadata,
): void {
  const internals = server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
  };
  server.server.setRequestHandler(ListToolsRequestSchema, () => {
    const tools = Object.entries(internals._registeredTools)
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

    const actualCatalog = createMcpToolCatalogMetadata(
      tools.map((tool) => tool.name),
    );
    if (
      actualCatalog.toolCount !== expectedCatalog.toolCount ||
      actualCatalog.toolSetRevision !== expectedCatalog.toolSetRevision
    ) {
      throw new Error(
        "Registered MCP tool catalog diverged from the server initialization identity.",
      );
    }

    const descriptorRevision = createMcpToolDescriptorRevision(tools);
    const isFullCatalog =
      actualCatalog.toolCount === MCP_FULL_TOOL_CATALOG_METADATA.toolCount &&
      actualCatalog.toolSetRevision === MCP_FULL_TOOL_CATALOG_METADATA.toolSetRevision;
    if (
      isFullCatalog &&
      descriptorRevision !== MCP_TOOL_CATALOG_CONTRACT_REVISION
    ) {
      throw new Error(
        "MCP tool descriptors changed without updating the catalog contract revision.",
      );
    }

    return {
      tools,
      _meta: {
        [MCP_TOOL_CATALOG_META_KEY]: {
          ...actualCatalog,
          descriptorRevision,
        },
      },
    };
  });
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

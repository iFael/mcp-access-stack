import { createHash } from "node:crypto";
import { BROWSER_TOOL_NAMES } from "./mcp-browser-tools.js";
import {
  MCP_SERVER_BASE_VERSION,
  WORKSPACE_TOOL_NAMES,
} from "./mcp-workspace-tools.js";

export const MCP_TOOL_CATALOG_META_KEY = "io.github.ifael/mcp-tool-catalog";

export const MCP_TOOL_CATALOG_CONTRACT_REVISION =
  "3d95fd60b0e7946c4c41855188e6657322360a4ad4f339877067e6b5f8f13d77";

export const MCP_FULL_TOOL_CATALOG_NAMES = [
  ...WORKSPACE_TOOL_NAMES,
  ...BROWSER_TOOL_NAMES,
] as const;

export interface McpToolCatalogMetadata {
  contractRevision: string;
  toolSetRevision: string;
  toolCount: number;
  serverVersion: string;
}

export interface McpToolDescriptorFingerprintInput {
  name: string;
  title?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  execution?: unknown;
}

export function createMcpToolSetRevision(names: readonly string[]): string {
  const canonicalNames = [...new Set(names)].sort(compareText).join("\n");
  return createHash("sha256")
    .update("mcp-tool-set-v1\0", "utf8")
    .update(canonicalNames, "utf8")
    .digest("hex");
}

export function createMcpToolDescriptorRevision(
  tools: readonly McpToolDescriptorFingerprintInput[],
): string {
  const projected = tools
    .map((tool) => ({
      name: tool.name,
      ...(tool.title === undefined ? {} : { title: tool.title }),
      ...(tool.description === undefined ? {} : { description: tool.description }),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      ...(tool.execution === undefined ? {} : { execution: tool.execution }),
    }))
    .sort((left, right) => compareText(left.name, right.name));
  const canonical = JSON.stringify(canonicalize(projected));
  return createHash("sha256")
    .update("mcp-tool-descriptor-v1\0", "utf8")
    .update(canonical, "utf8")
    .digest("hex");
}

export function createMcpServerVersion(names: readonly string[]): string {
  const toolSetRevision = createMcpToolSetRevision(names);
  return `${MCP_SERVER_BASE_VERSION}-catalog.c${MCP_TOOL_CATALOG_CONTRACT_REVISION.slice(0, 12)}.s${toolSetRevision.slice(0, 12)}`;
}

export function createMcpToolCatalogMetadata(
  names: readonly string[],
): McpToolCatalogMetadata {
  return {
    contractRevision: MCP_TOOL_CATALOG_CONTRACT_REVISION,
    toolSetRevision: createMcpToolSetRevision(names),
    toolCount: new Set(names).size,
    serverVersion: createMcpServerVersion(names),
  };
}

export const MCP_FULL_TOOL_CATALOG_METADATA = createMcpToolCatalogMetadata(
  MCP_FULL_TOOL_CATALOG_NAMES,
);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

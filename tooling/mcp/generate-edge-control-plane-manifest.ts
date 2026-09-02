import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  MCP_TOOL_CATALOG_META_KEY,
  type SourceControlExecutor,
  type WorkspaceExecutor,
} from "@vs-code-gpt/shared";
import { loadGatewayConfig } from "../../services/mcp-gateway/src/config.js";
import { createMcpServer } from "../../services/mcp-gateway/src/mcp/server.js";

const outputUrl = new URL(
  "../../services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts",
  import.meta.url,
);
const outputPath = fileURLToPath(outputUrl);
const checkOnly = process.argv.slice(2).includes("--check");

const gatewayConfig = loadGatewayConfig({
  NODE_ENV: "test",
  PUBLIC_BASE_URL: "https://edge.invalid/",
  AUTH_MODE: "owner",
  OWNER_TOKEN: "x".repeat(32),
  WORKSPACE_BACKEND: "in-process",
});
const requiredScope = gatewayConfig.ownerOAuth?.scopes[0];
if (!requiredScope) {
  throw new Error("Canonical Gateway Owner configuration did not publish an MCP scope");
}

const server = createMcpServer({
  workspaceExecutor: {} as WorkspaceExecutor,
  sourceControlExecutor: {} as SourceControlExecutor,
  auth: {
    requiredScope,
    resourceMetadataUrl: new URL("https://edge.invalid/.well-known/oauth-protected-resource/mcp"),
  },
});
const client = new Client(
  { name: "edge-control-plane-manifest-generator", version: "0.0.0" },
  { capabilities: {} },
);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const listed = await client.listTools();
  const serverIdentity = client.getServerVersion();
  const catalogMetadata = listed._meta?.[MCP_TOOL_CATALOG_META_KEY];
  if (!serverIdentity || !catalogMetadata) {
    throw new Error("Canonical MCP server did not publish catalog identity");
  }

  const moduleSource = renderEdgeManifestModule({
    tools: canonicalize(listed.tools),
    catalogMetadata: canonicalize(catalogMetadata),
    serverIdentity: canonicalize(serverIdentity),
    requiredScope,
  });

  if (checkOnly) {
    let committed = "";
    try {
      committed = await readFile(outputPath, "utf8");
    } catch {
      throw new Error("Generated Edge MCP manifest is missing; run generator without --check");
    }
    if (committed !== moduleSource) {
      throw new Error("Generated Edge MCP manifest drift detected; regenerate from createMcpServer");
    }
  } else {
    await mkdir(new URL("./", outputUrl), { recursive: true });
    await writeFile(outputPath, moduleSource, "utf8");
  }
} finally {
  await client.close().catch(() => undefined);
  await server.close().catch(() => undefined);
}

function renderEdgeManifestModule(value: {
  tools: unknown;
  catalogMetadata: unknown;
  serverIdentity: unknown;
  requiredScope: string;
}): string {
  return [
    "// GENERATED FILE. DO NOT EDIT.",
    "// Source authority: services/mcp-gateway/src/mcp/server.ts createMcpServer() + canonical Gateway auth config.",
    "",
    `export const EDGE_MCP_REQUIRED_SCOPE = ${JSON.stringify(value.requiredScope)} as const;`,
    "",
    `export const EDGE_MCP_TOOL_MANIFEST = ${JSON.stringify(value.tools, null, 2)} as const;`,
    "",
    `export const EDGE_MCP_CATALOG_METADATA = ${JSON.stringify(value.catalogMetadata, null, 2)} as const;`,
    "",
    `export const EDGE_MCP_SERVER_IDENTITY = ${JSON.stringify(value.serverIdentity, null, 2)} as const;`,
    "",
  ].join("\n");
}

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
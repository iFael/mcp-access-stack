import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import type { SourceControlExecutor, WorkspaceExecutor } from "@vs-code-gpt/shared";
import { MCP_TOOL_CATALOG_META_KEY } from "@vs-code-gpt/shared";
import { loadGatewayConfig } from "../../mcp-gateway/src/config.js";
import { createMcpServer } from "../../mcp-gateway/src/mcp/server.js";
import {
  EDGE_MCP_CATALOG_METADATA,
  EDGE_MCP_REQUIRED_SCOPE,
  EDGE_MCP_SERVER_IDENTITY,
  EDGE_MCP_TOOL_MANIFEST,
} from "../src/generated/mcp-tool-manifest.js";

describe("Edge MCP generated manifest parity", () => {
  it("matches the canonical createMcpServer workspace catalog and auth scope exactly", async () => {
    const gatewayConfig = loadGatewayConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://edge.invalid/",
      AUTH_MODE: "owner",
      OWNER_TOKEN: "x".repeat(32),
      WORKSPACE_BACKEND: "in-process",
    });
    const canonicalScope = gatewayConfig.ownerOAuth?.scopes[0];
    expect(canonicalScope).toBeDefined();

    const server = createMcpServer({
      workspaceExecutor: {} as WorkspaceExecutor,
      sourceControlExecutor: {} as SourceControlExecutor,
      auth: {
        requiredScope: canonicalScope!,
        resourceMetadataUrl: new URL("https://edge.invalid/.well-known/oauth-protected-resource/mcp"),
      },
    });
    const client = new Client(
      { name: "edge-manifest-parity", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const listed = await client.listTools();
      const identity = client.getServerVersion();
      const catalogMetadata = listed._meta?.[MCP_TOOL_CATALOG_META_KEY];

      expect(identity).toBeDefined();
      expect(catalogMetadata).toBeDefined();
      expect(canonicalize(EDGE_MCP_TOOL_MANIFEST)).toEqual(canonicalize(listed.tools));
      expect(canonicalize(EDGE_MCP_CATALOG_METADATA)).toEqual(canonicalize(catalogMetadata));
      expect(EDGE_MCP_SERVER_IDENTITY).toEqual(identity);

      const scopes = new Set(
        listed.tools.flatMap((tool) =>
          (tool._meta?.securitySchemes ?? [])
            .filter((scheme) => scheme.type === "oauth2")
            .flatMap((scheme) => scheme.scopes ?? []),
        ),
      );
      expect(scopes).toEqual(new Set([canonicalScope]));
      expect(EDGE_MCP_REQUIRED_SCOPE).toBe(canonicalScope);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}
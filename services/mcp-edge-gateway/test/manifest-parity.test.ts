import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "@jest/globals";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolContractRevision,
  type SourceControlExecutor,
  type WorkspaceExecutor,
} from "@vs-code-gpt/shared";
import { createMcpServer } from "../../mcp-gateway/src/mcp/server.js";
import {
  EDGE_MCP_CATALOG_METADATA,
  EDGE_MCP_REQUIRED_SCOPE,
  EDGE_MCP_SERVER_IDENTITY,
  EDGE_MCP_SERVER_INSTRUCTIONS,
  EDGE_MCP_TOOL_MANIFEST,
} from "../src/generated/mcp-tool-manifest.js";

describe("Edge MCP generated manifest parity", () => {
  it("reserves the progress app for the progress tool and keeps ordinary tools card-free", () => {
    const metaFor = (name: string) => {
      const tool = EDGE_MCP_TOOL_MANIFEST.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      return tool!._meta as Record<string, unknown>;
    };
    for (const name of ["list_workspaces", "read_file", "browser_open", "browser_snapshot", "github_get_commit_checks"]) {
      const meta = metaFor(name);
      expect(meta).not.toHaveProperty("ui");
      expect(meta).not.toHaveProperty("openai/outputTemplate");
    }
    expect((metaFor("browser_progress").ui as Record<string, unknown>).resourceUri)
      .toBe("ui://mcp-v3/progress-v13.html");
    expect(metaFor("browser_progress_update")).not.toHaveProperty("openai/outputTemplate");
    expect((metaFor("github_get_pull_request").ui as Record<string, unknown>).resourceUri)
      .toBe("ui://mcp-v3/pull-request-v6.html");
    expect((metaFor("browser_user_messages").ui as Record<string, unknown>).resourceUri)
      .toBe("ui://mcp-v3/user-messages-v11.html");
    expect((metaFor("mcp_update").ui as Record<string, unknown>).resourceUri)
      .toBe("ui://mcp-v3/progress-v13.html");
    for (const name of ["browser_progress_read", "browser_user_reply"]) {
      const meta = metaFor(name);
      expect((meta.ui as Record<string, unknown>).visibility).toEqual(["app"]);
      expect(meta).not.toHaveProperty("openai/outputTemplate");
    }
  });

  it("requires the dedicated contract preparation secret without exposing it as a plaintext variable", () => {
    const config = JSON.parse(
      readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ) as {
      secrets?: { required?: string[] };
      vars?: Record<string, string>;
    };
    expect(config.secrets?.required).toEqual(["MCP_CONTRACT_PREPARE_TOKEN"]);
    expect(config.vars).not.toHaveProperty("MCP_CONTRACT_PREPARE_TOKEN");
    expect(config.secrets?.required).not.toContain("MCP_CONNECTOR_TOKEN");
    expect(config.secrets?.required).not.toContain("MCP_OWNER_TOKEN");
  });

  it("matches the canonical createMcpServer workspace catalog and auth scope exactly", async () => {
    const wranglerConfig = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    const canonicalScope = /"MCP_OWNER_OAUTH_SCOPES"\s*:\s*"([^"]+)"/u
      .exec(wranglerConfig)?.[1]
      ?.split(",")[0]
      ?.trim();
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
      expect(EDGE_MCP_CATALOG_METADATA.contractRevision).toBe(
        createMcpToolContractRevision(listed.tools),
      );
      expect(EDGE_MCP_SERVER_IDENTITY).toEqual(identity);
      expect(EDGE_MCP_SERVER_INSTRUCTIONS).toBe(client.getInstructions());

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

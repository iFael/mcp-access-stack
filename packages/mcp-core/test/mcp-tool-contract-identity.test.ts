import { describe, expect, it } from "@jest/globals";
import {
  createMcpToolCatalogMetadata,
  type McpToolDescriptorFingerprintInput,
} from "../src/mcp-tool-catalog.js";

const current: McpToolDescriptorFingerprintInput[] = [
  {
    name: "run_command",
    description: "Run one command",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        command: { type: "string" },
      },
      required: ["workspaceId", "command"],
    },
  },
];

const stale: McpToolDescriptorFingerprintInput[] = [
  {
    name: "run_command",
    description: "Run one command",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        command: { type: "string" },
        expectedOutcome: { type: "array" },
      },
      required: ["workspaceId", "command"],
    },
  },
];

describe("MCP catalog contract identity", () => {
  it("changes contract and server identity when descriptors change but tool names do not", () => {
    const currentMetadata = createMcpToolCatalogMetadata(current);
    const staleMetadata = createMcpToolCatalogMetadata(stale);

    expect(currentMetadata.toolSetRevision).toBe(staleMetadata.toolSetRevision);
    expect(currentMetadata.toolCount).toBe(staleMetadata.toolCount);
    expect(currentMetadata.contractRevision).not.toBe(staleMetadata.contractRevision);
    expect(currentMetadata.serverVersion).not.toBe(staleMetadata.serverVersion);
  });

  it("is deterministic regardless of descriptor registration order", () => {
    const tools: McpToolDescriptorFingerprintInput[] = [
      ...current,
      {
        name: "read_file",
        description: "Read one file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];

    expect(createMcpToolCatalogMetadata(tools)).toEqual(
      createMcpToolCatalogMetadata([...tools].reverse()),
    );
  });
});

import { describe, expect, it } from "@jest/globals";
import {
  persistMcpCatalogSnapshot,
  readMcpCatalogSnapshot,
} from "../src/control-plane/active-catalog.js";
import type { EdgeMcpCatalog } from "../src/control-plane/mcp-control-plane.js";

class MemoryStorage {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.data.set(key, structuredClone(value));
  }
}

function catalog(revision: string, prefix: string, toolCount = 9): EdgeMcpCatalog {
  return {
    manifest: Array.from({ length: toolCount }, (_, index) => ({
      name: `${prefix}_tool_${index}`,
      description: `${prefix} descriptor ${index}`,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    })),
    catalogMetadata: {
      contractRevision: revision,
      toolSetRevision: prefix.repeat(64).slice(0, 64),
      toolCount,
      serverVersion: `test-${prefix}`,
    },
    serverIdentity: {
      name: "vs-code-gpt",
      version: `test-${prefix}`,
    },
  };
}

describe("active MCP catalog snapshots", () => {
  it("round-trips one catalog through bounded chunks", async () => {
    const storage = new MemoryStorage();
    const revision = "a".repeat(64);
    const source = catalog(revision, "a");

    await expect(persistMcpCatalogSnapshot(storage, source)).resolves.toBe(revision);
    await expect(readMcpCatalogSnapshot(storage, revision)).resolves.toEqual(source);

    const chunkKeys = [...storage.data.keys()].filter((key) => key.includes(":chunk:"));
    expect(chunkKeys).toHaveLength(3);
  });

  it("keeps the active revision snapshot when a candidate revision is persisted", async () => {
    const storage = new MemoryStorage();
    const activeRevision = "a".repeat(64);
    const candidateRevision = "b".repeat(64);
    const active = catalog(activeRevision, "a");
    const candidate = catalog(candidateRevision, "b");

    await persistMcpCatalogSnapshot(storage, active);
    await persistMcpCatalogSnapshot(storage, candidate);

    await expect(readMcpCatalogSnapshot(storage, activeRevision)).resolves.toEqual(active);
    await expect(readMcpCatalogSnapshot(storage, candidateRevision)).resolves.toEqual(candidate);
  });

  it("returns null when the requested revision has no complete snapshot", async () => {
    const storage = new MemoryStorage();
    await expect(readMcpCatalogSnapshot(storage, "c".repeat(64))).resolves.toBeNull();
  });
});

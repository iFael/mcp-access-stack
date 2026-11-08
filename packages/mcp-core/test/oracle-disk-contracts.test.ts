import { describe, expect, it } from "@jest/globals";
import {
  oracleDiskAuditInputSchema,
  oracleDiskAuditResultSchema,
  relayOperations,
  relayResultSchemas,
} from "../src/index.js";

describe("Oracle disk audit public contract", () => {
  it("restricts the scope, input size and workspace", () => {
    expect(oracleDiskAuditInputSchema.parse({ workspaceId: "mcp-access-stack" })).toEqual({
      workspaceId: "mcp-access-stack", group: "root", start: 0, limit: 1,
    });
    for (const invalid of [
      { workspaceId: "ciclo" },
      { workspaceId: "mcp-access-stack", group: "/etc" },
      { workspaceId: "mcp-access-stack", group: "root", limit: 2 },
      { workspaceId: "mcp-access-stack", group: "releases", limit: 4 },
      { workspaceId: "mcp-access-stack", command: "sudo du" },
    ]) expect(oracleDiskAuditInputSchema.safeParse(invalid).success).toBe(false);
  });

  it("is a typed relay operation and rejects incomplete measured targets", () => {
    expect(relayOperations).toContain("oracleDiskAudit");
    expect(relayResultSchemas.oracleDiskAudit).toBe(oracleDiskAuditResultSchema);
    const response = {
      status: "ready", privileged: true, group: "root",
      start: 0, count: 1, nextStart: null, complete: true,
      filesystem: null, targets: [{ path: "/root", status: "measured", allocatedBytes: 4 }],
      measuredBytes: 4, warning: "Bounded read.",
    };
    expect(oracleDiskAuditResultSchema.safeParse(response).success).toBe(true);
    expect(oracleDiskAuditResultSchema.safeParse({
      ...response, targets: [{ path: "/root", status: "measured" }],
    }).success).toBe(false);
  });
});

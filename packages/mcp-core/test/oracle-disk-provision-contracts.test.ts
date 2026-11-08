import { describe, expect, it } from "@jest/globals";
import {
  ORACLE_DISK_AUDIT_PINNED_SHA256,
  oracleDiskAuditProvisionInputSchema,
  oracleDiskAuditProvisionResultSchema,
  relayOperations, relayResultSchemas,
} from "../src/index.js";

describe("Oracle disk audit root provision contracts", () => {
  it("accepts inspect without power and requires exact install intent", () => {
    expect(oracleDiskAuditProvisionInputSchema.parse({
      workspaceId: "mcp-access-stack", action: "inspect",
    })).toEqual({ workspaceId: "mcp-access-stack", action: "inspect" });
    const valid = {
      workspaceId: "mcp-access-stack", action: "install",
      operationId: "11111111-2222-4333-8444-555555555555",
      expectedSourceSha256: ORACLE_DISK_AUDIT_PINNED_SHA256,
    };
    expect(oracleDiskAuditProvisionInputSchema.safeParse(valid).success).toBe(true);
    for (const invalid of [
      { ...valid, workspaceId: "ciclo" },
      { ...valid, expectedSourceSha256: "f".repeat(64) },
      { ...valid, shell: "bash" },
      { ...valid, path: "/etc/shadow" },
      { ...valid, operationId: "not-a-uuid" },
      { ...valid, action: "root-shell" },
      { workspaceId: "mcp-access-stack", action: "inspect", command: "sudo" },
    ]) expect(oracleDiskAuditProvisionInputSchema.safeParse(invalid).success).toBe(false);
  });

  it("is a typed relay operation and returns explicit bootstrap state", () => {
    expect(relayOperations).toContain("oracleDiskAuditProvision");
    expect(relayResultSchemas.oracleDiskAuditProvision).toBe(oracleDiskAuditProvisionResultSchema);
    expect(oracleDiskAuditProvisionResultSchema.safeParse({
      status: "bootstrap_required", bootstrapPresent: false, auditPresent: false,
      pinnedSourceSha256: ORACLE_DISK_AUDIT_PINNED_SHA256,
      diagnostic: "host_root_bootstrap_required",
    }).success).toBe(true);
  });
});

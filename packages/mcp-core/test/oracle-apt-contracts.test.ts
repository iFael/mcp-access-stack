import { describe, expect, it } from "@jest/globals";
import { oracleAptMaintenanceInputSchema, oracleAptMaintenanceResultSchema,
  relayOperations, relayResultSchemas } from "../src/index.js";

const plan = { workspaceId: "mcp-access-stack", action: "plan",
  operation: "repair_oracle_kernel_dependencies" };
const apply = { ...plan, action: "apply", operationId: "11111111-2222-4333-8444-555555555555",
  expectedPlanSha256: "a".repeat(64) };

describe("Oracle APT maintenance contracts", () => {
  it("accepts only fixed operations, exact plan digest and operation ID", () => {
    for (const value of [plan, apply, { ...plan, operation: "install_browser_dependencies" },
      { workspaceId: plan.workspaceId, action: "status", operationId: apply.operationId }]) {
      expect(oracleAptMaintenanceInputSchema.safeParse(value).success).toBe(true);
    }
    for (const value of [
      { ...plan, workspaceId: "other" }, { ...plan, operation: "upgrade" },
      { ...apply, action: "root_shell" }, { ...apply, packages: ["openssh-server"] },
      { ...apply, command: "apt-get install anything" }, { ...apply, path: "/etc/sudoers" },
      { ...apply, expectedPlanSha256: "bad" }, { ...apply, operationId: "../escape" },
      { ...plan, operationId: apply.operationId }, { ...apply, expectedPlanSha256: undefined },
    ]) expect(oracleAptMaintenanceInputSchema.safeParse(value).success).toBe(false);
  });
  it("is a typed relay operation and cannot return arbitrary shell output", () => {
    expect(relayOperations).toContain("oracleAptMaintenance");
    expect(relayResultSchemas.oracleAptMaintenance).toBe(oracleAptMaintenanceResultSchema);
    expect(oracleAptMaintenanceResultSchema.safeParse({ status: "running", operationId: apply.operationId,
      operation: plan.operation, planSha256: apply.expectedPlanSha256,
      changes: [{ action: "install", package: "linux-modules-7.0.0-1013-oracle", version: "7.0.0-1013.13~24.04.1" }],
    }).success).toBe(true);
    expect(oracleAptMaintenanceResultSchema.safeParse({ status: "succeeded", stdout: "raw log" }).success).toBe(false);
    expect(oracleAptMaintenanceResultSchema.safeParse({ status: "ready", changes: [{ action: "remove", package: "kernel", version: "1" }] }).success).toBe(false);
  });
});

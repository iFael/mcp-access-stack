import { describe, expect, it, jest } from "@jest/globals";
import { oracleAptMaintenanceInputSchema } from "@vs-code-gpt/shared";
import { OracleAptMaintenanceService } from "../../src/oracle/oracle-apt-maintenance.js";

const plan = oracleAptMaintenanceInputSchema.parse({ workspaceId: "mcp-access-stack",
  action: "plan", operation: "repair_oracle_kernel_dependencies" });
const id = "11111111-2222-4333-8444-555555555555";
const apply = oracleAptMaintenanceInputSchema.parse({ ...plan, action: "apply",
  operationId: id, expectedPlanSha256: "a".repeat(64) });

describe("Oracle APT privileged bridge", () => {
  it("fails closed on Windows without invoking any helper", async () => {
    const run = jest.fn<() => Promise<string>>();
    await expect(new OracleAptMaintenanceService({ platform: "win32", run }).execute(plan))
      .resolves.toMatchObject({ status: "unavailable", diagnostic: "linux_only" });
    expect(run).not.toHaveBeenCalled();
  });
  it("reports a missing or denied root helper", async () => {
    for (const [code, diagnostic] of [["ENOENT", "helper_missing"], ["SUDO_DENIED", "root_policy_denied"]]) {
      const run = async () => { throw Object.assign(new Error("not available"), { code }); };
      await expect(new OracleAptMaintenanceService({ platform: "linux", run }).execute(plan))
        .resolves.toMatchObject({ status: "permission_required", diagnostic });
    }
  });
  it("checks the exact operation ID and plan digest of a dispatched job", async () => {
    const running = { status: "running", operation: "repair_oracle_kernel_dependencies",
      operationId: id, planSha256: "a".repeat(64) };
    const run = jest.fn(async () => JSON.stringify(running));
    await expect(new OracleAptMaintenanceService({ platform: "linux", run }).execute(apply)).resolves.toEqual(running);
    expect(run).toHaveBeenCalledTimes(1);
    for (const forged of [{ ...running, operationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      { ...running, planSha256: "b".repeat(64) }, { ...running, stdout: "secret log" }]) {
      await expect(new OracleAptMaintenanceService({ platform: "linux", run: async () => JSON.stringify(forged) })
        .execute(apply)).resolves.toMatchObject({ status: "outcome_unknown", diagnostic: "invalid_response", operationId: id });
    }
  });
  it("preserves the operation ID after disconnect rather than retrying", async () => {
    const run = jest.fn(async () => { throw new Error("lost reply"); });
    await expect(new OracleAptMaintenanceService({ platform: "linux", run }).execute(apply))
      .resolves.toMatchObject({ status: "outcome_unknown", operationId: id });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

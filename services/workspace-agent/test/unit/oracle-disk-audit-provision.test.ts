import { describe, expect, it } from "@jest/globals";
import { ORACLE_DISK_AUDIT_PINNED_SHA256, oracleDiskAuditProvisionInputSchema } from "@vs-code-gpt/shared";
import { OracleDiskAuditProvisionService } from "../../src/oracle/oracle-disk-audit-provision.js";

const inspect = oracleDiskAuditProvisionInputSchema.parse({
  workspaceId: "mcp-access-stack", action: "inspect",
});
const install = oracleDiskAuditProvisionInputSchema.parse({
  workspaceId: "mcp-access-stack", action: "install",
  operationId: "11111111-2222-4333-8444-555555555555",
  expectedSourceSha256: ORACLE_DISK_AUDIT_PINNED_SHA256,
});

describe("Oracle disk audit root provision service", () => {
  it("makes absent host-root bootstrap explicit without spawning anything", async () => {
    const service = new OracleDiskAuditProvisionService({
      platform: "linux", inspectRootFile: async () => false,
      runInstall: async () => { throw new Error("must not launch"); },
    });
    expect(await service.execute(inspect)).toMatchObject({
      status: "bootstrap_required", bootstrapPresent: false, auditPresent: false,
    });
    expect(await service.execute(install)).toMatchObject({
      status: "bootstrap_required", diagnostic: "host_root_bootstrap_required",
    });
  });

  it("checks pinned source then installs only the prepared root helper", async () => {
    let installed = false;
    let runs = 0;
    const service = new OracleDiskAuditProvisionService({
      platform: "linux",
      inspectRootFile: async path => path.includes("root-provision") || installed,
      sourceDigest: async () => ORACLE_DISK_AUDIT_PINNED_SHA256,
      runInstall: async () => {
        runs++;
        installed = true;
        return JSON.stringify({ status: "installed", capability: "disk-audit-read-only" });
      },
    });
    expect(await service.execute(inspect)).toMatchObject({ status: "ready" });
    expect(await service.execute(install)).toMatchObject({ status: "installed", auditPresent: true });
    expect(await service.execute(install)).toMatchObject({ status: "already_installed" });
    expect(runs).toBe(1);
  });

  it("never invokes privilege when release source digest changed", async () => {
    const service = new OracleDiskAuditProvisionService({
      platform: "linux", inspectRootFile: async path => path.includes("root-provision"),
      sourceDigest: async () => "f".repeat(64),
      runInstall: async () => { throw new Error("must not launch"); },
    });
    expect(await service.execute(install)).toMatchObject({
      status: "unavailable", diagnostic: "source_hash_mismatch",
    });
  });

  it("fails closed on rejected sudoers and uncertain post-start state", async () => {
    for (const [code, expected] of [
      ["EACCES", "permission_required"],
      ["EXECUTION_FAILED", "outcome_unknown"],
    ]) {
      const service = new OracleDiskAuditProvisionService({
        platform: "linux", inspectRootFile: async path => path.includes("root-provision"),
        sourceDigest: async () => ORACLE_DISK_AUDIT_PINNED_SHA256,
        runInstall: async () => { throw Object.assign(new Error("refused"), { code }); },
      });
      expect((await service.execute(install)).status).toBe(expected);
    }
  });

  it("does not attempt to run privileged setup on Windows", async () => {
    const service = new OracleDiskAuditProvisionService({
      platform: "win32",
      inspectRootFile: async () => { throw new Error("not called"); },
      runInstall: async () => { throw new Error("not called"); },
    });
    expect(await service.execute(install)).toMatchObject({
      status: "unavailable", diagnostic: "linux_only",
    });
  });
});

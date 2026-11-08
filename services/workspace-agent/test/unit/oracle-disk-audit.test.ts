import { describe, expect, it } from "@jest/globals";
import { OracleDiskAuditService } from "../../src/oracle/oracle-disk-audit.js";
import { oracleDiskAuditInputSchema } from "@vs-code-gpt/shared";

const input = oracleDiskAuditInputSchema.parse({
  workspaceId: "mcp-access-stack", group: "root", start: 0, limit: 1,
});
const response = {
  group: "root", start: 0, count: 6, nextStart: 1, complete: false,
  filesystem: { totalBytes: 1000, usedBytes: 800, availableBytes: 180 },
  targets: [{ path: "/root", status: "measured", allocatedBytes: 204 }],
  measuredBytes: 204,
  warning: "Partial measurements never justify treating the df-minus-du difference as reclaimable files.",
};

describe("Oracle privileged disk audit", () => {
  it("accepts bounded root results without arbitrary commands", async () => {
    const calls: unknown[] = [];
    const result = await new OracleDiskAuditService({
      platform: "linux",
      run: async (requested) => {
        calls.push(requested);
        return JSON.stringify(response);
      },
    }).audit(input);
    expect(result).toMatchObject({
      status: "ready", privileged: true, group: "root",
      targets: [{ path: "/root", allocatedBytes: 204 }],
      complete: false,
    });
    expect(calls).toEqual([input]);
  });

  it("fails closed on invalid or unexpected privileged output", async () => {
    for (const output of [
      "{",
      JSON.stringify({ ...response, group: "releases" }),
      JSON.stringify({ ...response, targets: [{ path: "/etc/passwd", status: "measured" }] }),
      JSON.stringify({ ...response, targets: [{ path: "/root", status: "measured", allocatedBytes: 204 }, ...response.targets] }),
    ]) {
      const result = await new OracleDiskAuditService({
        platform: "linux", run: async () => output,
      }).audit(input);
      expect(result).toMatchObject({ status: "unavailable", complete: false, diagnostic: "invalid_response" });
    }
  });

  it("returns a precise permission diagnosis, never attempts an alternate shell", async () => {
    const result = await new OracleDiskAuditService({
      platform: "linux",
      run: async () => { throw Object.assign(new Error("denied"), { code: "SUDO_DENIED" }); },
    }).audit(input);
    expect(result).toMatchObject({
      status: "permission_required", privileged: false,
      diagnostic: "sudo_permission_required", targets: [],
    });
  });

  it("stops outside the Oracle Linux node", async () => {
    const result = await new OracleDiskAuditService({
      platform: "win32", run: async () => { throw new Error("must not run"); },
    }).audit(input);
    expect(result).toMatchObject({ status: "unavailable", privileged: false });
  });
});

import { describe, expect, it } from "@jest/globals";
import { OracleInstanceInventoryService } from "../../src/oracle/oracle-instance-inventory.js";

const metadata = {
  compartmentId: "ocid1.compartment.oc1..comp",
  tenantId: "ocid1.tenancy.oc1..tenancy",
  region: "sa-saopaulo-1",
};
const running = {
  id: "ocid1.instance.oc1..running",
  "display-name": "MCP V3",
  "compartment-id": metadata.compartmentId,
  "lifecycle-state": "RUNNING",
  shape: "VM.Standard.E2.1.Micro",
  "shape-config": { ocpus: 1, "memory-in-gbs": 1 },
};
const stopped = {
  id: "ocid1.instance.oc1..stopped",
  "display-name": "Video worker",
  "compartment-id": metadata.compartmentId,
  "lifecycle-state": "STOPPED",
  shape: "VM.Standard.A1.Flex",
  "shape-config": { ocpus: 4, "memory-in-gbs": 24 },
};

describe("Oracle Cloud instance inventory (read-only instance principal)", () => {
  it("lists current-compartment instances without user credentials, mutation or arbitrary args", async () => {
    const calls: string[][] = [];
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async (args) => {
        calls.push([...args]);
        return { data: [running, stopped] };
      },
    });
    const result = await inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" });
    expect(result).toMatchObject({
      status: "ready",
      authentication: "instance_principal",
      complete: true,
      scope: "current_compartment",
      region: "sa-saopaulo-1",
      instances: [
        { name: "MCP V3", state: "RUNNING", shape: "VM.Standard.E2.1.Micro" },
        { name: "Video worker", state: "STOPPED", shape: "VM.Standard.A1.Flex", ocpus: 4, memoryGb: 24 },
      ],
    });
    expect(calls).toEqual([[
      "compute", "instance", "list",
      "--compartment-id", metadata.compartmentId,
      "--region", metadata.region, "--all",
    ]]);
    expect(JSON.stringify(result)).not.toContain("api_key");
  });

  it("supports official IMDSv2 metadata without tenantId and with a canonical region", async () => {
    const calls: string[][] = [];
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => ({
        compartmentId: metadata.compartmentId,
        region: "phx",
        canonicalRegionName: "us-phoenix-1",
      }),
      callOci: async (args) => {
        calls.push([...args]);
        return { data: [] };
      },
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" }))
      .resolves.toMatchObject({ status: "ready", region: "us-phoenix-1", complete: true });
    expect(calls[0]).toContain("us-phoenix-1");
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "accessible_tenancy" }))
      .resolves.toMatchObject({ status: "unavailable", diagnostic: "tenancy_discovery_unavailable", complete: false });
    expect(calls).toHaveLength(1);
  });

  it("supports a root tenancy as the instance compartment", async () => {
    const root = "ocid1.tenancy.oc1..root";
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => ({ compartmentId: root, regionInfo: { regionIdentifier: "us-ashburn-1" } }),
      callOci: async (args) =>
        args[0] === "compute" ? { data: [] } :
        args[1] === "region-subscription"
          ? { data: [{ status: "READY", "region-name": "us-ashburn-1" }] }
          : { data: [] },
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "accessible_tenancy" }))
      .resolves.toMatchObject({ status: "ready", complete: true, region: "us-ashburn-1", compartmentId: root });
  });

  it("returns an explicit diagnostic for unavailable IMDS identity without trying OCI", async () => {
    let called = false;
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => { throw new Error("metadata unavailable"); },
      callOci: async () => { called = true; return {}; },
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" }))
      .resolves.toMatchObject({ status: "unavailable", complete: false, diagnostic: "identity_unavailable", instances: [] });
    expect(called).toBe(false);
  });

  it("denies attempts on Windows even if the workspace ID matches", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "win32",
      readMetadata: async () => metadata,
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" }))
      .rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("reports IAM denial without leaking an OCI CLI stderr or partial inventory", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async () => { throw Object.assign(new Error("refused"), {
        stderr: "ServiceError: NotAuthorizedOrNotFound\nsecretToken=fake",
      }); },
    });
    const result = await inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" });
    expect(result).toMatchObject({
      status: "permission_denied", diagnostic: "instance_read_required", complete: false, instances: [],
    });
    expect(JSON.stringify(result)).not.toContain("secretToken");
  });

  it("reports missing OCI CLI instead of falling back to a user API key", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async () => { throw Object.assign(new Error("not found"), { code: "ENOENT" }); },
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" }))
      .resolves.toMatchObject({ status: "unavailable", diagnostic: "oci_cli_unavailable" });
  });

  it("inspects subscribed regions and accessible compartments before a full-scope list", async () => {
    const calls: string[][] = [];
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async (args) => {
        calls.push([...args]);
        if (args[0] === "iam" && args[1] === "region-subscription") return {
          data: [{ status: "READY", "region-name": metadata.region }],
        };
        if (args[0] === "iam" && args[1] === "compartment") return {
          data: [{ id: metadata.compartmentId, "lifecycle-state": "ACTIVE" }],
        };
        return { data: args.includes(metadata.compartmentId) ? [stopped] : [] };
      },
    });
    const result = await inventory.list({ workspaceId: "mcp-access-stack", scope: "accessible_tenancy" });
    expect(result).toMatchObject({
      status: "ready", complete: true, scope: "accessible_tenancy",
      instances: [{ name: "Video worker", state: "STOPPED" }],
    });
    expect(calls.map((args) => args.slice(0, 3))).toEqual([
      ["iam", "region-subscription", "list"],
      ["iam", "compartment", "list"],
      ["compute", "instance", "list"],
      ["compute", "instance", "list"],
    ]);
  });

  it("does not report a full inventory when tenancy IAM visibility is denied", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async () => { throw { stderr: "NotAuthorizedOrNotFound" }; },
    });
    const result = await inventory.list({ workspaceId: "mcp-access-stack", scope: "accessible_tenancy" });
    expect(result).toMatchObject({
      status: "permission_denied", diagnostic: "region_subscription_read_required", complete: false, instances: [],
    });
  });

  it("fails closed on malformed OCI records", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async () => ({ data: [{ id: "invalid-id" }] }),
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "current_compartment" }))
      .rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
  });

  it("bounds cross-region and cross-compartment inventory instead of silently truncating", async () => {
    const inventory = new OracleInstanceInventoryService({
      platform: "linux",
      readMetadata: async () => metadata,
      callOci: async (args) => {
        if (args[1] === "region-subscription") return {
          data: Array.from({ length: 5 }, (_, i) => ({ status: "READY", "region-name": i === 0 ? metadata.region : `us-region-${i}` })),
        };
        if (args[1] === "compartment") return {
          data: Array.from({ length: 5 }, (_, i) => ({ id: `ocid1.compartment.oc1..comp${i}`, "lifecycle-state": "ACTIVE" })),
        };
        throw new Error("No compute calls should run");
      },
    });
    await expect(inventory.list({ workspaceId: "mcp-access-stack", scope: "accessible_tenancy" }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

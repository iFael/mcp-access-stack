import { describe, expect, it } from "@jest/globals";
import {
  oracleListInstancesInputSchema,
  oracleListInstancesResultSchema,
  relayRequestSchema,
  relayResultSchemas,
} from "../src/index.js";

describe("OCI inventory public contract", () => {
  it("defaults to current compartment and refuses user-supplied credentials, commands and URLs", () => {
    expect(oracleListInstancesInputSchema.parse({ workspaceId: "mcp-access-stack" })).toEqual({
      workspaceId: "mcp-access-stack", scope: "current_compartment",
    });
    for (const invalid of [
      { workspaceId: "other", scope: "current_compartment" },
      { workspaceId: "mcp-access-stack", scope: "global" },
      { workspaceId: "mcp-access-stack", command: "start" },
      { workspaceId: "mcp-access-stack", url: "http://169.254.169.254" },
      { workspaceId: "mcp-access-stack", apiKey: "sensitive" },
    ]) {
      expect(oracleListInstancesInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates a scoped read-only relay operation and its exact result", () => {
    const request = {
      version: 1, type: "request", requestId: "123e4567-e89b-42d3-a456-426614174000",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      operation: "oracleListInstances", input: { workspaceId: "mcp-access-stack" },
    };
    // The schema must have the new capability; legacy operation names cannot
    // silently route an unvalidated arbitrary command.
    expect(relayRequestSchema.options.some((schema) =>
      schema.shape.operation.value === "oracleListInstances"
    )).toBe(true);
    expect(relayResultSchemas.oracleListInstances).toBe(oracleListInstancesResultSchema);
    expect(oracleListInstancesResultSchema.safeParse({
      status: "permission_denied", authentication: "instance_principal",
      scope: "accessible_tenancy", complete: false,
      region: "sa-saopaulo-1", compartmentId: "ocid1.compartment.oc1..demo",
      instances: [], diagnostic: "compartment_inspect_required",
    }).success).toBe(true);
    expect(oracleListInstancesResultSchema.safeParse({
      status: "ready", authentication: "user_api_key", scope: "current_compartment",
      complete: true, region: null, compartmentId: null, instances: [],
    }).success).toBe(false);
  });
});

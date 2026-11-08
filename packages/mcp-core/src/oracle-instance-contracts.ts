import { z } from "zod";

/**
 * Read-only Oracle Cloud inventory. Workspace and scope are fixed/bounded;
 * no command, URL, credentials or arbitrary OCI account is accepted.
 */
export const oracleListInstancesInputSchema = z.object({
  workspaceId: z.literal("mcp-access-stack"),
  scope: z.enum(["current_compartment", "accessible_tenancy"]).default("current_compartment"),
}).strict();
export type OracleListInstancesInput = z.infer<typeof oracleListInstancesInputSchema>;

const instanceSchema = z.object({
  id: z.string().regex(/^ocid1\.instance\./u),
  name: z.string().max(255),
  state: z.string().max(64),
  shape: z.string().max(128),
  region: z.string().max(64),
  compartmentId: z.string().regex(/^ocid1\.compartment\.|^ocid1\.tenancy\./u),
  availabilityDomain: z.string().max(128).optional(),
  ocpus: z.number().nonnegative().optional(),
  memoryGb: z.number().nonnegative().optional(),
}).strict();

export const oracleListInstancesResultSchema = z.object({
  status: z.enum(["ready", "permission_denied", "unavailable"]),
  authentication: z.literal("instance_principal"),
  scope: z.enum(["current_compartment", "accessible_tenancy"]),
  complete: z.boolean(),
  region: z.string().max(64).nullable(),
  compartmentId: z.string().nullable(),
  instances: z.array(instanceSchema).max(500),
  diagnostic: z.enum([
    "identity_unavailable",
    "tenancy_discovery_unavailable",
    "oci_cli_unavailable",
    "instance_read_required",
    "compartment_inspect_required",
    "region_subscription_read_required",
    "oci_request_unavailable",
  ]).optional(),
}).strict();
export type OracleListInstancesResult = z.infer<typeof oracleListInstancesResultSchema>;

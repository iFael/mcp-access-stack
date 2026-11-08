import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { get } from "node:http";
import { promisify } from "node:util";
import {
  AppError,
  oracleListInstancesResultSchema,
  type OracleListInstancesInput,
  type OracleListInstancesResult,
} from "@vs-code-gpt/shared";

const execute = promisify(execFile);
const METADATA_ENDPOINT = "http://169.254.169.254/opc/v2/instance/";
const OCI_ID = /^ocid1\.(?:instance|compartment|tenancy)\.[A-Za-z0-9._-]+$/u;
const REGION = /^[a-z0-9-]{3,64}$/u;
const MAX_QUERIES = 16;
const MAX_ITEMS = 500;

type InstanceMetadata = {
  compartmentId: string;
  tenantId?: string;
  region: string;
};

type InventoryInstance = OracleListInstancesResult["instances"][number];

type OciCall = (args: readonly string[], signal?: AbortSignal) => Promise<unknown>;
type MetadataRead = (signal?: AbortSignal) => Promise<unknown>;

export interface OracleInstanceInventoryDependencies {
  callOci?: OciCall;
  readMetadata?: MetadataRead;
  platform?: NodeJS.Platform;
}

/**
 * This service never launches a shell and never accepts executable, API target,
 * account identity, or arbitrary OCI arguments from the caller.
 */
export class OracleInstanceInventoryService {
  private readonly callOci: OciCall;
  private readonly readMetadata: MetadataRead;
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: OracleInstanceInventoryDependencies = {}) {
    this.callOci = dependencies.callOci ?? callInstancePrincipalOci;
    this.readMetadata = dependencies.readMetadata ?? readInstanceMetadata;
    this.platform = dependencies.platform ?? process.platform;
  }

  async list(
    input: OracleListInstancesInput,
    signal?: AbortSignal,
  ): Promise<OracleListInstancesResult> {
    if (this.platform !== "linux") {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle inventory is available only on the Linux execution node.");
    }
    const unavailable = (
      diagnostic: NonNullable<OracleListInstancesResult["diagnostic"]>,
      region: string | null = null,
      compartmentId: string | null = null,
    ): OracleListInstancesResult => oracleListInstancesResultSchema.parse({
      status: diagnostic.endsWith("_required") ? "permission_denied" : "unavailable",
      authentication: "instance_principal",
      scope: input.scope,
      complete: false,
      region,
      compartmentId,
      instances: [],
      diagnostic,
    });

    let metadata: InstanceMetadata;
    try {
      metadata = parseMetadata(await this.readMetadata(signal));
    } catch {
      return unavailable("identity_unavailable");
    }

    const query = async (
      args: readonly string[],
      onDenied: NonNullable<OracleListInstancesResult["diagnostic"]>,
    ): Promise<unknown> => {
      try {
        return await this.callOci(args, signal);
      } catch (error) {
        if (error instanceof AppError && error.code === "AUTHENTICATION_FAILED") {
          throw new OracleInventoryDiagnostic(onDenied);
        }
        if (isIamDenial(error)) throw new OracleInventoryDiagnostic(onDenied);
        if (isCliUnavailable(error)) throw new OracleInventoryDiagnostic("oci_cli_unavailable");
        throw new OracleInventoryDiagnostic("oci_request_unavailable");
      }
    };

    try {
      let regions = [metadata.region];
      let compartments = [metadata.compartmentId];
      if (input.scope === "accessible_tenancy") {
        const tenantId = metadata.tenantId;
        if (!tenantId) return unavailable("tenancy_discovery_unavailable", metadata.region, metadata.compartmentId);
        const subscribed = asDataArray(await query([
          "iam", "region-subscription", "list", "--tenancy-id", tenantId, "--all",
        ], "region_subscription_read_required"));
        regions = [...new Set(subscribed.flatMap((value): string[] => {
          if (!isObject(value) || value.status !== "READY") return [];
          const name = value["region-name"];
          return typeof name === "string" && REGION.test(name) ? [name] : [];
        }))];
        if (!regions.includes(metadata.region)) {
          throw new OracleInventoryDiagnostic("region_subscription_read_required");
        }
        const accessible = asDataArray(await query([
          "iam", "compartment", "list",
          "--compartment-id", tenantId, "--compartment-id-in-subtree", "true",
          "--access-level", "ACCESSIBLE", "--all",
        ], "compartment_inspect_required"));
        compartments = [...new Set([tenantId, ...accessible.flatMap((value): string[] => {
          if (!isObject(value) || value["lifecycle-state"] !== "ACTIVE") return [];
          const id = value.id;
          return typeof id === "string" && OCI_ID.test(id) && id.startsWith("ocid1.compartment.") ? [id] : [];
        })])];
      }
      if (regions.length === 0 || compartments.length === 0 ||
          regions.length * compartments.length > MAX_QUERIES) {
        throw new AppError("LIMIT_EXCEEDED", "Oracle inventory requires more regions/compartments than the bounded read-only query supports.");
      }
      const instances: InventoryInstance[] = [];
      for (const region of regions) {
        for (const compartmentId of compartments) {
          const found = asDataArray(await query([
            "compute", "instance", "list", "--compartment-id", compartmentId,
            "--region", region, "--all",
          ], "instance_read_required"));
          for (const value of found) {
            const entry = parseInstance(value, region);
            instances.push(entry);
            if (instances.length > MAX_ITEMS) {
              throw new AppError("LIMIT_EXCEEDED", "Oracle instance inventory exceeds the bounded response size.");
            }
          }
        }
      }
      return oracleListInstancesResultSchema.parse({
        status: "ready",
        authentication: "instance_principal",
        scope: input.scope,
        complete: true,
        region: metadata.region,
        compartmentId: metadata.compartmentId,
        instances,
      });
    } catch (error) {
      if (error instanceof OracleInventoryDiagnostic) {
        return unavailable(error.diagnostic, metadata.region, metadata.compartmentId);
      }
      throw error;
    }
  }
}

class OracleInventoryDiagnostic extends Error {
  constructor(readonly diagnostic: NonNullable<OracleListInstancesResult["diagnostic"]>) {
    super(diagnostic);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseMetadata(value: unknown): InstanceMetadata {
  if (!isObject(value)) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle instance metadata is missing or invalid.");
  }
  const compartmentId = value.compartmentId;
  const regionInfo = isObject(value.regionInfo) ? value.regionInfo : {};
  const region = typeof value.canonicalRegionName === "string" ? value.canonicalRegionName
    : typeof regionInfo.regionIdentifier === "string" ? regionInfo.regionIdentifier : value.region;
  if (typeof compartmentId !== "string" || !OCI_ID.test(compartmentId) ||
      !(compartmentId.startsWith("ocid1.compartment.") || compartmentId.startsWith("ocid1.tenancy.")) ||
      typeof region !== "string" || !REGION.test(region)) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Oracle instance metadata is missing or invalid.");
  }
  const providedTenancy = value.tenantId;
  const tenantId = typeof providedTenancy === "string" &&
    providedTenancy.startsWith("ocid1.tenancy.") && OCI_ID.test(providedTenancy)
    ? providedTenancy
    : compartmentId.startsWith("ocid1.tenancy.") ? compartmentId : undefined;
  return { compartmentId, region, ...(tenantId === undefined ? {} : { tenantId }) };
}

function asDataArray(value: unknown): unknown[] {
  if (!isObject(value) || !Array.isArray(value.data)) {
    throw new AppError("EXECUTION_STATE_INVALID", "OCI returned an unexpected inventory response.");
  }
  return value.data;
}

function parseInstance(value: unknown, region: string): InventoryInstance {
  if (!isObject(value) || typeof value.id !== "string" ||
      !value.id.startsWith("ocid1.instance.") || !OCI_ID.test(value.id) ||
      typeof value["compartment-id"] !== "string" ||
      !OCI_ID.test(value["compartment-id"]) ||
      typeof value.shape !== "string" || typeof value["lifecycle-state"] !== "string") {
    throw new AppError("EXECUTION_STATE_INVALID", "OCI returned invalid instance details.");
  }
  const shapeConfig = isObject(value["shape-config"]) ? value["shape-config"] : {};
  const ocpus = shapeConfig.ocpus;
  const memory = shapeConfig["memory-in-gbs"];
  return {
    id: value.id,
    name: typeof value["display-name"] === "string" ? value["display-name"].slice(0, 255) : "",
    state: value["lifecycle-state"].slice(0, 64),
    shape: value.shape.slice(0, 128),
    region,
    compartmentId: value["compartment-id"],
    ...(typeof value["availability-domain"] === "string"
      ? { availabilityDomain: value["availability-domain"].slice(0, 128) } : {}),
    ...(typeof ocpus === "number" && Number.isFinite(ocpus) && ocpus >= 0 ? { ocpus } : {}),
    ...(typeof memory === "number" && Number.isFinite(memory) && memory >= 0 ? { memoryGb: memory } : {}),
  };
}

function isIamDenial(error: unknown): boolean {
  if (error instanceof AppError) return error.code === "PERMISSION_DENIED";
  if (!isObject(error)) return false;
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  return /NotAuthorizedOrNotFound|NotAuthenticated|NotAuthorized|\b(?:401|403)\b/iu.test(stderr);
}

function isCliUnavailable(error: unknown): boolean {
  return isObject(error) && (error.code === "ENOENT" || error.code === "EACCES");
}

async function callInstancePrincipalOci(
  args: readonly string[],
  signal?: AbortSignal,
): Promise<unknown> {
  const executable = [
    path.join(homedir(), ".local", "bin", "oci"),
    "/var/lib/mcp-access-stack/.local/bin/oci",
    "/usr/local/bin/oci",
    "/usr/bin/oci",
  ].find((value) => existsSync(value));
  if (!executable) throw Object.assign(new Error("OCI CLI executable unavailable"), { code: "ENOENT" });
  const { stdout } = await execute(executable, [
    ...args, "--auth", "instance_principal", "--output", "json",
  ], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal });
  return JSON.parse(stdout) as unknown;
}

/** Fixed Oracle metadata endpoint, no user-supplied URL and no redirects. */
function readInstanceMetadata(signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(METADATA_ENDPOINT, {
      headers: { Authorization: "Bearer Oracle" },
      timeout: 3_000,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("Oracle metadata unavailable."));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 32_768) {
          request.destroy(new Error("Oracle metadata exceeded limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown); }
        catch { reject(new Error("Invalid Oracle metadata.")); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Oracle metadata timed out.")));
    request.on("error", reject);
    if (signal) {
      if (signal.aborted) { request.destroy(new Error("Operation cancelled.")); return; }
      signal.addEventListener("abort", () => request.destroy(new Error("Operation cancelled.")), { once: true });
    }
  });
}

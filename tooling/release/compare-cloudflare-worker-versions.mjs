import { pathToFileURL } from "node:url";
import path from "node:path";

const API = "https://api.cloudflare.com/client/v4/accounts/";
const SCRIPT = "mcp-access-stack";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const MAX_BYTES = 256 * 1024;
const SAFE_SOURCES = new Set([
  "unknown", "api", "wrangler", "terraform", "dash", "cf_cli",
  "dash_template", "integration", "quick_editor", "playground", "workersci",
]);

function safeSource(value) {
  return typeof value === "string" && SAFE_SOURCES.has(value)
    ? value : "unverified";
}

function safeTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}

export class ProvenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProvenanceError";
    this.code = code;
  }
}

function requireString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ProvenanceError(code);
  }
  return value;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function boundedJson(response) {
  if (response.status !== 200) throw new ProvenanceError("CLOUDFLARE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw new ProvenanceError("RESPONSE_STREAM_INVALID");
  const chunks = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_BYTES) throw new ProvenanceError("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const bytes = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ProvenanceError("RESPONSE_JSON_INVALID");
  }
}

function unwrap(payload) {
  if (!record(payload) || payload.success !== true || !record(payload.result)) {
    throw new ProvenanceError("RESPONSE_SHAPE_INVALID");
  }
  return payload.result;
}

function deployment(payload) {
  const entries = unwrap(payload).deployments;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > 100) {
    throw new ProvenanceError("DEPLOYMENT_LIST_INVALID");
  }
  const parsed = entries.map((item) => {
    if (!record(item) || !UUID.test(item.id) ||
        typeof item.created_on !== "string" ||
        !Number.isFinite(Date.parse(item.created_on)) ||
        !Array.isArray(item.versions) || item.versions.length < 1) {
      throw new ProvenanceError("DEPLOYMENT_SHAPE_INVALID");
    }
    const versions = item.versions.map((version) => {
      if (!record(version) || !UUID.test(version.version_id) ||
          !Number.isFinite(version.percentage) || version.percentage <= 0 ||
          version.percentage > 100) {
        throw new ProvenanceError("DEPLOYMENT_TRAFFIC_INVALID");
      }
      return { id: version.version_id, percentage: version.percentage };
    });
    if (Math.abs(versions.reduce((sum, v) => sum + v.percentage, 0) - 100) > 0.001) {
      throw new ProvenanceError("DEPLOYMENT_TRAFFIC_INVALID");
    }
    return {
      id: item.id,
      createdOn: new Date(item.created_on).toISOString(),
      source: safeSource(item.source),
      versions,
    };
  });
  // Cloudflare documents the FIRST deployment as the active one. Do not
  // infer active traffic from timestamps, which can differ across records.
  const latest = parsed[0];
  if (latest.versions.length !== 1 || latest.versions[0].percentage !== 100) {
    throw new ProvenanceError("TRAFFIC_SPLIT_UNSUPPORTED");
  }
  return {
    id: latest.id,
    versionId: latest.versions[0].id,
    createdOn: latest.createdOn,
    source: latest.source,
  };
}

function version(payload, requestedId) {
  const data = unwrap(payload);
  if (data.id !== requestedId || !record(data.resources)) {
    throw new ProvenanceError("VERSION_ID_MISMATCH");
  }
  const etag = data.resources.script?.etag;
  const scriptEtag = typeof etag === "string" && /^[a-fA-F0-9]{16,128}$/u.test(etag)
    ? etag.toLowerCase() : null;
  const runtime = data.resources.script_runtime;
  let runtimeConfig = null;
  if (record(runtime) && typeof runtime.compatibility_date === "string" &&
      Array.isArray(runtime.compatibility_flags) &&
      runtime.compatibility_flags.every((flag) => typeof flag === "string")) {
    runtimeConfig = JSON.stringify([
      runtime.compatibility_date,
      [...runtime.compatibility_flags].sort(),
    ]);
  }
  const bindings = data.resources.bindings;
  let bindingMetadata = null;
  if (record(bindings)) {
    const descriptors = Object.entries(bindings);
    if (descriptors.every(([name, value]) =>
      typeof name === "string" && record(value) && typeof value.type === "string")) {
      bindingMetadata = JSON.stringify(descriptors
        .map(([name, value]) => [name, value.type])
        .sort(([a], [b]) => a.localeCompare(b)));
    } else if (descriptors.length === 0) {
      bindingMetadata = "[]";
    }
  }
  return {
    scriptEtag, runtimeConfig, bindingMetadata,
    source: safeSource(data.metadata?.source),
    createdOn: safeTimestamp(data.metadata?.created_on),
  };
}

function parity(left, right) {
  return left === null || right === null ? "unverified" :
    left === right ? "matching" : "different";
}

export async function compareWorkerVersions(input, fetchImpl = fetch) {
  const accountId = requireString(input.accountId, ACCOUNT, "ACCOUNT_ID_INVALID");
  const referenceVersionId = requireString(
    input.referenceVersionId, UUID, "REFERENCE_VERSION_INVALID");
  if (typeof input.token !== "string" || input.token.length < 12) {
    throw new ProvenanceError("READ_TOKEN_MISSING");
  }
  const prefix = API + accountId + "/workers/scripts/" + SCRIPT;
  const read = async (suffix) => {
    let response;
    try {
      response = await fetchImpl(prefix + suffix, {
        method: "GET",
        headers: {
          authorization: "Bearer " + input.token,
          accept: "application/json",
          "user-agent": "mcp-cloudflare-version-provenance",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ProvenanceError("CLOUDFLARE_NETWORK_FAILED");
    }
    return boundedJson(response);
  };

  const first = deployment(await read("/deployments"));
  const active = version(
    await read("/versions/" + first.versionId), first.versionId);
  const reference = first.versionId === referenceVersionId
    ? active : version(
      await read("/versions/" + referenceVersionId), referenceVersionId);
  const second = deployment(await read("/deployments"));
  if (first.id !== second.id || first.versionId !== second.versionId ||
      first.createdOn !== second.createdOn || first.source !== second.source) {
    throw new ProvenanceError("DEPLOYMENT_CHANGED_DURING_READ");
  }
  const scriptEtagEqual = active.scriptEtag && reference.scriptEtag
    ? active.scriptEtag === reference.scriptEtag : null;
  return {
    worker: SCRIPT,
    activeDeploymentId: first.id,
    activeVersionId: first.versionId,
    referenceVersionId,
    deploymentSource: first.source,
    deploymentCreatedOn: first.createdOn,
    activeVersionSource: active.source,
    activeVersionCreatedOn: active.createdOn,
    referenceVersionSource: reference.source,
    referenceVersionCreatedOn: reference.createdOn,
    // Source/timestamps are evidence for review, NOT proof of what action
    // created the deployment, nor evidence that secret VALUES are equal.
    scriptEtagEqual,
    runtimeMetadataParity: parity(active.runtimeConfig, reference.runtimeConfig),
    bindingMetadataParity: parity(active.bindingMetadata, reference.bindingMetadata),
    secretValueParity: "unverified",
    status: scriptEtagEqual === null ? "inconclusive" :
      scriptEtagEqual ? "matching_script" : "different_script",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await compareWorkerVersions({
      accountId: process.env.CF_ACCOUNT_ID,
      token: process.env.CF_PROVENANCE_READ_TOKEN,
      referenceVersionId: process.env.REFERENCE_VERSION_ID,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("provenance: " + (error instanceof ProvenanceError
      ? error.code : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  }
}

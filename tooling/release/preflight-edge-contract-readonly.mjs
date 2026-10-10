import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";

const REVISION = /^[a-f0-9]{64}$/u;
const VERSION = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_RESPONSE_BYTES = 4096;

export class EdgePreflightError extends Error {
  constructor(code) {
    super(code);
    this.name = "EdgePreflightError";
    this.code = code;
  }
}
function deny(code) { throw new EdgePreflightError(code); }
function validRevision(s) { return typeof s === "string" && REVISION.test(s); }

function validateInputs(input) {
  if (!validRevision(input.nextRevision) || !validRevision(input.trustedRevision)) deny("REVISION_INPUT_INVALID");
  if (typeof input.trustedVersionId !== "string" || !VERSION.test(input.trustedVersionId)) {
    // Version ID is configured only after an independently approved safe bridge deploy.
    // Missing approval must NOT cause a request to the legacy Worker.
    deny("SAFE_INSPECTION_VERSION_NOT_APPROVED");
  }
  if (typeof input.inspectionToken !== "string" || input.inspectionToken.length < 12 ||
      typeof input.cloudflareToken !== "string" || input.cloudflareToken.length < 12) {
    deny("READ_CREDENTIAL_UNAVAILABLE");
  }
  let url;
  try { url = new URL(input.edgeBaseUrl); } catch { deny("EDGE_BASE_URL_INVALID"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" ||
      url.search || url.hash || !url.hostname) deny("EDGE_BASE_URL_INVALID");
  return url;
}

function verifySafeVersion(provenance, trustedVersionId) {
  if (provenance.activeVersionId !== trustedVersionId ||
      provenance.referenceVersionId !== trustedVersionId ||
      provenance.status !== "matching_script" ||
      provenance.scriptEtagEqual !== true ||
      // Same immutable active/reference Version ID is the security boundary.
      // Cloudflare may omit optional runtime/binding metadata even for that
      // exact version. Absence is not a contradiction; explicit drift is.
      !["matching", "unverified"].includes(provenance.runtimeMetadataParity) ||
      !["matching", "unverified"].includes(provenance.bindingMetadataParity)) {
    deny("ACTIVE_SCRIPT_NOT_APPROVED_FOR_INSPECTION");
  }
}

async function readBoundedJson(response) {
  if (response.status !== 200 || response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    deny("INSPECTION_RESPONSE_INVALID");
  }
  const reader = response.body?.getReader();
  if (!reader) deny("INSPECTION_RESPONSE_INVALID");
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) deny("INSPECTION_RESPONSE_TOO_LARGE");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  } catch { deny("INSPECTION_RESPONSE_INVALID"); }
}

function validateRollout(status, trustedRevision, nextRevision) {
  if (!status || typeof status !== "object" || Array.isArray(status) ||
      !validRevision(status.activeContractRevision) ||
      (status.candidateContractRevision !== undefined && !validRevision(status.candidateContractRevision)) ||
      (status.candidateContractRevision !== undefined &&
        status.candidateContractRevision === status.activeContractRevision) ||
      typeof status.candidateConnectorReady !== "boolean") {
    deny("ROLLOUT_STATUS_INVALID");
  }
  const active = status.activeContractRevision;
  const candidate = status.candidateContractRevision;
  if (trustedRevision !== nextRevision) {
    if (active !== trustedRevision) {
      deny("CONTRACT_CHANGE_REQUIRES_STABLE_PREVIOUS_EDGE");
    }
    if (candidate !== undefined) {
      deny("CONTRACT_CHANGE_HAS_EXISTING_CANDIDATE");
    }
  } else if (candidate !== undefined && candidate !== nextRevision) {
    deny("CONTRACT_CANDIDATE_CONFLICT");
  }
  if (trustedRevision === nextRevision && active !== nextRevision && candidate !== nextRevision) {
    deny("CONTRACT_NOT_ACTIVE_OR_PREPARED");
  }
  return { activeRevision: active, candidateRevision: candidate ?? null };
}

/**
 * Pre-deploy observation is allowed ONLY after Cloudflare API proves that the
 * active immutable Worker version is an independently approved read-only
 * inspection version. No /health or DO-backed call occurs before that gate.
 */
export async function preflightEdgeContract(input, {
  compare = compareWorkerVersions, fetchImpl = fetch,
} = {}) {
  const base = validateInputs(input);
  const cloudflareInput = {
    accountId: input.accountId, token: input.cloudflareToken,
    referenceVersionId: input.trustedVersionId,
  };
  let prior;
  try { prior = await compare(cloudflareInput); } catch { deny("SCRIPT_PROVENANCE_UNAVAILABLE"); }
  verifySafeVersion(prior, input.trustedVersionId);
  let response;
  try {
    response = await fetchImpl(new URL("/_internal/contract-rollout/status", base), {
      method: "GET", headers: {
        authorization: "Bearer " + input.inspectionToken,
        accept: "application/json",
      },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch { deny("INSPECTION_UNAVAILABLE"); }
  const body = await readBoundedJson(response);
  const rollout = validateRollout(body, input.trustedRevision, input.nextRevision);
  let after;
  try { after = await compare(cloudflareInput); } catch { deny("SCRIPT_PROVENANCE_UNAVAILABLE"); }
  verifySafeVersion(after, input.trustedVersionId);
  if (after.activeDeploymentId !== prior.activeDeploymentId ||
      after.activeVersionId !== prior.activeVersionId) deny("DEPLOYMENT_CHANGED_DURING_PREFLIGHT");
  return rollout;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await preflightEdgeContract({
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
      inspectionToken: process.env.MCP_CONTRACT_PREPARE_TOKEN,
      trustedVersionId: process.env.EDGE_SAFE_INSPECTION_VERSION_ID,
      trustedRevision: process.env.EDGE_SAFE_INSPECTION_CONTRACT_REVISION,
      nextRevision: process.env.EXPECTED_CONTRACT_REVISION,
      edgeBaseUrl: process.env.EDGE_BASE_URL,
    });
    if (!process.env.GITHUB_OUTPUT) deny("GITHUB_OUTPUT_UNAVAILABLE");
    appendFileSync(process.env.GITHUB_OUTPUT, "active-revision=" + result.activeRevision + "\n", "utf8");
    console.log("Edge preflight passed against approved read-only inspection version.");
  } catch (error) {
    console.error("Edge preflight refused: " +
      (error instanceof EdgePreflightError ? error.code : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  }
}

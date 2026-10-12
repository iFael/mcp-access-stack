import { pathToFileURL } from "node:url";
import path from "node:path";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";

// Immutable, source-pinned bridge between a deployed beta.84 contract and the
// signed Oracle f09 candidate. Never accept arbitrary versions or revisions.
export const PIN = Object.freeze({
  worker: "mcp-access-stack",
  sourceCommit: "f09ef38b5fa122b7b74fe69004c5df6f9450545f",
  stageRunId: "38216383251",
  oldDeployment: "10535ed8-c51b-418e-a387-3cf9ba8fde82",
  oldVersion: "7b536d5f-8afb-4da0-927e-44cf6e23b6d6",
  targetVersion: "562c6fc3-78c7-4365-9c47-cc307f8c755e",
  activeRevision: "39889807df9cb6f09fdb51a1940fce4783de302c1fd161f0429061a9a27e264c",
  oldCandidate: "a35a966fee8333618c3018e2b621196a64860dc3d6d578a6d4173d09ee984e59",
  newCandidate: "da7f5d3967de5325b5daa36951ce87417767a308ebf5eb0d3a999019d7780c92",
  edgeBaseUrl: "https://mcp-access-stack.rafaeldamasio77.workers.dev",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HEX32 = /^[a-f0-9]{32}$/u;
const RUN = /^[1-9][0-9]{4,20}$/u;
const API = "https://api.cloudflare.com/client/v4/accounts/";

export class ActivationRefused extends Error {
  constructor(code) { super(code); this.name = "ActivationRefused"; }
}
function deny(code) { throw new ActivationRefused(code); }
function object(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }

export function parseInput(env) {
  if (!HEX32.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      typeof env.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 12 ||
      !UUID.test(env.EDGE_CAS_OPERATION_ID ?? "") ||
      !RUN.test(env.GITHUB_RUN_ID ?? "") || env.GITHUB_RUN_ATTEMPT !== "1") deny("INPUT_INVALID");
  const newDeployment = env.EDGE_NEW_DEPLOYMENT_ID;
  if (newDeployment !== undefined && !UUID.test(newDeployment)) deny("DEPLOYMENT_RECEIPT_INPUT_INVALID");
  return {
    account: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    prepareToken: env.MCP_CONTRACT_PREPARE_TOKEN,
    operationId: env.EDGE_CAS_OPERATION_ID,
    runId: env.GITHUB_RUN_ID,
    newDeployment,
  };
}

export function verifyProvenance(p, phase, expectedDeployment = undefined) {
  if (!object(p) || p.worker !== PIN.worker || p.referenceVersionId !== PIN.targetVersion ||
      p.activeDeploymentId !== (expectedDeployment ?? PIN.oldDeployment) ||
      p.activeVersionId !== (phase === "before" ? PIN.oldVersion : PIN.targetVersion) ||
      p.referenceVersionSource !== "wrangler" ||
      p.referenceBindingInspection?.namePresence !== "present" ||
      p.referenceBindingInspection?.type !== "secret_text" ||
      !["matching", "unverified"].includes(p.runtimeMetadataParity) ||
      !["matching", "unverified"].includes(p.bindingMetadataParity) ||
      (phase === "before" && (p.status !== "different_script" || p.scriptEtagEqual !== false)) ||
      (phase === "after" && (p.status !== "matching_script" || p.scriptEtagEqual !== true))) {
    deny("DEPLOYMENT_CAS_OR_PROVENANCE_MISMATCH");
  }
  return p.activeDeploymentId;
}

export function verifyHealth(h, phase) {
  if (!object(h) || h.activeContractRevision !== PIN.activeRevision ||
      h.candidateContractRevision !== (phase === "replaced" ? PIN.newCandidate : PIN.oldCandidate) ||
      h.connectorReady !== true || h.executionPlaneReady !== true ||
      h.contractCompatible !== true || h.candidateConnectorReady !== false ||
      (phase !== "before" && h.expectedContractRevision !== PIN.newCandidate)) {
    deny("EDGE_CONTRACT_CAS_MISMATCH");
  }
  return true;
}
export function verifyDeploymentReceipt(body) {
  const d = body?.result;
  if (body?.success !== true || !object(d) || !UUID.test(d.id ?? "") ||
      d.id === PIN.oldDeployment || d.strategy !== "percentage" ||
      !Array.isArray(d.versions) || d.versions.length !== 1 ||
      d.versions[0]?.version_id !== PIN.targetVersion ||
      d.versions[0]?.percentage !== 100) deny("DEPLOYMENT_RECEIPT_INVALID");
  return d.id;
}
export function verifyReplaceReceipt(body, operationId) {
  if (!object(body) || !["replaced", "already-replaced"].includes(body.status) ||
      body.operationId !== operationId ||
      body.activeContractRevision !== PIN.activeRevision ||
      body.candidateContractRevision !== PIN.newCandidate ||
      body.candidateConnectorReady !== false) deny("REPLACEMENT_RECEIPT_INVALID");
  return true;
}

async function boundedJson(response, maxBytes = 65536) {
  const length = response.headers?.get("content-length");
  if (length !== null && length !== undefined && Number(length) > maxBytes) deny("RESPONSE_OVERSIZED");
  let raw;
  try { raw = await response.text(); } catch { deny("RESPONSE_UNREADABLE"); }
  if (raw.length > maxBytes) deny("RESPONSE_OVERSIZED");
  try { return JSON.parse(raw); } catch { deny("RESPONSE_INVALID"); }
}
async function getHealth(fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(PIN.edgeBaseUrl + "/health", {
      method: "GET", headers: {accept: "application/json"}, redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch { deny("HEALTH_UNAVAILABLE"); }
  if (response.status !== 200) deny("HEALTH_HTTP_FAILURE");
  return boundedJson(response, 16384);
}
const readVersion = async (input, compare = compareWorkerVersions) =>
  compare({accountId: input.account, token: input.token, referenceVersionId: PIN.targetVersion});

async function waitForVersion(input, deploymentId, compare, sleep) {
  for (let i = 0; i < 5; i++) {
    try {
      verifyProvenance(await readVersion(input, compare), "after", deploymentId);
      return;
    } catch {
      if (i === 4) deny("DEPLOYMENT_OUTCOME_UNKNOWN");
      await sleep(1500);
    }
  }
}
const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function preflight(input, {compare = compareWorkerVersions, fetchImpl = fetch} = {}) {
  verifyProvenance(await readVersion(input, compare), "before");
  verifyHealth(await getHealth(fetchImpl), "before");
  verifyProvenance(await readVersion(input, compare), "before");
  return true;
}

export async function deployOnce(input, {compare = compareWorkerVersions, fetchImpl = fetch, sleep = defaultSleep} = {}) {
  await preflight(input, {compare, fetchImpl});
  // NO RE-POST on errors, timeouts or ambiguous responses. Reconcile Cloudflare.
  let response;
  try {
    response = await fetchImpl(API + input.account + "/workers/scripts/" + PIN.worker + "/deployments", {
      method: "POST",
      headers: {authorization: "Bearer " + input.token, "content-type": "application/json", accept: "application/json"},
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{percentage: 100, version_id: PIN.targetVersion}],
        annotations: {
          "workers/message": "Signed f09 CAS cutover run " + input.runId,
          "workers/triggered_by": "mcp-v3-f09-guarded-rollout",
        },
      }),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
  } catch { deny("DEPLOYMENT_OUTCOME_UNKNOWN"); }
  // Even a non-2xx response may follow a committed mutation.
  if (![200,201].includes(response.status)) deny("DEPLOYMENT_OUTCOME_UNKNOWN");
  let receipt;
  try { receipt = verifyDeploymentReceipt(await boundedJson(response)); }
  catch { deny("DEPLOYMENT_OUTCOME_UNKNOWN"); }
  await waitForVersion(input, receipt, compare, sleep);
  verifyHealth(await getHealth(fetchImpl), "after");
  return receipt;
}

export async function replaceOnce(input, {compare = compareWorkerVersions, fetchImpl = fetch} = {}) {
  if (!UUID.test(input.newDeployment ?? "")) deny("DEPLOYMENT_RECEIPT_MISSING");
  if (typeof input.prepareToken !== "string" || input.prepareToken.length < 43 ||
      input.prepareToken === input.token) deny("ISOLATED_PREPARE_TOKEN_UNAVAILABLE");
  verifyProvenance(await readVersion(input, compare), "after", input.newDeployment);
  verifyHealth(await getHealth(fetchImpl), "after");
  verifyProvenance(await readVersion(input, compare), "after", input.newDeployment);
  const body = {
    expectedActiveContractRevision: PIN.activeRevision,
    expectedPreviousCandidateContractRevision: PIN.oldCandidate,
    expectedCandidateContractRevision: PIN.newCandidate,
    operationId: input.operationId,
  };
  let response;
  try {
    response = await fetchImpl(PIN.edgeBaseUrl + "/_internal/contract-rollout/replace-candidate", {
      method: "POST",
      headers: {authorization: "Bearer " + input.prepareToken, "content-type": "application/json", accept: "application/json"},
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20000),
    });
  } catch { deny("REPLACEMENT_OUTCOME_UNKNOWN"); }
  if (response.status !== 200) deny("REPLACEMENT_REJECTED_RECONCILE");
  try { verifyReplaceReceipt(await boundedJson(response, 8192), input.operationId); }
  catch { deny("REPLACEMENT_OUTCOME_UNKNOWN"); }
  verifyHealth(await getHealth(fetchImpl), "replaced");
  return true;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !["preflight", "deploy", "replace"].includes(mode)) deny("MODE_INVALID");
    const input = parseInput(process.env);
    if (mode === "preflight") {
      await preflight(input);
      console.log("EDGE_F09_PREFLIGHT_PASSED");
    } else if (mode === "deploy") {
      const receipt = await deployOnce(input);
      if (!process.env.GITHUB_OUTPUT) deny("GITHUB_OUTPUT_UNAVAILABLE");
      const {appendFileSync} = await import("node:fs");
      appendFileSync(process.env.GITHUB_OUTPUT, "deployment_id=" + receipt + "\n");
      console.log("EDGE_F09_DEPLOYMENT_VERIFIED id=" + receipt);
    } else {
      await replaceOnce(input);
      console.log("EDGE_F09_CANDIDATE_REPLACED operation=" + input.operationId);
    }
  } catch (e) {
    console.error("EDGE_F09_REFUSED " +
      (e instanceof ActivationRefused ? e.message : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  }
}

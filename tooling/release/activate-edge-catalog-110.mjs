import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";

export const CATALOG110 = Object.freeze({
  worker: "mcp-access-stack",
  previousRevision: "6c8f2d03a166f5a2e57768f8410ade365beb75c2fd51d9ab0c07c48a01dbf7d1",
  targetRevision: "3200961150caa5f8063d2ddf8250af97478958eee0f93a48c8f1ab65aae8d3fb",
  origin: "https://mcp-access-stack.rafaeldamasio77.workers.dev",
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const RUN = /^[1-9][0-9]{4,20}$/u;
const MAX_JSON = 65536;
const API = "https://api.cloudflare.com/client/v4/accounts/";

export class Catalog110Refused extends Error {
  constructor(code) { super("EDGE_110_" + code); this.name = "Catalog110Refused"; }
}
function deny(code) { throw new Catalog110Refused(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }

export function requireExactSource(source) {
  if (typeof source !== "string" ||
      !source.includes('"contractRevision": "' + CATALOG110.targetRevision + '"') ||
      !/"toolCount":\s*110\b/u.test(source) ||
      !source.includes('"name": "release_orchestrator"') ||
      !source.includes('"name": "github_workflow_operation"') ||
      !source.includes('"name": "browser_plan"')) deny("SOURCE_MISMATCH");
  return true;
}
export function parseInput(env, mode) {
  if (!["preflight", "deploy", "prepare"].includes(mode) ||
      !ACCOUNT.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      !UUID.test(env.EXPECTED_ACTIVE_DEPLOYMENT_ID ?? "") ||
      !UUID.test(env.EXPECTED_ACTIVE_VERSION_ID ?? "") ||
      !UUID.test(env.STAGED_VERSION_ID ?? "") ||
      env.STAGED_VERSION_ID === env.EXPECTED_ACTIVE_VERSION_ID ||
      !UUID.test(env.EDGE_CATALOG_OPERATION_ID ?? "") ||
      !RUN.test(env.EDGE_CATALOG_STAGE_RUN_ID ?? "") ||
      !RUN.test(env.GITHUB_RUN_ID ?? "") ||
      env.GITHUB_RUN_ATTEMPT !== "1" ||
      typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
      env.CLOUDFLARE_API_TOKEN.length < 12) deny("INPUT_INVALID");
  if (mode === "prepare" &&
      (!UUID.test(env.NEW_DEPLOYMENT_ID ?? "") ||
       typeof env.MCP_CONTRACT_PREPARE_TOKEN !== "string" ||
       env.MCP_CONTRACT_PREPARE_TOKEN.length < 43 ||
       env.MCP_CONTRACT_PREPARE_TOKEN === env.CLOUDFLARE_API_TOKEN)) deny("PREPARE_INPUT_INVALID");
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    token: env.CLOUDFLARE_API_TOKEN,
    deployment: env.EXPECTED_ACTIVE_DEPLOYMENT_ID,
    activeVersion: env.EXPECTED_ACTIVE_VERSION_ID,
    targetVersion: env.STAGED_VERSION_ID,
    stageRunId: env.EDGE_CATALOG_STAGE_RUN_ID,
    runId: env.GITHUB_RUN_ID,
    operationId: env.EDGE_CATALOG_OPERATION_ID,
    newDeployment: env.NEW_DEPLOYMENT_ID,
    prepareToken: env.MCP_CONTRACT_PREPARE_TOKEN,
  };
}
export function verifyProvenance(p, input, phase, receipt) {
  if (!record(p) || p.worker !== CATALOG110.worker ||
      p.referenceVersionId !== input.targetVersion ||
      p.activeDeploymentId !== (phase === "before" ? input.deployment : receipt) ||
      p.activeVersionId !== (phase === "before" ? input.activeVersion : input.targetVersion) ||
      p.referenceVersionSource !== "wrangler" ||
      p.referenceBindingInspection?.namePresence !== "present" ||
      p.referenceBindingInspection?.type !== "secret_text" ||
      !["matching", "unverified"].includes(p.runtimeMetadataParity) ||
      !["matching", "unverified"].includes(p.bindingMetadataParity) ||
      p.status !== (phase === "before" ? "different_script" : "matching_script") ||
      p.scriptEtagEqual !== (phase !== "before")) deny("DEPLOYMENT_CAS_MISMATCH");
  return true;
}
export function verifyHealth(health, phase) {
  const before = phase === "before";
  const prepared = phase === "prepared";
  if (!record(health) || health.service !== "mcp-edge-gateway" ||
      health.status !== "ok" || health.controlPlaneReady !== true ||
      health.executionPlaneReady !== true ||
      health.connectorReady !== true || health.contractCompatible !== true ||
      health.activeContractRevision !== CATALOG110.previousRevision ||
      health.expectedContractRevision !== (before ? CATALOG110.previousRevision : CATALOG110.targetRevision) ||
      health.candidateContractRevision !== (prepared ? CATALOG110.targetRevision : undefined) ||
      health.runtime?.catalogContractRevision !== CATALOG110.previousRevision ||
      health.runtime?.toolCount !== 99 ||
      (prepared && typeof health.candidateConnectorReady !== "boolean")) deny("HEALTH_CAS_MISMATCH");
  return true;
}
export function verifyDeploymentReceipt(data, input) {
  const result = data?.result;
  if (data?.success !== true || !record(result) ||
      !UUID.test(result.id ?? "") || result.id === input.deployment ||
      result.strategy !== "percentage" || !Array.isArray(result.versions) ||
      result.versions.length !== 1 ||
      result.versions[0]?.version_id !== input.targetVersion ||
      result.versions[0]?.percentage !== 100) deny("DEPLOYMENT_RECEIPT_INVALID");
  return result.id;
}
export function verifyPrepareReceipt(data) {
  if (!record(data) || !["prepared", "already-prepared"].includes(data.status) ||
      data.activeContractRevision !== CATALOG110.previousRevision ||
      data.candidateContractRevision !== CATALOG110.targetRevision ||
      typeof data.candidateConnectorReady !== "boolean") deny("PREPARE_RECEIPT_INVALID");
  return true;
}
async function json(response, maxBytes = MAX_JSON) {
  if (Number(response.headers?.get("content-length") ?? 0) > maxBytes) deny("RESPONSE_TOO_LARGE");
  let raw;
  try { raw = await response.text(); } catch { deny("RESPONSE_UNREADABLE"); }
  if (raw.length > maxBytes) deny("RESPONSE_TOO_LARGE");
  try { return JSON.parse(raw); } catch { deny("RESPONSE_INVALID"); }
}
async function health(fetchImpl) {
  let response;
  try {
    response = await fetchImpl(CATALOG110.origin + "/health", {
      method: "GET", headers: { accept: "application/json" }, redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
  } catch { deny("HEALTH_UNAVAILABLE"); }
  if (response.status !== 200) deny("HEALTH_HTTP_INVALID");
  return json(response, 16384);
}
const provenance = (input, compare) =>
  compare({ accountId: input.accountId, token: input.token, referenceVersionId: input.targetVersion });
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function preflight(input, {compare = compareWorkerVersions, fetchImpl = fetch} = {}) {
  verifyProvenance(await provenance(input, compare), input, "before");
  verifyHealth(await health(fetchImpl), "before");
  verifyProvenance(await provenance(input, compare), input, "before");
  return true;
}

export async function deployOnce(input, {compare = compareWorkerVersions, fetchImpl = fetch, sleep = sleepDefault} = {}) {
  await preflight(input, {compare, fetchImpl});
  let response;
  try {
    response = await fetchImpl(API + input.accountId + "/workers/scripts/" + CATALOG110.worker + "/deployments", {
      method: "POST", headers: {
        authorization: "Bearer " + input.token, "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: input.targetVersion }],
        annotations: {
          "workers/message": "MCP Edge 110 stage " + input.stageRunId +
            " operation " + input.operationId + " run " + input.runId,
        },
      }),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
  } catch { return reconcileDeployment(input, "TRANSPORT", compare, fetchImpl, sleep); }
  // Any non-success status can still follow an applied remote mutation. Never POST again;
  // reconcile read-only against Cloudflare and the Edge instead.
  if (![200,201].includes(response.status)) {
    const status = Number.isInteger(response.status) &&
      response.status >= 100 && response.status <= 599 ? response.status : 0;
    return reconcileDeployment(input, "HTTP_" + status, compare, fetchImpl, sleep);
  }
  let receipt;
  try { receipt = verifyDeploymentReceipt(await json(response), input); }
  catch { return reconcileDeployment(input, "RECEIPT", compare, fetchImpl, sleep); }
  if (!await observeDeployment(input, receipt, compare, fetchImpl, sleep)) {
    deny("DEPLOYMENT_OUTCOME_UNKNOWN_VERIFY");
  }
  return receipt;
}

async function observeDeployment(input, receipt, compare, fetchImpl, sleep) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      verifyProvenance(await provenance(input, compare), input, "after", receipt);
      verifyHealth(await health(fetchImpl), "deployed");
      return true;
    } catch {
      if (attempt < 4) await sleep(1500);
    }
  }
  return false;
}

/** The POST outcome is unknown (transport error, non-2xx or unreadable receipt).
 * Read Cloudflare only: accept the new deployment when it is active at 100% on the
 * staged version and differs from the CAS-pinned previous deployment. */
async function reconcileDeployment(input, cause, compare, fetchImpl, sleep) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const observed = await provenance(input, compare);
      const id = observed?.activeDeploymentId;
      if (UUID.test(id ?? "") && id !== input.deployment) {
        if (await observeDeployment(input, id, compare, fetchImpl, sleep)) {
          console.error("EDGE_110_DEPLOYMENT_RECONCILED cause=" + cause + " id=" + id);
          return id;
        }
        break;
      }
    } catch { /* Cloudflare read failed; try again read-only. */ }
    if (attempt < 4) await sleep(1500);
  }
  deny("DEPLOYMENT_OUTCOME_UNKNOWN_" + cause);
}

export async function prepareOnce(input, {compare = compareWorkerVersions, fetchImpl = fetch} = {}) {
  if (!UUID.test(input.newDeployment ?? "") ||
      typeof input.prepareToken !== "string" || input.prepareToken.length < 43 ||
      input.prepareToken === input.token) deny("PREPARE_INPUT_INVALID");
  verifyProvenance(await provenance(input, compare), input, "after", input.newDeployment);
  verifyHealth(await health(fetchImpl), "deployed");
  verifyProvenance(await provenance(input, compare), input, "after", input.newDeployment);
  let response;
  try {
    response = await fetchImpl(CATALOG110.origin + "/_internal/contract-rollout/prepare", {
      method: "POST", headers: {
        authorization: "Bearer " + input.prepareToken,
        "content-type": "application/json", accept: "application/json",
      },
      body: JSON.stringify({
        expectedActiveContractRevision: CATALOG110.previousRevision,
        expectedCandidateContractRevision: CATALOG110.targetRevision,
      }),
      redirect: "error", signal: AbortSignal.timeout(20000),
    });
  } catch { deny("PREPARE_OUTCOME_UNKNOWN"); }
  if (response.status !== 200) deny("PREPARE_OUTCOME_UNKNOWN");
  try { verifyPrepareReceipt(await json(response, 8192)); }
  catch { deny("PREPARE_OUTCOME_UNKNOWN"); }
  verifyHealth(await health(fetchImpl), "prepared");
  return true;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv.length !== 3) deny("MODE_INVALID");
    const mode = process.argv[2];
    const manifest = readFileSync(new URL("../../services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts", import.meta.url), "utf8");
    requireExactSource(manifest);
    const input = parseInput(process.env, mode);
    if (mode === "preflight") {
      await preflight(input);
      console.log("EDGE_110_PREFLIGHT_VERIFIED");
    } else if (mode === "deploy") {
      const receipt = await deployOnce(input);
      if (!process.env.GITHUB_OUTPUT) deny("GITHUB_OUTPUT_MISSING");
      appendFileSync(process.env.GITHUB_OUTPUT, "deployment_id=" + receipt + "\n");
      console.log("EDGE_110_DEPLOYMENT_VERIFIED id=" + receipt);
    } else {
      await prepareOnce(input);
      console.log("EDGE_110_CANDIDATE_PREPARED operation=" + input.operationId);
    }
  } catch (error) {
    console.error(error instanceof Catalog110Refused ? error.message : "EDGE_110_UNAVAILABLE");
    process.exitCode = 1;
  }
}

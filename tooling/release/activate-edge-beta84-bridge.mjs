import { pathToFileURL } from "node:url";
import path from "node:path";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";

// One approved bridge transition only. No arbitrary versions, traffic splits or force.
export const ORIGINAL_DEPLOYMENT = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
export const ORIGINAL_VERSION = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
export const BRIDGE_VERSION = "978d3f26-4a61-4cf8-a572-af3b2e07a4dd";
const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}[0-9a-f]{8}$/u;
const ID = /^[1-9][0-9]{4,20}$/u;
const API = "https://api.cloudflare.com/client/v4/accounts/";
const SCRIPT = "mcp-access-stack";

export class BridgeActivationError extends Error {
  constructor(code) { super(code); this.name = "BridgeActivationError"; this.code = code; }
}
function fail(code) { throw new BridgeActivationError(code); }
function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }

export function parseActivationInput(env) {
  const mode = env.ACTIVATION_MODE;
  const expectedDeploymentId = env.EXPECTED_ACTIVE_DEPLOYMENT_ID;
  const expectedActiveVersionId = env.EXPECTED_ACTIVE_VERSION_ID;
  const targetVersionId = env.TARGET_VERSION_ID;
  if (!["activate", "rollback"].includes(mode) ||
      !UUID.test(expectedDeploymentId ?? "") ||
      !UUID.test(expectedActiveVersionId ?? "") ||
      !UUID.test(targetVersionId ?? "") ||
      !ACCOUNT.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
      env.CLOUDFLARE_API_TOKEN.length < 12 ||
      !ID.test(env.GITHUB_RUN_ID ?? "") ||
      env.GITHUB_RUN_ATTEMPT !== "1") fail("INPUT_UNVERIFIED");
  if (mode === "activate" &&
      (expectedDeploymentId !== ORIGINAL_DEPLOYMENT ||
       expectedActiveVersionId !== ORIGINAL_VERSION ||
       targetVersionId !== BRIDGE_VERSION)) fail("UNAPPROVED_TRANSITION");
  if (mode === "rollback" &&
      (expectedDeploymentId === ORIGINAL_DEPLOYMENT ||
       expectedActiveVersionId !== BRIDGE_VERSION ||
       targetVersionId !== ORIGINAL_VERSION)) fail("UNAPPROVED_TRANSITION");
  return {
    mode, expectedDeploymentId, expectedActiveVersionId, targetVersionId,
    accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN,
    runId: env.GITHUB_RUN_ID,
  };
}

export function verifyDeploymentBaseline(state, input) {
  if (state?.worker !== SCRIPT ||
      state.activeDeploymentId !== input.expectedDeploymentId ||
      state.activeVersionId !== input.expectedActiveVersionId ||
      state.referenceVersionId !== input.targetVersionId ||
      state.status !== "different_script" ||
      state.scriptEtagEqual !== false ||
      !["matching", "unverified"].includes(state.runtimeMetadataParity) ||
      !["matching", "unverified"].includes(state.bindingMetadataParity)) {
    fail("ACTIVE_DEPLOYMENT_CAS_MISMATCH");
  }
  if (input.mode === "activate" &&
      (state.referenceVersionSource !== "wrangler" ||
       state.referenceBindingInspection?.namePresence !== "present" ||
       state.referenceBindingInspection?.type !== "secret_text")) {
    fail("BRIDGE_VERSION_UNVERIFIED");
  }
  return { deploymentId: state.activeDeploymentId, versionId: state.activeVersionId };
}

export function verifyActivationResult(body, targetVersionId, expectedDeploymentId) {
  if (!object(body) || body.success !== true || !object(body.result) ||
      !UUID.test(body.result.id ?? "") ||
      body.result.id === expectedDeploymentId ||
      !Array.isArray(body.result.versions) ||
      body.result.versions.length !== 1 ||
      body.result.versions[0]?.version_id !== targetVersionId ||
      body.result.versions[0]?.percentage !== 100 ||
      body.result.strategy !== "percentage") fail("DEPLOYMENT_RECEIPT_UNVERIFIED");
  return body.result.id;
}

export function verifyDeploymentAfter(state, input, receiptId) {
  if (state?.worker !== SCRIPT ||
      state.activeDeploymentId !== receiptId ||
      state.activeDeploymentId === input.expectedDeploymentId ||
      state.activeVersionId !== input.targetVersionId ||
      state.referenceVersionId !== input.targetVersionId ||
      state.status !== "matching_script" || state.scriptEtagEqual !== true) {
    fail("DEPLOYMENT_POSTCONDITION_UNVERIFIED");
  }
  return { deploymentId: receiptId, versionId: input.targetVersionId };
}

export async function createDeployment(input, fetchImpl = fetch) {
  const url = API + input.accountId + "/workers/scripts/" + SCRIPT + "/deployments";
  const body = JSON.stringify({
    strategy: "percentage",
    versions: [{ percentage: 100, version_id: input.targetVersionId }],
    annotations: {
      "workers/message": "Guarded bridge " + input.mode + " run " + input.runId,
      "workers/triggered_by": "mcp-v3-guarded-release",
    },
  });
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + input.token,
        "content-type": "application/json", accept: "application/json",
      },
      body, redirect: "error", signal: AbortSignal.timeout(20_000),
    });
  } catch { fail("DEPLOYMENT_OUTCOME_UNKNOWN"); }
  // An HTTP error can occur after a server-side mutation. Never retry blindly.
  if (response.status !== 200 && response.status !== 201) fail("DEPLOYMENT_OUTCOME_UNKNOWN");
  let payload;
  try {
    const text = await response.text();
    if (text.length > 64 * 1024) fail("DEPLOYMENT_OUTCOME_UNKNOWN");
    payload = JSON.parse(text);
  } catch { fail("DEPLOYMENT_OUTCOME_UNKNOWN"); }
  try {
    return verifyActivationResult(payload, input.targetVersionId, input.expectedDeploymentId);
  } catch { fail("DEPLOYMENT_OUTCOME_UNKNOWN"); }
}

export async function inspectBridgeTransition(input, compare = compareWorkerVersions) {
  const state = await compare({
    accountId: input.accountId, token: input.token,
    referenceVersionId: input.targetVersionId,
  });
  return verifyDeploymentBaseline(state, input);
}

export async function executeBridgeTransition(input, deps = {}) {
  const compare = deps.compare ?? compareWorkerVersions;
  const post = deps.post ?? createDeployment;
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // Two independently fresh, bounded GET snapshots before the only POST.
  await inspectBridgeTransition(input, compare);
  await inspectBridgeTransition(input, compare);
  let receiptId;
  try { receiptId = await post(input); }
  catch { fail("DEPLOYMENT_OUTCOME_UNKNOWN"); }
  // No second POST, even when Cloudflare is eventually consistent or ambiguous.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const latest = await compare({
        accountId: input.accountId, token: input.token,
        referenceVersionId: input.targetVersionId,
      });
      return verifyDeploymentAfter(latest, input, receiptId);
    } catch {
      if (attempt < 3) await sleep(1500);
    }
  }
  fail("DEPLOYMENT_OUTCOME_UNKNOWN");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const input = parseActivationInput(process.env);
    const mode = process.argv[2];
    if (process.argv.length !== 3 || !["preflight", "execute"].includes(mode)) {
      fail("MODE_INVALID");
    }
    if (mode === "preflight") {
      await inspectBridgeTransition(input);
      console.log("BRIDGE_DEPLOYMENT_PREFLIGHT_VERIFIED");
    } else {
      const result = await executeBridgeTransition(input);
      console.log("BRIDGE_DEPLOYMENT_VERIFIED " + result.deploymentId + " " + result.versionId);
    }
  } catch (error) {
    // Never print URLs, payloads, token values or Cloudflare raw responses.
    console.error("BRIDGE_DEPLOYMENT_REFUSED " +
      (error instanceof BridgeActivationError ? error.code : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIN, ActivationRefused, parseInput, verifyProvenance, verifyHealth,
  verifyDeploymentReceipt, verifyReplaceReceipt, deployOnce, replaceOnce,
} from "./activate-edge-f09-cas.mjs";

const OP = "46d1e80b-74be-4320-9de4-5773f74d1775";
const DEPLOY = "5106049c-f3d4-4a14-9a38-74ec64426400";
const input = {
  account: "a".repeat(32), token: "t".repeat(48), prepareToken: "p".repeat(48),
  operationId: OP, newDeployment: DEPLOY, runId: "38217300000",
};
const provenance = (phase = "before") => ({
  worker: PIN.worker,
  activeDeploymentId: phase === "before" ? PIN.oldDeployment : DEPLOY,
  activeVersionId: phase === "before" ? PIN.oldVersion : PIN.targetVersion,
  referenceVersionId: PIN.targetVersion,
  referenceVersionSource: "wrangler",
  referenceBindingInspection: {namePresence: "present", type: "secret_text"},
  runtimeMetadataParity: "unverified", bindingMetadataParity: "matching",
  status: phase === "before" ? "different_script" : "matching_script",
  scriptEtagEqual: phase === "after",
});
const health = (phase = "before") => ({
  activeContractRevision: PIN.activeRevision,
  candidateContractRevision: phase === "replaced" ? PIN.newCandidate : PIN.oldCandidate,
  expectedContractRevision: phase === "before" ? PIN.oldCandidate : PIN.newCandidate,
  connectorReady: true, executionPlaneReady: true, contractCompatible: true,
  candidateConnectorReady: false,
});
const response = (data, status = 200) => ({
  status, headers: {get: () => null}, text: async () => JSON.stringify(data),
});
const deploymentReceipt = () => ({
  success: true, result: {
    id: DEPLOY, strategy: "percentage",
    versions: [{version_id: PIN.targetVersion, percentage: 100}],
  },
});
const replacementReceipt = () => ({
  status: "replaced", operationId: OP, activeContractRevision: PIN.activeRevision,
  candidateContractRevision: PIN.newCandidate, candidateConnectorReady: false,
});

test("input pins run and stable CAS operation", () => {
  assert.equal(parseInput({
    CLOUDFLARE_ACCOUNT_ID: input.account, CLOUDFLARE_API_TOKEN: input.token,
    EDGE_CAS_OPERATION_ID: OP, GITHUB_RUN_ID: input.runId, GITHUB_RUN_ATTEMPT: "1",
  }).operationId, OP);
  assert.throws(() => parseInput({
    CLOUDFLARE_ACCOUNT_ID: input.account, CLOUDFLARE_API_TOKEN: input.token,
    EDGE_CAS_OPERATION_ID: "not-uuid", GITHUB_RUN_ID: input.runId, GITHUB_RUN_ATTEMPT: "1",
  }), /INPUT_INVALID/);
});

test("baseline and deployment provenance are exact CAS, binding and etag checks", () => {
  assert.equal(verifyProvenance(provenance(), "before"), PIN.oldDeployment);
  assert.equal(verifyProvenance(provenance("after"), "after", DEPLOY), DEPLOY);
  assert.throws(() => verifyProvenance({...provenance(), activeDeploymentId: "other"}, "before"), /CAS_OR_PROVENANCE/);
  assert.throws(() => verifyProvenance({...provenance(), referenceBindingInspection: {namePresence:"not_observed",type:"unverified"}}, "before"), /CAS_OR_PROVENANCE/);
  assert.throws(() => verifyProvenance({...provenance(), runtimeMetadataParity:"different"}, "before"), /CAS_OR_PROVENANCE/);
  assert.throws(() => verifyProvenance(provenance("after"), "after", PIN.oldDeployment), /CAS_OR_PROVENANCE/);
});

test("contract gate fails closed on candidate drift and active execution unready", () => {
  assert.equal(verifyHealth(health(), "before"), true);
  assert.equal(verifyHealth(health("after"), "after"), true);
  assert.equal(verifyHealth(health("replaced"), "replaced"), true);
  assert.throws(() => verifyHealth({...health(), candidateContractRevision: PIN.newCandidate}, "before"), /CONTRACT_CAS/);
  assert.throws(() => verifyHealth({...health(), executionPlaneReady: false}, "before"), /CONTRACT_CAS/);
  assert.throws(() => verifyHealth({...health("after"), expectedContractRevision: PIN.oldCandidate}, "after"), /CONTRACT_CAS/);
  assert.throws(() => verifyHealth({...health("after"), candidateConnectorReady: true}, "after"), /CONTRACT_CAS/);
});

test("rejects missing or divergent Cloudflare deployment and DO receipts", () => {
  assert.equal(verifyDeploymentReceipt(deploymentReceipt()), DEPLOY);
  assert.equal(verifyReplaceReceipt(replacementReceipt(), OP), true);
  assert.throws(() => verifyDeploymentReceipt({...deploymentReceipt(), result: {...deploymentReceipt().result, id: PIN.oldDeployment}}), /RECEIPT_INVALID/);
  assert.throws(() => verifyDeploymentReceipt({...deploymentReceipt(), result: {...deploymentReceipt().result, versions: [{version_id: PIN.targetVersion, percentage: 50}]}}), /RECEIPT_INVALID/);
  assert.throws(() => verifyReplaceReceipt({...replacementReceipt(), operationId: "wrong"}, OP), /REPLACEMENT_RECEIPT_INVALID/);
});

test("a pinned immutable deployment makes exactly one POST and reconciles its receipt", async () => {
  let reads = 0, posts = 0;
  const compare = async () => ++reads <= 2 ? provenance() : provenance("after");
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") return response(health(posts === 0 ? "before" : "after"));
    posts++;
    assert.equal(init.method, "POST");
    assert.match(url, /\/deployments$/);
    const req = JSON.parse(init.body);
    assert.deepEqual(req.versions, [{version_id: PIN.targetVersion, percentage: 100}]);
    return response(deploymentReceipt(), 201);
  };
  const id = await deployOnce(input, {compare, fetchImpl, sleep: async () => {}});
  assert.equal(id, DEPLOY);
  assert.equal(posts, 1);
  assert.equal(reads, 3);
});

test("deployment ambiguous transport outcome stops and NEVER retries", async () => {
  let posts = 0;
  const compare = async () => provenance();
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET") return response(health());
    posts++;
    throw new Error("timeout after POST");
  };
  await assert.rejects(deployOnce(input, {compare, fetchImpl}), /DEPLOYMENT_OUTCOME_UNKNOWN/);
  assert.equal(posts, 1);
});

test("CAS candidate replacement makes one authenticated POST bound to operationId", async () => {
  let post = 0, compareCalls = 0;
  const compare = async () => { compareCalls++; return provenance("after"); };
  const fetchImpl = async (url, init) => {
    if (init.method === "GET") return response(health(post ? "replaced" : "after"));
    post++;
    assert.equal(init.headers.authorization, "Bearer " + input.prepareToken);
    assert.match(url, /\/replace-candidate$/);
    assert.deepEqual(JSON.parse(init.body), {
      expectedActiveContractRevision: PIN.activeRevision,
      expectedPreviousCandidateContractRevision: PIN.oldCandidate,
      expectedCandidateContractRevision: PIN.newCandidate,
      operationId: OP,
    });
    return response(replacementReceipt());
  };
  await replaceOnce(input, {compare, fetchImpl});
  assert.equal(post, 1);
  assert.equal(compareCalls, 2);
});

test("replacement will not POST without isolated secret or if CAS drifted", async () => {
  let post = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === "POST") post++;
    return response(health());
  };
  await assert.rejects(replaceOnce({...input, prepareToken: input.token}, {fetchImpl, compare: async () => provenance("after")}), /ISOLATED_PREPARE_TOKEN/);
  await assert.rejects(replaceOnce(input, {fetchImpl, compare: async () => provenance()}), /CAS_OR_PROVENANCE/);
  assert.equal(post, 0);
});

test("candidate mutation transport unknown stops after one POST", async () => {
  let post = 0;
  const fetchImpl = async (_url, init) => {
    if (init.method === "GET") return response(health("after"));
    post++;
    throw new Error("unknown");
  };
  await assert.rejects(replaceOnce(input, {fetchImpl, compare: async () => provenance("after")}), /REPLACEMENT_OUTCOME_UNKNOWN/);
  assert.equal(post, 1);
});

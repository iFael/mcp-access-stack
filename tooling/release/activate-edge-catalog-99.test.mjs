import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  CATALOG99, requireExactSource, parseInput, verifyProvenance, verifyHealth,
  verifyDeploymentReceipt, verifyPrepareReceipt, preflight, deployOnce, prepareOnce,
} from "./activate-edge-catalog-99.mjs";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const manifest = await readFile(path.join(root, "services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts"), "utf8");
const DEPLOY = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
const ACTIVE = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const TARGET = "562c6fc3-78c7-4365-9c47-cc307f8c755e";
const RECEIPT = "7d2b9560-f0d8-4c6d-8a4f-f93cf0fc1380";
const OP = "8f02a2a4-2f1f-45de-b127-d11253aaa0d5";
const input = {
  accountId: "a".repeat(32), token: "t".repeat(64),
  deployment: DEPLOY, activeVersion: ACTIVE, targetVersion: TARGET,
  stageRunId: "38490000000", runId: "38490000001", operationId: OP,
  newDeployment: RECEIPT, prepareToken: "p".repeat(64),
};
const env = {
  CLOUDFLARE_ACCOUNT_ID: input.accountId, CLOUDFLARE_API_TOKEN: input.token,
  EXPECTED_ACTIVE_DEPLOYMENT_ID: DEPLOY, EXPECTED_ACTIVE_VERSION_ID: ACTIVE,
  STAGED_VERSION_ID: TARGET, EDGE_CATALOG_OPERATION_ID: OP,
  EDGE_CATALOG_STAGE_RUN_ID: input.stageRunId,
  GITHUB_RUN_ID: input.runId, GITHUB_RUN_ATTEMPT: "1",
  NEW_DEPLOYMENT_ID: RECEIPT, MCP_CONTRACT_PREPARE_TOKEN: input.prepareToken,
};
const provenance = (phase = "before") => ({
  worker: CATALOG99.worker,
  activeDeploymentId: phase === "before" ? DEPLOY : RECEIPT,
  activeVersionId: phase === "before" ? ACTIVE : TARGET,
  referenceVersionId: TARGET,
  referenceVersionSource: "wrangler",
  referenceBindingInspection: { namePresence: "present", type: "secret_text" },
  runtimeMetadataParity: "matching", bindingMetadataParity: "matching",
  status: phase === "before" ? "different_script" : "matching_script",
  scriptEtagEqual: phase !== "before",
});
const health = (phase = "before") => ({
  service: "mcp-edge-gateway", status: "ok", controlPlaneReady: true,
  executionPlaneReady: true, connectorReady: true, contractCompatible: true,
  activeContractRevision: CATALOG99.previousRevision,
  expectedContractRevision: phase === "before" ? CATALOG99.previousRevision : CATALOG99.targetRevision,
  ...(phase === "prepared" ? {
    candidateContractRevision: CATALOG99.targetRevision, candidateConnectorReady: false,
  } : {}),
  runtime: { catalogContractRevision: CATALOG99.previousRevision, toolCount: 97 },
});
const response = (data, status = 200) => ({
  status, headers: { get: () => null }, text: async () => JSON.stringify(data),
});
const deployed = () => ({
  success: true, result: { id: RECEIPT, strategy: "percentage",
    versions: [{ version_id: TARGET, percentage: 100 }] },
});
const prepared = () => ({
  status: "prepared", activeContractRevision: CATALOG99.previousRevision,
  candidateContractRevision: CATALOG99.targetRevision, candidateConnectorReady: false,
});

test("99-tool source and supplied immutable identity are pinned, not arbitrary", () => {
  assert.equal(requireExactSource(manifest), true);
  for (const source of [
    manifest.replace('"toolCount": 99', '"toolCount": 97'),
    manifest.replace(CATALOG99.targetRevision, "0".repeat(64)),
    manifest.replace('"name": "release_orchestrator"', '"name": "missing"'),
  ]) assert.throws(() => requireExactSource(source), /EDGE_99_SOURCE_MISMATCH/);
  assert.equal(parseInput(env, "preflight").stageRunId, input.stageRunId);
  assert.equal(parseInput(env, "prepare").operationId, OP);
  for (const value of [
    { GITHUB_RUN_ATTEMPT: "2" }, { EDGE_CATALOG_OPERATION_ID: "invalid" },
    { STAGED_VERSION_ID: ACTIVE }, { EDGE_CATALOG_STAGE_RUN_ID: "invalid" },
    { EXPECTED_ACTIVE_DEPLOYMENT_ID: "invalid" }, { CLOUDFLARE_API_TOKEN: "" },
  ]) assert.throws(() => parseInput({ ...env, ...value }, "deploy"), /EDGE_99_INPUT_INVALID/);
  assert.throws(() => parseInput({ ...env, MCP_CONTRACT_PREPARE_TOKEN: input.token }, "prepare"),
    /EDGE_99_PREPARE_INPUT_INVALID/);
  assert.throws(() => parseInput(env, "rollback"), /EDGE_99_INPUT_INVALID/);
});

test("CAS checks require exact staging version, prior deployment and required secret binding", () => {
  assert.equal(verifyProvenance(provenance(), input, "before"), true);
  assert.equal(verifyProvenance(provenance("after"), input, "after", RECEIPT), true);
  for (const delta of [
    {activeDeploymentId: RECEIPT}, {referenceVersionId: ACTIVE},
    {referenceVersionSource: "dash"},
    {referenceBindingInspection: {namePresence: "not_observed", type: "unverified"}},
    {runtimeMetadataParity: "different"}, {scriptEtagEqual: true},
  ]) assert.throws(() => verifyProvenance({...provenance(), ...delta}, input, "before"),
    /EDGE_99_DEPLOYMENT_CAS_MISMATCH/);
  assert.throws(() => verifyProvenance(provenance("after"), input, "after", DEPLOY),
    /EDGE_99_DEPLOYMENT_CAS_MISMATCH/);
});

test("catalog contract stays on 97 until prepared and rejects anything else", () => {
  assert.equal(verifyHealth(health(), "before"), true);
  assert.equal(verifyHealth(health("deployed"), "deployed"), true);
  assert.equal(verifyHealth(health("prepared"), "prepared"), true);
  for (const delta of [
    {activeContractRevision: CATALOG99.targetRevision},
    {candidateContractRevision: CATALOG99.targetRevision},
    {executionPlaneReady: false}, {runtime: {toolCount: 99}},
  ]) assert.throws(() => verifyHealth({...health(), ...delta}, "before"),
    /EDGE_99_HEALTH_CAS_MISMATCH/);
  assert.throws(() => verifyHealth(health(), "deployed"), /EDGE_99_HEALTH_CAS_MISMATCH/);
  assert.throws(() => verifyHealth(health("deployed"), "prepared"), /EDGE_99_HEALTH_CAS_MISMATCH/);
});

test("Cloudflare and Durable Object receipts must match exact CAS", () => {
  assert.equal(verifyDeploymentReceipt(deployed(), input), RECEIPT);
  assert.equal(verifyPrepareReceipt(prepared()), true);
  assert.throws(() => verifyDeploymentReceipt({...deployed(), result: {
    ...deployed().result, versions: [{version_id: ACTIVE, percentage: 100}] }}, input),
  /EDGE_99_DEPLOYMENT_RECEIPT_INVALID/);
  assert.throws(() => verifyPrepareReceipt({...prepared(), activeContractRevision: CATALOG99.targetRevision}),
    /EDGE_99_PREPARE_RECEIPT_INVALID/);
});

test("successful deployment sends exactly ONE POST then checks GET-only after state", async () => {
  let post = 0, reads = 0;
  const compare = async () => ++reads <= 2 ? provenance() : provenance("after");
  const fetchImpl = async (url, request) => {
    if (request.method === "GET") return response(health(post ? "deployed" : "before"));
    post++;
    assert.match(url, /\/deployments$/);
    assert.deepEqual(JSON.parse(request.body).versions, [{percentage:100,version_id:TARGET}]);
    assert.match(JSON.parse(request.body).annotations["workers/message"], /38490000000/);
    return response(deployed(), 201);
  };
  assert.equal(await deployOnce(input,{compare,fetchImpl,sleep:async()=>{}}),RECEIPT);
  assert.equal(post,1);
  assert.equal(reads,3);
});

test("timeout and non-200 POST never retry, even when CF may have committed", async () => {
  for (const failure of ["throw", "http"]) {
    let posts=0;
    const fetchImpl=async(_url,init)=>{
      if(init.method==="GET")return response(health());
      posts++;
      if(failure==="throw")throw Error("network timeout");
      return response({errors:[{message:"sensitive-SECRET-NEVER-LOG"}]},500);
    };
    await assert.rejects(deployOnce(input,{compare:async()=>provenance(),fetchImpl}),
      /EDGE_99_DEPLOYMENT_OUTCOME_UNKNOWN/);
    assert.equal(posts,1);
  }
});

test("post-deploy preparation sends ONE isolated-token POST, never promotes", async () => {
  let post=0,reads=0;
  const fetchImpl=async(url,init)=>{
    if(init.method==="GET")return response(health(post ? "prepared" : "deployed"));
    post++;
    assert.match(url,/\/_internal\/contract-rollout\/prepare$/);
    assert.equal(init.headers.authorization, "Bearer " + input.prepareToken);
    assert.deepEqual(JSON.parse(init.body),{
      expectedActiveContractRevision: CATALOG99.previousRevision,
      expectedCandidateContractRevision: CATALOG99.targetRevision,
    });
    return response(prepared());
  };
  const compare=async()=>{reads++;return provenance("after");};
  assert.equal(await prepareOnce(input,{compare,fetchImpl}),true);
  assert.equal(post,1);
  assert.equal(reads,2);
});

test("candidate preparation ambiguous failure stops and emits no token", async () => {
  let post=0;
  const fetchImpl=async(_url,request)=>{
    if(request.method==="GET")return response(health("deployed"));
    post++;
    throw Error("sensitive-after-submit");
  };
  await assert.rejects(prepareOnce(input,{compare:async()=>provenance("after"),fetchImpl}),
    /EDGE_99_PREPARE_OUTCOME_UNKNOWN/);
  assert.equal(post,1);
});

test("workflow isolates CI/Stage identity, Environment and Cloudflare mutation", async () => {
  const source=await readFile(path.join(root,".github/workflows/edge-catalog-99-activate.yml"),"utf8");
  const parsed=YAML.parseDocument(source,{uniqueKeys:true});
  assert.deepEqual(parsed.errors,[]);
  const workflow=parsed.toJS();
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs),[
    "expected_main_sha","stage_run_id","expected_active_deployment_id",
    "expected_active_version_id","operation_id",
  ]);
  assert.equal(workflow.concurrency.group,"public-release-edge");
  assert.equal(workflow.concurrency["cancel-in-progress"],false);
  assert.equal(workflow.jobs.publish.environment,"public-release");
  assert.match(source,/GITHUB_RUN_ATTEMPT.*"1"/);
  assert.match(source,/actions\/runs\/\$STAGE_RUN_ID/);
  assert.match(source,/EDGE_CAS_STAGE_UPLOADED_NO_TRAFFIC version_id=/);
  const steps=workflow.jobs.publish.steps;
  const names=steps.map(s=>s.name);
  const pre=names.findIndex(s=>s.startsWith("Read-only dual"));
  const deploy=names.findIndex(s=>s.startsWith("ONE 100-percent"));
  const prep=names.findIndex(s=>s.startsWith("ONE authenticated"));
  assert.ok(pre>=0 && pre<deploy && deploy<prep);
  assert.equal((source.match(/activate-edge-catalog-99\.mjs deploy/g)??[]).length,1);
  assert.equal((source.match(/activate-edge-catalog-99\.mjs prepare/g)??[]).length,1);
  assert.equal(steps[prep].env.MCP_CONTRACT_PREPARE_TOKEN,
    "${{ secrets.MCP_CONTRACT_PREPARE_TOKEN }}");
  assert.equal(steps[deploy].env.MCP_CONTRACT_PREPARE_TOKEN,undefined);
  assert.doesNotMatch(source,/wrangler deploy|wrangler secret put|release-tag-bootstrap|\/_internal\/contract-rollout\/promote/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  readUploadedVersionId, validateActiveProvenance, verifyUploadedVersion,
} from "./stage-edge-beta84-bridge-guard.mjs";

const deployment = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
const active = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const staged = "11111111-2222-4333-8444-555555555555";
const baseline = {
  worker: "mcp-access-stack", activeDeploymentId: deployment,
  activeVersionId: active, referenceVersionId: active,
  status: "matching_script", scriptEtagEqual: true,
  runtimeMetadataParity: "unverified",
  bindingMetadataParity: "unverified",
};

test("accepts exact immutable active deployment with unverified optional metadata", () => {
  assert.deepEqual(validateActiveProvenance(baseline, deployment, active), {
    deploymentId: deployment, activeVersionId: active,
  });
});

test("rejects changed deployment, version, scripts, bindings and runtime", () => {
  for (const modification of [
    { activeDeploymentId: staged }, { activeVersionId: staged },
    { referenceVersionId: staged }, { scriptEtagEqual: false },
    { status: "different_script" }, { bindingMetadataParity: "different" },
    { runtimeMetadataParity: "different" }, { worker: "other-worker" },
  ]) {
    assert.throws(
      () => validateActiveProvenance({ ...baseline, ...modification }, deployment, active),
      /EDGE_STAGE_ACTIVE_PROVENANCE_MISMATCH/,
    );
  }
});

test("rejects invalid or unexpected CAS inputs", () => {
  assert.throws(() => validateActiveProvenance(baseline, "not-a-uuid", active),
    /EDGE_STAGE_ACTIVE_PROVENANCE_MISMATCH/);
  assert.throws(() => validateActiveProvenance(baseline, deployment, staged),
    /EDGE_STAGE_ACTIVE_PROVENANCE_MISMATCH/);
  assert.throws(() => validateActiveProvenance(null, deployment, active),
    /EDGE_STAGE_ACTIVE_PROVENANCE_MISMATCH/);
});

test("extracts one new version ID from Wrangler upload receipt", () => {
  assert.equal(readUploadedVersionId("Uploaded mcp-access-stack\nWorker Version ID: " + staged, active), staged);
});

test("does not accept missing, duplicated or already-active version IDs", () => {
  for (const log of [
    "Uploaded worker without version identifier",
    "Worker Version ID: " + active,
    "Worker Version ID: " + staged + "\nWorker Version ID: " + staged,
    "Worker Version ID: " + staged + "\nVersion ID: " + active,
  ]) {
    assert.throws(() => readUploadedVersionId(log, active), /EDGE_STAGE_VERSION_ID_UNVERIFIED/);
  }
});

test("requires an exact new version resource with script ETag", () => {
  const correct = { success: true, result: {
    id: staged, resources: { script: { etag: "ab".repeat(20) } },
  } };
  assert.equal(verifyUploadedVersion(correct, staged), staged);
  for (const value of [
    { ...correct, success: false },
    { ...correct, result: { ...correct.result, id: active } },
    { ...correct, result: { ...correct.result, resources: {} } },
  ]) {
    assert.throws(() => verifyUploadedVersion(value, staged),
      /EDGE_STAGE_UPLOADED_VERSION_UNVERIFIED/);
  }
});

test("workflow is one-shot, Environment-gated, CAS-bound and upload-only", async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const workflow = await readFile(path.resolve(directory, "../../.github/workflows/edge-beta84-bridge-stage.yml"), "utf8");
  const parsed=YAML.parseDocument(workflow,{uniqueKeys:true});
  assert.deepEqual(parsed.errors,[]);
  const config=parsed.toJS();
  assert.deepEqual(Object.keys(config.on.workflow_dispatch.inputs),[
    "expected_main_sha","expected_active_deployment_id","expected_active_version_id",
  ]);
  assert.equal(config.jobs.stage.environment,"public-release");
  assert.equal(config.concurrency.group,"public-release-edge");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: public-release/u);
  assert.match(workflow, /group: public-release-edge/u);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT.*"1"/u);
  assert.match(workflow, /expected_main_sha:/u);
  assert.match(workflow, /expected_active_deployment_id:/u);
  assert.match(workflow, /expected_active_version_id:/u);
  assert.match(workflow, /stage-edge-beta84-bridge-guard\.mjs before/u);
  assert.match(workflow, /stage-edge-beta84-bridge-guard\.mjs after/u);
  assert.match(workflow, /--strict --keep-vars/u);
  assert.equal((workflow.match(/npx wrangler versions upload/gu) ?? []).length, 1);
  assert.doesNotMatch(workflow, /wrangler (?:deploy|versions deploy|secret put)/u);
  assert.doesNotMatch(workflow, /\/health\b|\/_internal\/contract-rollout\/(?:prepare|bootstrap)/u);
  assert.doesNotMatch(workflow, /secrets\.MCP_OWNER_TOKEN|secrets\.MCP_CONTRACT_PREPARE_TOKEN/u);
});

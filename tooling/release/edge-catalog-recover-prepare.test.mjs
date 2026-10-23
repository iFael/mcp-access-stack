import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const workflowSource = await readFile(path.join(root, ".github/workflows/edge-catalog-recover-prepare.yml"), "utf8");
const activationSource = await readFile(path.join(root, ".github/workflows/edge-catalog-activate.yml"), "utf8");
const yaml = YAML.parseDocument(workflowSource, { uniqueKeys: true });
const workflow = yaml.toJS();

test("prepare-only recovery is YAML-valid, dispatch-only, main-pinned and protected", () => {
  assert.deepEqual(yaml.errors, []);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["expected_main_sha", "activation_run_id"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.concurrency.group, "public-release-edge");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.prepare.environment, "public-release");
  assert.equal(workflow.jobs.preflight.environment, undefined);
  assert.match(workflow.jobs.preflight.if, /refs\/heads\/main/);
  assert.match(workflowSource, /GITHUB_RUN_ATTEMPT.*"1"/);
  assert.match(workflowSource, /status success/);
  assert.match(workflowSource, /GITHUB_SHA.*EXPECTED_MAIN_SHA/);
});

test("the original activation must have deployed and failed only at preparation", () => {
  for (const step of [
    "Read-only dual Cloudflare CAS and active contract health",
    "ONE 100-percent Cloudflare deployment, no automatic retry",
    "ONE authenticated candidate preparation after verified deployment",
  ]) {
    assert.ok(activationSource.includes("- name: " + step), step);
    assert.ok(workflowSource.includes('.name == "' + step + '"'), step);
  }
  assert.ok(workflowSource.includes('.github/workflows/edge-catalog-activate.yml'));
  assert.ok(workflowSource.includes('"$original_conclusion" == "failure"'));
  assert.ok(workflowSource.includes('EDGE_CATALOG_DEPLOYMENT_VERIFIED id=$new_deployment'));
  assert.ok(workflowSource.includes('EDGE_CAS_STAGE_UPLOADED_NO_TRAFFIC version_id=$staged_version'));
  assert.ok(workflowSource.includes('"$stage_sha" == "$original_sha"'));
  assert.match(workflowSource, /services\/mcp-edge-gateway\/\|packages\/\|tooling\/release\/edge-catalog-rollout/);
});

test("Cloudflare credentials appear only in the single preparation step, fed by preflight outputs", () => {
  const steps = workflow.jobs.prepare.steps;
  const last = steps.at(-1);
  assert.match(last.name, /^Authenticated candidate preparation, no Worker deployment/);
  assert.equal(last.env.MCP_CONTRACT_PREPARE_TOKEN, "${{ secrets.MCP_CONTRACT_PREPARE_TOKEN }}");
  assert.equal(last.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  for (const key of ["EXPECTED_ACTIVE_DEPLOYMENT_ID", "EXPECTED_ACTIVE_VERSION_ID", "STAGED_VERSION_ID",
    "NEW_DEPLOYMENT_ID", "EDGE_CATALOG_STAGE_RUN_ID", "EDGE_CATALOG_OPERATION_ID"]) {
    assert.match(last.env[key], /^\$\{\{ needs\.preflight\.outputs\.[a-z_]+ \}\}$/, key);
  }
  for (const step of [...workflow.jobs.preflight.steps, ...steps.slice(0, -1)]) {
    assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(step.env?.MCP_CONTRACT_PREPARE_TOKEN, undefined);
  }
  assert.equal((workflowSource.match(/activate-edge-catalog\.mjs prepare/g) ?? []).length, 1);
  assert.doesNotMatch(workflowSource, /activate-edge-catalog\.mjs (deploy|preflight)/);
  assert.doesNotMatch(workflowSource, /wrangler (deploy|versions deploy|secret put)/);
  assert.doesNotMatch(workflowSource, /contract-rollout\/promote/);
});

test("one recovery per activation run, checked before and after the Environment gate", () => {
  assert.equal(workflow["run-name"], "mcp-edge-catalog-recovery-${{ inputs.activation_run_id }}");
  assert.equal((workflowSource.match(/--workflow edge-catalog-recover-prepare\.yml/g) ?? []).length, 2);
  assert.equal((workflowSource.match(/\[\[ "\$count" == "1" \]\]/g) ?? []).length, 2);
});

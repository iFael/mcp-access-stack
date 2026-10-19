import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const workflowSource = await readFile(path.join(root, ".github/workflows/edge-99-recover-prepare.yml"), "utf8");
const yaml = YAML.parseDocument(workflowSource, { uniqueKeys: true });
const workflow = yaml.toJS();

test("prepare-only recovery is YAML-valid, dispatch-only, SHA-pinned and protected", () => {
  assert.deepEqual(yaml.errors, []);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ["expected_main_sha", "operation_id"]);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.permissions.actions, "read");
  assert.equal(workflow.concurrency.group, "public-release-edge");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.prepare.environment, "public-release");
  assert.match(workflow.jobs.preflight.if, /refs\/heads\/main/);
  assert.match(workflowSource, /GITHUB_RUN_ATTEMPT.*"1"/);
  assert.match(workflowSource, /status success/);
  assert.match(workflowSource, /GITHUB_SHA.*EXPECTED_MAIN_SHA/);
  assert.match(workflowSource, /mcp-edge-99-prepare-recovery-/);
});

test("immutable original operation, stage receipt, prior failed step and skipped prepare are all verified", () => {
  for (const text of [
    "7d6027bf-238c-4eb7-8104-e3a7c41a6f07",
    "38495741963", "38492608332",
    "c4128cfcc648429091ea562cef13f2810d6623d6",
    "24d473a0b5efedb7d4657381e8c06fa6d37e3cc9",
    "EDGE_CAS_STAGE_UPLOADED_NO_TRAFFIC version_id=779717e8-9f6d-4ecb-b274-99cdbb28e4e5",
    "Read-only dual Cloudflare CAS and active contract health",
    "ONE 100-percent Cloudflare deployment, no automatic retry",
    "ONE authenticated candidate preparation after verified deployment",
    'original_conclusion" == "failure"',
    'diff_status" == "ahead"',
    '.github/workflows/edge-99-recover-prepare.yml,tooling/release/edge-99-recover-prepare.test.mjs',
  ]) assert.ok(workflowSource.includes(text), text);
  assert.match(workflowSource, /conclusion == "skipped"/);
  assert.match(workflowSource, /conclusion == "failure"/);
  assert.match(workflowSource, /compare\/c4128cfcc648429091ea562cef13f2810d6623d6\.\.\.\$EXPECTED_MAIN_SHA/);
});

test("Cloudflare step has exact version/deployment CAS and isolated prepare credentials", () => {
  const steps = workflow.jobs.prepare.steps;
  const idx = steps.findIndex(s => s.name.startsWith("ONE authenticated candidate preparation"));
  assert.equal(idx, steps.length - 1);
  const env = steps[idx].env;
  assert.equal(env.EXPECTED_ACTIVE_DEPLOYMENT_ID, "7d2b9560-f0d8-4c6d-8a4f-f93cf0fc1380");
  assert.equal(env.EXPECTED_ACTIVE_VERSION_ID, "562c6fc3-78c7-4365-9c47-cc307f8c755e");
  assert.equal(env.STAGED_VERSION_ID, "779717e8-9f6d-4ecb-b274-99cdbb28e4e5");
  assert.equal(env.NEW_DEPLOYMENT_ID, "53198352-68ba-40fd-9be6-2cd9254e9c22");
  assert.equal(env.EDGE_CATALOG_STAGE_RUN_ID, "38492608332");
  assert.equal(env.MCP_CONTRACT_PREPARE_TOKEN, "${{ secrets.MCP_CONTRACT_PREPARE_TOKEN }}");
  assert.equal(env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.equal(env.EDGE_CATALOG_OPERATION_ID, "${{ inputs.operation_id }}");
  for (const step of steps.slice(0, idx)) {
    assert.equal(step.env?.CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(step.env?.MCP_CONTRACT_PREPARE_TOKEN, undefined);
  }
  assert.equal((workflowSource.match(/activate-edge-catalog-99\.mjs prepare/g)??[]).length,1);
  assert.equal((workflowSource.match(/node tooling\/release\/activate-edge-catalog-99\.mjs deploy/g)??[]).length,0);
  assert.doesNotMatch(workflowSource,/wrangler deploy|wrangler versions deploy|wrangler secret put|deployments"\s*,\s*\{/);
  assert.doesNotMatch(workflowSource,/\/\_internal\/contract-rollout\/promote/);
});

test("recovery workflow checks same operation exactly once before and after Environment", () => {
  const checks = workflowSource.match(/workflow edge-99-recover-prepare\.yml/g) ?? [];
  assert.equal(checks.length, 2);
  assert.match(workflowSource, /\[\[ "\$count" == "1" \]\]/);
  assert.match(workflowSource, /\[\[ "\$original_title" == "mcp-edge-catalog-99-\$OPERATION_ID" \]\]/);
  assert.ok(workflowSource.includes('"$stage_path" == ".github/workflows/edge-cas-candidate-stage.yml"'));
});

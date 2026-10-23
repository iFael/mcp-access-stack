import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  verifyLocalCandidate, requirePublisherPrerequisites, verifyNoTrafficChange, parseInput,
  writeStageSecretFile, verifyVersionSecretBinding,
} from "./stage-edge-cas-candidate.mjs";
import { CATALOG } from "./activate-edge-catalog.mjs";

const deployment = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
const version = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const revision = CATALOG.targetRevision;
const previousRevision = CATALOG.previousRevision;
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(await readFile(path.join(base, "services/mcp-edge-gateway/wrangler.jsonc"), "utf8"));
const manifest = await readFile(path.join(base, "services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts"), "utf8");

test("Edge staging accepts only the rollout's target catalog and rejects the active one", () => {
  const pinned = `{\n  "contractRevision": "${revision}",\n  "toolCount": ${CATALOG.targetToolCount}\n}`;
  assert.equal(verifyLocalCandidate(config, pinned, revision), revision);
  assert.throws(() => verifyLocalCandidate(config, pinned, previousRevision),
    /EDGE_CAS_STAGE_BUILD_CONTRACT_MISMATCH/u);
  assert.throws(() => verifyLocalCandidate(config,
    pinned.replace(`"toolCount": ${CATALOG.targetToolCount}`, `"toolCount": ${CATALOG.previousToolCount}`), revision),
  /EDGE_CAS_STAGE_BUILD_CONTRACT_MISMATCH/u);
});
test("Edge staging takes the checked-out catalog only while it is the rollout target", () => {
  // A later catalog must move edge-catalog-rollout.json deliberately.
  if (manifest.includes(`"contractRevision": "${revision}"`)) {
    assert.equal(verifyLocalCandidate(config, manifest, revision), revision);
  } else {
    assert.throws(() => verifyLocalCandidate(config, manifest, revision),
      /EDGE_CAS_STAGE_BUILD_CONTRACT_MISMATCH/u);
  }
  assert.throws(() => verifyLocalCandidate(config, manifest, previousRevision),
    /EDGE_CAS_STAGE_BUILD_CONTRACT_MISMATCH/u);
});
test("cannot stage a mismatched revision, fake manifest, missing secret, DO or migration drift", () => {
  for (const [c, m, rev] of [
    [config, manifest, "b".repeat(64)],
    [config, "export const manifest = {}", revision],
    [{ ...config, secrets: { required: [] } }, manifest, revision],
    [{ ...config, durable_objects: { bindings: [] } }, manifest, revision],
    [{ ...config, migrations: [{ tag: "v2" }] }, manifest, revision],
    [{ ...config, routes: ["*"] }, manifest, revision],
    [{ ...config, main: "different.ts" }, manifest, revision],
  ]) {
    assert.throws(() => verifyLocalCandidate(c, m, rev), /EDGE_CAS_STAGE_/u);
  }
});
test("publisher metadata requires observed secret, exact CAS, migration and settings", () => {
  const healthy = {
    worker: "mcp-access-stack", activeDeploymentId: deployment, activeVersionId: version,
    tokenStatus: "active", remoteSettingsReadability: "readable",
    remotePlainVarsParity: "matching", serviceMigrationTagParity: "matching",
    remoteRequiredSecretsPresence: "present", remoteSecretNameCollision: "not_observed",
    publisherWriteScope: "unverified",
  };
  assert.equal(requirePublisherPrerequisites(healthy, deployment, version), true);
  assert.equal(requirePublisherPrerequisites({
    ...healthy, remoteRequiredSecretsPresence: "not_observed",
  }, deployment, version, { bundledSecret: true }), true);
  assert.throws(() => requirePublisherPrerequisites({
    ...healthy, remoteRequiredSecretsPresence: "not_observed",
  }, deployment, version), /EDGE_CAS_STAGE_PUBLISHER_PRECONDITION_UNVERIFIED/u);
  for (const change of [
    { remoteRequiredSecretsPresence: "unverified" },
    { remotePlainVarsParity: "different" }, { serviceMigrationTagParity: "different" },
    { remoteSecretNameCollision: "present" }, { tokenStatus: "expired" },
    { activeVersionId: "c".repeat(8) + version.slice(8) },
    { activeDeploymentId: "c".repeat(8) + deployment.slice(8) },
  ]) {
    assert.throws(
      () => requirePublisherPrerequisites({ ...healthy, ...change }, deployment, version, { bundledSecret: true }),
      /EDGE_CAS_STAGE_PUBLISHER_PRECONDITION_UNVERIFIED/u,
    );
  }
});
test("rejects drift across pre/post upload active deployment and version", () => {
  const snapshot = { deploymentId: deployment, activeVersionId: version };
  assert.equal(verifyNoTrafficChange(snapshot, snapshot), true);
  assert.throws(() => verifyNoTrafficChange(snapshot, { ...snapshot, deploymentId: "x" }),
    /EDGE_CAS_STAGE_ACTIVE_CAS_CHANGED/u);
  assert.throws(() => verifyNoTrafficChange(snapshot, { ...snapshot, activeVersionId: "x" }),
    /EDGE_CAS_STAGE_ACTIVE_CAS_CHANGED/u);
});
test("rejects malformed environment without accessing Cloudflare", () => {
  const valid = {
    CLOUDFLARE_ACCOUNT_ID: "c".repeat(32), EXPECTED_ACTIVE_DEPLOYMENT_ID: deployment,
    EXPECTED_ACTIVE_VERSION_ID: version, EXPECTED_CONTRACT_REVISION: revision,
    RUNNER_TEMP: "/tmp/runner", CLOUDFLARE_API_TOKEN: "isolated-secret-not-exposed",
  };
  assert.equal(parseInput("before", valid).expectedRevision, revision);
  for (const changed of [
    { EXPECTED_ACTIVE_DEPLOYMENT_ID: "broken" },
    { EXPECTED_ACTIVE_VERSION_ID: "broken" },
    { EXPECTED_CONTRACT_REVISION: "bad" }, { CLOUDFLARE_ACCOUNT_ID: "broken" },
    { RUNNER_TEMP: "./relative" }, { CLOUDFLARE_API_TOKEN: undefined },
  ]) {
    assert.throws(() => parseInput("before", { ...valid, ...changed }), /EDGE_CAS_STAGE_/u);
  }
  assert.throws(() => parseInput("deploy", valid), /EDGE_CAS_STAGE_MODE_INVALID/u);
});
test("temporary secret file is private, exclusive, bounded and never a project artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "edge-cas-stage-test-"));
  try {
    const synthetic = "A".repeat(64);
    const file = await writeStageSecretFile(synthetic, dir);
    assert.equal(path.dirname(file), dir);
    assert.equal(path.basename(file), "edge-cas-candidate-secrets.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      MCP_CONTRACT_PREPARE_TOKEN: synthetic,
    });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(writeStageSecretFile(synthetic, dir), { code: "EEXIST" });
    await assert.rejects(writeStageSecretFile("bad", dir), /EDGE_CAS_STAGE_SECRET_INVALID/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("uploaded version accepts exactly one required secret in Cloudflare object or array metadata", () => {
  const payload = { success: true, result: { resources: {
    bindings: {
      MCP_SESSION: { type: "durable_object_namespace" },
      MCP_CONTRACT_PREPARE_TOKEN: { type: "secret_text", text: "synthetic-not-for-output" },
    },
  } } };
  assert.equal(verifyVersionSecretBinding(payload), true);
  const candidateBindings = [
    { name: "MCP_SESSION", type: "durable_object_namespace", value: "private-non-secret" },
    { name: "MCP_CONTRACT_PREPARE_TOKEN", type: "secret_text", text: "private-secret-NEVER-print" },
  ];
  assert.equal(verifyVersionSecretBinding({ result: { resources: { bindings: candidateBindings } } }), true);
  for (const bindings of [
    {}, { MCP_CONTRACT_PREPARE_TOKEN: { type: "plain_text" } },
    { MCP_OWNER_TOKEN: { type: "secret_text" } },
    { MCP_CONTRACT_PREPARE_TOKEN: { text: "missing-type" } },
    [{ name: "MCP_CONTRACT_PREPARE_TOKEN", type: "plain_text" }],
    [{ name: "MCP_OWNER_TOKEN", type: "secret_text" }],
    [{ name: "MCP_CONTRACT_PREPARE_TOKEN", type: "secret_text" },
      { name: "MCP_CONTRACT_PREPARE_TOKEN", type: "secret_text" }],
    [{ name: "MCP_CONTRACT_PREPARE_TOKEN", type: "secret_text" }, null],
    [{ name: "MCP_CONTRACT_PREPARE_TOKEN" }],
    { MCP_CONTRACT_PREPARE_TOKEN: [{ type: "secret_text" }] },
    undefined, null,
  ]) {
    assert.throws(() => verifyVersionSecretBinding({
      ...payload, result: { resources: { bindings } },
    }), /EDGE_CAS_STAGE_VERSION_SECRET_UNVERIFIED/u);
  }
});

test("workflow stages ONE immutable version, no deploy, no secrets values, no DO calls", async () => {
  const workflow = await readFile(path.join(base, ".github/workflows/edge-cas-candidate-stage.yml"), "utf8");
  const parsed = YAML.parseDocument(workflow, { uniqueKeys: true });
  assert.deepEqual(parsed.errors, []);
  const yaml = parsed.toJS();
  assert.deepEqual(Object.keys(yaml.on.workflow_dispatch.inputs), [
    "expected_main_sha", "expected_active_deployment_id", "expected_active_version_id",
    "expected_contract_revision",
  ]);
  assert.equal(yaml.concurrency.group, "public-release-edge");
  assert.equal(yaml.concurrency["cancel-in-progress"], false);
  assert.equal(yaml.jobs.stage.environment, "public-release");
  const steps = yaml.jobs.stage.steps;
  const checkout = steps.filter(s => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.length, 1);
  assert.equal(checkout[0].with.ref, "${{ inputs.expected_main_sha }}");
  assert.equal(checkout[0].with["persist-credentials"], false);
  const build = steps.findIndex(s => s.name === "Build Edge package dependencies");
  const check = steps.findIndex(s => s.name === "Validate exact CAS candidate source without network");
  const pre = steps.findIndex(s => s.name === "GET-only Cloudflare CAS and secret prerequisites before upload");
  const upload = steps.findIndex(s => s.id === "upload");
  const verify = steps.findIndex(s => s.id === "verify");
  assert.ok(build >= 0 && build < check && check < pre && pre < upload && upload < verify);
  assert.equal((workflow.match(/wrangler versions upload/gu) ?? []).length, 1);
  assert.match(steps[upload].run, /wrangler versions upload --strict --keep-vars/u);
  assert.match(steps[upload].run, /--secrets-file ["']?\$RUNNER_TEMP\/edge-cas-candidate-secrets\.json/u);
  assert.match(steps[upload].run, /stage-edge-cas-candidate\.mjs secret-file/u);
  assert.match(steps[upload].run, /trap .*rm -f.*edge-cas-candidate-secrets\.json/u);
  assert.equal(steps[upload].env.MCP_CONTRACT_PREPARE_TOKEN, "${{ secrets.MCP_CONTRACT_PREPARE_TOKEN }}");
  assert.ok(steps.every((step, index) =>
    index === upload || !JSON.stringify(step).includes("secrets.MCP_CONTRACT_PREPARE_TOKEN")));
  assert.doesNotMatch(steps[upload].run, /set -x|echo.*MCP_CONTRACT_PREPARE_TOKEN|cat .*secrets/u);
  assert.match(steps[upload].run, /stage-edge-cas-candidate\.mjs diagnose/u);
  assert.match(steps[pre].run, /stage-edge-cas-candidate\.mjs before/u);
  assert.match(steps[verify].run, /stage-edge-cas-candidate\.mjs after/u);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT.*"1"/u);
  assert.doesNotMatch(workflow, /wrangler (?:versions deploy|secret put)/u);
  assert.match(steps[check].run, /wrangler deploy[^\n]*--dry-run/u);
  assert.ok(!steps.some(s => s.id !== "upload" && /wrangler versions upload/u.test(s.run ?? "")));
  assert.equal(steps[upload].env.EXPECTED_CONTRACT_REVISION, "${{ inputs.expected_contract_revision }}");
  assert.doesNotMatch(workflow, /\/_internal\/contract-rollout|\/health\b/u);
  assert.doesNotMatch(workflow, /secrets\.MCP_OWNER_TOKEN/u);
});

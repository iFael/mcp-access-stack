import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  ORIGINAL_DEPLOYMENT, ORIGINAL_VERSION, BRIDGE_VERSION, BridgeActivationError,
  parseActivationInput, verifyDeploymentBaseline, verifyActivationResult,
  verifyDeploymentAfter, createDeployment, executeBridgeTransition,
} from "./activate-edge-beta84-bridge.mjs";
const NEW_ID = "33333333-3333-4333-8333-333333333333";
const TOKEN = "private-synthetic-never-log";
function env(mode = "activate", changes = {}) {
  return { ACTIVATION_MODE: mode,
    EXPECTED_ACTIVE_DEPLOYMENT_ID: mode === "activate" ? ORIGINAL_DEPLOYMENT : NEW_ID,
    EXPECTED_ACTIVE_VERSION_ID: mode === "activate" ? ORIGINAL_VERSION : BRIDGE_VERSION,
    TARGET_VERSION_ID: mode === "activate" ? BRIDGE_VERSION : ORIGINAL_VERSION,
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), CLOUDFLARE_API_TOKEN: TOKEN,
    GITHUB_RUN_ID: "38198972076", GITHUB_RUN_ATTEMPT: "1", ...changes };
}
function snapshot(mode = "activate", change = {}) {
  const x = parseActivationInput(env(mode));
  return { worker: "mcp-access-stack", activeDeploymentId: x.expectedDeploymentId,
    activeVersionId: x.expectedActiveVersionId, referenceVersionId: x.targetVersionId,
    status: "different_script", scriptEtagEqual: false,
    runtimeMetadataParity: "unverified", bindingMetadataParity: "unverified",
    referenceVersionSource: "wrangler",
    referenceBindingInspection: { shape: "array", namePresence: "present", type: "secret_text" },
    ...change };
}
function after() {
  return { ...snapshot(), activeDeploymentId: NEW_ID,
    activeVersionId: BRIDGE_VERSION, referenceVersionId: BRIDGE_VERSION,
    status: "matching_script", scriptEtagEqual: true };
}
function throwsCode(fn, code) {
  assert.throws(fn, e => e instanceof BridgeActivationError &&
    e.code === code && !String(e.message).includes(TOKEN));
}
async function rejectsCode(fn, code) {
  await assert.rejects(fn, e => e instanceof BridgeActivationError &&
    e.code === code && !String(e.message).includes(TOKEN));
}
test("pins exact bridge activation and rollback; refuses rerun and other versions", () => {
  assert.equal(parseActivationInput(env()).targetVersionId, BRIDGE_VERSION);
  assert.equal(parseActivationInput(env("rollback")).targetVersionId, ORIGINAL_VERSION);
  for (const bad of [
    env("promote"), env("activate", { GITHUB_RUN_ATTEMPT: "2" }),
    env("activate", { TARGET_VERSION_ID: ORIGINAL_VERSION }),
    env("activate", { EXPECTED_ACTIVE_DEPLOYMENT_ID: NEW_ID }),
    env("rollback", { EXPECTED_ACTIVE_DEPLOYMENT_ID: ORIGINAL_DEPLOYMENT }),
    env("rollback", { EXPECTED_ACTIVE_VERSION_ID: ORIGINAL_VERSION }),
  ]) assert.throws(() => parseActivationInput(bad), BridgeActivationError);
});
test("fails closed on precondition drift and required secret missing", () => {
  const x = parseActivationInput(env());
  assert.equal(verifyDeploymentBaseline(snapshot(), x).versionId, ORIGINAL_VERSION);
  for (const change of [
    { activeDeploymentId: NEW_ID }, { activeVersionId: BRIDGE_VERSION },
    { status: "inconclusive" }, { scriptEtagEqual: null },
    { runtimeMetadataParity: "different" }, { bindingMetadataParity: "different" },
  ]) throwsCode(() => verifyDeploymentBaseline(snapshot("activate", change), x),
    "ACTIVE_DEPLOYMENT_CAS_MISMATCH");
  for (const change of [
    { referenceVersionSource: "unverified" },
    { referenceBindingInspection: { namePresence: "unverified", type: "unverified" } },
  ]) throwsCode(() => verifyDeploymentBaseline(snapshot("activate", change), x),
    "BRIDGE_VERSION_UNVERIFIED");
  verifyDeploymentBaseline(snapshot("rollback", {
    referenceBindingInspection: { namePresence: "not_observed", type: "unverified" },
  }), parseActivationInput(env("rollback")));
});
test("validates receipt and post-deploy target at 100 percent", () => {
  const receipt = { success: true, result: { id: NEW_ID, strategy: "percentage",
    versions: [{ version_id: BRIDGE_VERSION, percentage: 100 }] } };
  assert.equal(verifyActivationResult(receipt, BRIDGE_VERSION, ORIGINAL_DEPLOYMENT), NEW_ID);
  throwsCode(() => verifyActivationResult({ ...receipt, result: { ...receipt.result,
    versions: [{ version_id: BRIDGE_VERSION, percentage: 75 }] } },
    BRIDGE_VERSION, ORIGINAL_DEPLOYMENT), "DEPLOYMENT_RECEIPT_UNVERIFIED");
  assert.equal(verifyDeploymentAfter(after(), parseActivationInput(env()), NEW_ID).versionId,
    BRIDGE_VERSION);
  throwsCode(() => verifyDeploymentAfter(snapshot(), parseActivationInput(env()), NEW_ID),
    "DEPLOYMENT_POSTCONDITION_UNVERIFIED");
});
test("one authorized POST, single target, no force or secret in body", async () => {
  let n = 0;
  const id = await createDeployment(parseActivationInput(env()), async (url, init) => {
    n++;
    assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/" +
      "a".repeat(32) + "/workers/scripts/mcp-access-stack/deployments");
    assert.equal(init.method, "POST");
    assert.equal(init.headers.authorization, "Bearer " + TOKEN);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.versions, [{ version_id: BRIDGE_VERSION, percentage: 100 }]);
    assert.equal(body.force, undefined);
    assert.ok(!init.body.includes(TOKEN));
    return new Response(JSON.stringify({ success: true, result: {
      id: NEW_ID, strategy: "percentage", versions: body.versions,
    } }), { status: 200 });
  });
  assert.equal(id, NEW_ID); assert.equal(n, 1);
});
test("unexpected external deployment before POST => zero writes", async () => {
  let reads = 0, writes = 0;
  await rejectsCode(() => executeBridgeTransition(parseActivationInput(env()), {
    compare: async () => ++reads === 1 ? snapshot() : snapshot("activate", { activeDeploymentId: NEW_ID }),
    post: async () => { writes++; },
  }), "ACTIVE_DEPLOYMENT_CAS_MISMATCH");
  assert.equal(reads, 2); assert.equal(writes, 0);
});
test("reconciles after exactly one successful POST", async () => {
  let reads = 0, writes = 0;
  const result = await executeBridgeTransition(parseActivationInput(env()), {
    compare: async () => ++reads <= 2 ? snapshot() : after(),
    post: async () => { writes++; return NEW_ID; },
    sleep: async () => {},
  });
  assert.equal(result.versionId, BRIDGE_VERSION);
  assert.equal(reads, 3); assert.equal(writes, 1);
});
test("unknown outcome never retries POST", async () => {
  for (const problem of ["network", "postcondition"]) {
    let reads = 0, writes = 0;
    await rejectsCode(() => executeBridgeTransition(parseActivationInput(env()), {
      compare: async () => {reads++;return snapshot();},
      post: async () => {writes++;if(problem==="network")throw Error(TOKEN);return NEW_ID;},
      sleep: async () => {},
    }), "DEPLOYMENT_OUTCOME_UNKNOWN");
    assert.equal(writes, 1);
    assert.equal(reads, problem === "network" ? 2 : 6);
  }
});
test("workflow uses protected Environment, shared mutex, pinned main and one-shot execution", async () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const raw = await readFile(path.resolve(dir, "../../.github/workflows/edge-beta84-bridge-activation.yml"), "utf8");
  const parsed = YAML.parseDocument(raw, { uniqueKeys: true });
  assert.deepEqual(parsed.errors, []);
  const x = parsed.toJS();
  assert.deepEqual(Object.keys(x.on.workflow_dispatch.inputs), [
    "expected_main_sha", "operation", "expected_active_deployment_id",
    "expected_active_version_id", "target_version_id",
  ]);
  assert.deepEqual(x.on.workflow_dispatch.inputs.operation.options, ["activate", "rollback"]);
  assert.equal(x.concurrency.group, "public-release-edge");
  assert.equal(x.concurrency["cancel-in-progress"], false);
  assert.equal(x.jobs.transition.environment, "public-release");
  const steps = x.jobs.transition.steps;
  const checkout = steps.find(e => e.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ inputs.expected_main_sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const pre = steps.findIndex(e => e.name?.startsWith("Read-only immutable"));
  const deploy = steps.findIndex(e => e.name?.startsWith("One-shot deployment"));
  assert.ok(deploy > pre && pre > 0);
  assert.equal(steps[pre].env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.equal(steps[deploy].env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.ok(steps.every((e,i) => i === pre || i === deploy ||
    !JSON.stringify(e).includes("secrets.CLOUDFLARE_API_TOKEN")));
  assert.match(raw, /GITHUB_RUN_ATTEMPT.*"1"/u);
  assert.match(raw, /ci_count/u);
  assert.match(steps[pre].run, /activate-edge-beta84-bridge.mjs preflight/u);
  assert.match(steps[deploy].run, /activate-edge-beta84-bridge.mjs execute/u);
  assert.doesNotMatch(raw, /--force|force:\s*true|wrangler deploy|secret put/u);
});

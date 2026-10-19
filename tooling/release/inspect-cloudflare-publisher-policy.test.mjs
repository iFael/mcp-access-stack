import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { inspectPublisherReadOnly, PublisherAuditError } from "./inspect-cloudflare-publisher-policy.mjs";

const ACCOUNT = "a".repeat(32);
const TOKEN_ID = "b".repeat(32);
const SECRET = "not-for-logs-synthetic-secret";
const DEPLOY = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
const VERSION = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const OTHER = "21535ed8-c51b-418e-a387-3cf9ba8fde82";
const input = { accountId: ACCOUNT, token: SECRET, deploymentId: DEPLOY,
  versionId: VERSION, vars: { MCP_EDGE_ENABLED: "true" },
  requiredSecrets: ["MCP_CONTRACT_PREPARE_TOKEN"] };

function fixture(options = {}) {
  const calls = [];
  let deploymentReads = 0;
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.method, "GET");
    assert.equal(opts.redirect, "error");
    assert.equal(opts.body, undefined);
    assert.equal(opts.headers.authorization, "Bearer " + SECRET);
    const p = new URL(url);
    assert.equal(p.origin, "https://api.cloudflare.com");
    const route = p.pathname;
    calls.push(route);
    if (route.endsWith("/deployments")) {
      deploymentReads++;
      return json({ deployments: [{
        id: options.drift && deploymentReads === 2 ? OTHER : DEPLOY,
        versions: options.split ? [
          { version_id: VERSION, percentage: 50 }, { version_id: OTHER, percentage: 50 }
        ] : [{ version_id: VERSION, percentage: 100 }],
      }] });
    }
    if (route === "/client/v4/accounts/" + ACCOUNT + "/tokens/verify") {
      return options.userOwned ? json(null, 403) :
        json({ id: TOKEN_ID, status: options.disabled ? "disabled" : "active" });
    }
    if (route === "/client/v4/user/tokens/verify") {
      return options.userOwned ? json({ id: TOKEN_ID, status: "active" }) : json(null, 403);
    }
    if (route.endsWith("/tokens/" + TOKEN_ID)) {
      if (options.policyDenied) return json(null, 403);
      return json({ policies: [{
        effect: "allow", permission_groups: [
          { name: options.noWrite ? "Workers Scripts Read" : "Workers Scripts Write" },
        ],
        resources: { ["com.cloudflare.api.account." + ACCOUNT]: "*" },
      }] });
    }
    if (route.endsWith("/workers/services/mcp-access-stack")) {
      return json({ default_environment: { script: { migration_tag: options.badTag ? "v2" : "v1" } } });
    }
    if (route.endsWith("/workers/scripts/mcp-access-stack/settings")) {
      if (options.settingsDenied) return json(null, 403);
      return json({ bindings: [{
        name: "MCP_EDGE_ENABLED",
        type: options.collision ? "secret_text" : "plain_text",
        text: options.mismatched ? "false" : "true",
      }, ...(options.missingRequiredSecret ? [] : [{
        name: "MCP_CONTRACT_PREPARE_TOKEN",
        type: options.wrongRequiredType ? "plain_text" : "secret_text", text: "never-print",
      }])] });
    }
    throw Error("UNEXPECTED_ROUTE");
  };
  function json(result, status = 200) {
    return new Response(JSON.stringify({ success: status === 200, result, extra: options.big ? SECRET.repeat(20000) : "" }),
      { status });
  }
  return { calls, fetchImpl };
}

test("audits account token policy and current settings using GET only with CAS", async () => {
  const f = fixture();
  const actual = await inspectPublisherReadOnly(input, f.fetchImpl);
  assert.equal(f.calls.filter(x => x.endsWith("/deployments")).length, 2);
  assert.equal(actual.tokenOwnership, "account");
  assert.equal(actual.tokenStatus, "active");
  assert.equal(actual.tokenPolicyReadability, "readable");
  assert.equal(actual.writePolicyGroup, "present");
  assert.equal(actual.writePolicyAccountScope, "target_account_included");
  assert.equal(actual.remotePlainVarsParity, "matching");
  assert.equal(actual.remoteSecretNameCollision, "not_observed");
  assert.equal(actual.remoteRequiredSecretsPresence, "present");
  assert.equal(actual.serviceMigrationTagParity, "matching");
  assert.equal(actual.publisherWriteScope, "unverified");
  assert.equal(actual.inspection, "get_only");
  const output = JSON.stringify(actual);
  for (const secret of [SECRET, TOKEN_ID, ACCOUNT, "never-print", "permission_groups", "policies"]) {
    assert.ok(!output.includes(secret));
  }
});

test("user-owned token is resolved without assuming account token ownership", async () => {
  const result = await inspectPublisherReadOnly(input, fixture({ userOwned: true }).fetchImpl);
  assert.equal(result.tokenOwnership, "user");
  assert.equal(result.writePolicyGroup, "present");
  assert.equal(result.publisherWriteScope, "unverified");
});

test("unreadable policy is not mistaken for missing Workers Write permission", async () => {
  const result = await inspectPublisherReadOnly(input, fixture({ policyDenied: true, settingsDenied: true }).fetchImpl);
  assert.equal(result.tokenPolicyReadability, "unverified");
  assert.equal(result.writePolicyGroup, "unverified");
  assert.equal(result.remotePlainVarsParity, "unverified");
  assert.equal(result.remoteRequiredSecretsPresence, "unverified");
});

test("policy visibility and presence of a permission do not prove effective Editor access", async () => {
  for (const opts of [{}, { noWrite: true }, { disabled: true }]) {
    const result = await inspectPublisherReadOnly(input, fixture(opts).fetchImpl);
    assert.equal(result.publisherWriteScope, "unverified");
    if (opts.noWrite) assert.equal(result.writePolicyGroup, "not_observed");
    if (opts.disabled) assert.equal(result.tokenStatus, "disabled");
  }
});

test("detects secret/plain text name conflicts without exposing names or values", async () => {
  const result = await inspectPublisherReadOnly(input, fixture({ collision: true, badTag: true }).fetchImpl);
  assert.equal(result.remoteSecretNameCollision, "present");
  assert.equal(result.remotePlainVarsParity, "different");
  assert.equal(result.serviceMigrationTagParity, "different");
  assert.ok(!JSON.stringify(result).includes(SECRET));
});

test("required Worker secret existence is checked by name and type only", async () => {
  for (const [options, state] of [
    [{}, "present"], [{ missingRequiredSecret: true }, "not_observed"],
    [{ wrongRequiredType: true }, "not_observed"],
    [{ settingsDenied: true }, "unverified"],
  ]) {
    const result = await inspectPublisherReadOnly(input, fixture(options).fetchImpl);
    assert.equal(result.remoteRequiredSecretsPresence, state);
    const printed = JSON.stringify(result);
    for (const sensitive of [SECRET, "never-print", "MCP_CONTRACT_PREPARE_TOKEN"]) {
      assert.ok(!printed.includes(sensitive));
    }
  }
});

test("rejects split traffic, CAS drift, and oversized responses without data leakage", async () => {
  for (const [opts, code] of [
    [{ split: true }, "ACTIVE_DEPLOYMENT_INVALID"],
    [{ drift: true }, "ACTIVE_DEPLOYMENT_CHANGED"],
    [{ big: true }, "RESPONSE_TOO_LARGE"],
  ]) {
    await assert.rejects(() => inspectPublisherReadOnly(input, fixture(opts).fetchImpl),
      e => e instanceof PublisherAuditError && e.code === code && !String(e).includes(SECRET));
  }
});

test("rejects bad inputs before networking", async () => {
  const f = fixture();
  for (const bad of [{ accountId: "../" }, { deploymentId: "invalid" },
    { versionId: "invalid" }, { token: "short" }, { vars: { KEY: 4 } },
    { requiredSecrets: [] }, { requiredSecrets: ["../"] },
    { requiredSecrets: ["DUP", "DUP"] }]) {
    await assert.rejects(() => inspectPublisherReadOnly({ ...input, ...bad }, f.fetchImpl),
      e => e instanceof PublisherAuditError);
  }
  assert.equal(f.calls.length, 0);
});

test("workflow is manual main-only, bound to public-release and audited in CI", async () => {
  const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const workflow = await readFile(path.join(root, ".github/workflows/cloudflare-publisher-policy-readonly.yml"), "utf8");
  const doc = YAML.parseDocument(workflow, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0);
  const config = doc.toJS();
  assert.deepEqual(Object.keys(config.on.workflow_dispatch.inputs), [
    "expected_main_sha", "expected_active_deployment_id", "expected_active_version_id"]);
  assert.equal(config.jobs.inspect.environment, "public-release");
  assert.equal(config.permissions.contents, "read");
  assert.equal(config.concurrency["cancel-in-progress"], false);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /\$\{\{ github\.token \}\}/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /inspect-cloudflare-publisher-policy\.mjs/);
  assert.doesNotMatch(workflow, /wrangler\s+versions|wrangler\s+deploy|\b(?:POST|PUT|PATCH)\b|secret put|actions\/upload-artifact|workflow_run:/i);
  const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(ci, /node --test[^\n]*inspect-cloudflare-publisher-policy\.test\.mjs/);
});

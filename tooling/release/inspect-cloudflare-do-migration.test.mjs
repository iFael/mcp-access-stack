import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import YAML from "yaml";
import {
  inspectWorkerDoMigration, MigrationInspectionError,
} from "./inspect-cloudflare-do-migration.mjs";

const ACCOUNT = "a".repeat(32);
const VERSION = "7b536d5f-8afb-4da0-927e-44cf6e23b6d6";
const DEPLOY = "10535ed8-c51b-418e-a387-3cf9ba8fde82";
const NEXT_DEPLOY = "21535ed8-c51b-418e-a387-3cf9ba8fde82";
const TOKEN = "only-synthetic-read-token";
const input = {
  accountId: ACCOUNT, token: TOKEN, expectedDeploymentId: DEPLOY,
  expectedVersionId: VERSION, expectedMigrationTag: "v1",
};

function fixture({ migrationTag = "v1", drift = false, split = false,
  missingScript = false, wrongVersion = false, http = 200,
  oversized = false, emptyDeployments = false, unsafeTag = false,
  omitTag = false, omitRuntime = false, invalidRuntime = false,
  legacyOnlyTag = false } = {}) {
  const calls = [];
  let deployments = 0;
  const fetchImpl = async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.authorization, "Bearer " + TOKEN);
    assert.equal(new URL(url).origin, "https://api.cloudflare.com");
    assert.ok(new URL(url).pathname.startsWith(
      "/client/v4/accounts/" + ACCOUNT + "/workers/scripts/mcp-access-stack/"));
    calls.push(url);
    const deploymentCall = url.endsWith("/deployments");
    if (deploymentCall) deployments++;
    const response = deploymentCall ? {
      success: true, result: { deployments: emptyDeployments ? [] : [{
        id: drift && deployments > 1 ? NEXT_DEPLOY : DEPLOY,
        created_on: "2026-10-08T03:27:40Z", source: "wrangler",
        versions: split
          ? [{ version_id: VERSION, percentage: 50 }, { version_id: VERSION, percentage: 50 }]
          : [{ version_id: VERSION, percentage: 100 }],
      }] },
    } : {
      success: true,
      result: {
        id: wrongVersion ? NEXT_DEPLOY : VERSION,
        resources: missingScript ? {} : {
          script: {
            etag: "0123456789abcdef",
            ...(legacyOnlyTag ? { migration_tag: "v1" } : {}),
          },
          ...(!omitRuntime ? {
            script_runtime: invalidRuntime ? [] : unsafeTag
              ? { migration_tag: { leak: "secret-private-value" } }
              : omitTag || legacyOnlyTag ? {} : { migration_tag: migrationTag },
          } : {}),
        },
      },
    };
    if (oversized) response.extra = "private".repeat(60000);
    return new Response(JSON.stringify(response), { status: http });
  };
  return { fetchImpl, calls };
}

async function fails(options, code) {
  const f = fixture(options);
  await assert.rejects(
    () => inspectWorkerDoMigration(input, f.fetchImpl),
    error => error instanceof MigrationInspectionError && error.code === code &&
      !String(error.message).includes(ACCOUNT));
  return f;
}

test("GET-only, CAS-pinned matching migration_tag returns only safe summary", async () => {
  const f = fixture();
  const r = await inspectWorkerDoMigration(input, f.fetchImpl);
  assert.deepEqual({ status: r.status, parity: r.migrationTagParity,
    deployment: r.activeDeploymentId, version: r.activeVersionId },
  { status: "matching", parity: "matching", deployment: DEPLOY, version: VERSION });
  assert.deepEqual(f.calls.map(x => new URL(x).pathname.split("/").at(-1)),
    ["deployments", VERSION, "deployments"]);
  const serialized = JSON.stringify(r);
  for (const secret of [TOKEN, ACCOUNT, "private", "migration_tag"]) {
    assert.ok(!serialized.includes(secret));
  }
});
test("missing or null remote migration tag stays unverified, never matching", async () => {
  for (const options of [
    { omitTag: true }, { migrationTag: null },
    { omitRuntime: true }, { legacyOnlyTag: true },
  ]) {
    const r = await inspectWorkerDoMigration(input, fixture(options).fetchImpl);
    assert.equal(r.migrationTagParity, "unverified");
    assert.equal(r.status, "unverified");
  }
});
test("different remote migration tag is reported without printing actual tag", async () => {
  const r = await inspectWorkerDoMigration(input, fixture({ migrationTag: "secret-private-value" }).fetchImpl);
  assert.equal(r.migrationTagParity, "different");
  assert.ok(!JSON.stringify(r).includes("secret-private-value"));
});
test("invalid remote metadata, HTTP failure and oversized response fail closed", async () => {
  await fails({ unsafeTag: true }, "MIGRATION_TAG_INVALID");
  await fails({ invalidRuntime: true }, "VERSION_SHAPE_INVALID");
  await fails({ missingScript: true }, "VERSION_SHAPE_INVALID");
  await fails({ wrongVersion: true }, "VERSION_ID_MISMATCH");
  await fails({ http: 403 }, "CLOUDFLARE_READ_FAILED");
  await fails({ oversized: true }, "RESPONSE_TOO_LARGE");
});
test("split traffic, changed deployment, missing active deployment fail closed", async () => {
  await fails({ split: true }, "DEPLOYMENT_TRAFFIC_INVALID");
  await fails({ drift: true }, "DEPLOYMENT_CHANGED_DURING_READ");
  await fails({ emptyDeployments: true }, "DEPLOYMENT_LIST_INVALID");
});
test("invalid input or credentials fail before any Cloudflare request", async () => {
  const f = fixture();
  for (const change of [
    { expectedVersionId: "wrong" }, { expectedDeploymentId: "wrong" },
    { accountId: "wrong" }, { token: "invalid" },
    { expectedMigrationTag: "bad<tag" },
  ]) {
    await assert.rejects(() => inspectWorkerDoMigration({ ...input, ...change }, f.fetchImpl),
      e => e instanceof MigrationInspectionError);
  }
  assert.equal(f.calls.length, 0);
});
test("workflow is manual GET-only with exact main SHA and immutable active-version CAS", async () => {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const workflow = await readFile(path.resolve(base,
    "../../.github/workflows/cloudflare-do-migration-tag.yml"), "utf8");
  const parsed = YAML.parseDocument(workflow, { uniqueKeys: true });
  assert.equal(parsed.errors.length, 0);
  const doc = parsed.toJS();
  assert.deepEqual(Object.keys(doc.on.workflow_dispatch.inputs), [
    "expected_main_sha", "expected_active_deployment_id", "expected_active_version_id",
  ]);
  assert.equal(doc.permissions.contents, "read");
  assert.equal(doc.jobs.inspect.environment, "cloudflare-observability");
  assert.equal(doc.concurrency["cancel-in-progress"], false);
  assert.match(workflow, /CF_PROVENANCE_READ_TOKEN/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT/);
  assert.match(workflow, /gh api repos\/iFael\/mcp-access-stack\/git\/ref\/heads\/main/);
  assert.match(workflow, /inspect-cloudflare-do-migration\.mjs/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|wrangler|curl\s+-X\s+POST|upload-artifact|actions\/upload-artifact|(?:^|\s)deploy(?:\s|$)/u);
  assert.equal((workflow.match(/expected_active_version_id/g) ?? []).length >= 2, true);
});

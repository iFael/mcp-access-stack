import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { compareWorkerVersions, ProvenanceError } from "./compare-cloudflare-worker-versions.mjs";

const ACCOUNT = "a".repeat(32);
const CURRENT = "7b536d5f-1111-4111-8111-111111111111";
const HISTORICAL = "d2ff2f5f-e2b5-4b6a-badc-0f9c312a1a51";
const DEPLOY = "11111111-1111-4111-8111-111111111111";
const NEXT_DEPLOY = "22222222-2222-4222-8222-222222222222";
const TOKEN = "synthetic-test-token-only";

function fixture(options = {}) {
  const calls = [];
  let deploymentReads = 0;
  const deployment = (id, versionId, split = false, createdOn = "2026-10-08T12:00:00Z") => ({
    id, created_on: createdOn, source: options.badSource ?? "wrangler",
    versions: split
      ? [{ version_id: CURRENT, percentage: 75 },
        { version_id: HISTORICAL, percentage: 25 }]
      : [{ version_id: versionId, percentage: 100 }],
  });
  const version = (id, etag, opts = {}) => ({
    id,
    metadata: {
      source: opts.badSource ?? "wrangler",
      created_on: "2026-10-08T12:01:00Z",
    },
    resources: {
      script: etag === null ? {} : { etag },
      script_runtime: opts.missingRuntime ? undefined : {
        compatibility_date: "2026-08-17T00:00:00Z",
        compatibility_flags: opts.flags ?? ["nodejs_compat"],
      },
      bindings: opts.bindings ?? {
        MCP_SESSION: { type: "durable_object_namespace", secret_value: "private-binding-value" },
        MCP_OWNER_TOKEN: { type: "secret_text", text: "private-secret-value" },
      },
    },
  });
  const fetchImpl = async (address, init) => {
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, "Bearer " + TOKEN);
    const u = new URL(address);
    assert.equal(u.origin, "https://api.cloudflare.com");
    assert.equal(u.pathname.startsWith(
      "/client/v4/accounts/" + ACCOUNT + "/workers/scripts/mcp-access-stack/"), true);
    calls.push({ method: init.method, path: u.pathname });
    if (options.networkFailure) throw Error("private-network-detail");
    if (u.pathname.endsWith("/deployments")) {
      deploymentReads++;
      if (options.responseTooLarge) {
        return new Response(JSON.stringify({ success: true,
          result: { deployments: [deployment(DEPLOY, CURRENT)],
            huge: "x".repeat(270000) } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: options.successFalse ? false : true,
        result: {
          deployments: [
            deployment(deploymentReads > 1 && options.drift ? NEXT_DEPLOY : DEPLOY,
              CURRENT, options.splitTraffic),
            ...(options.secondDeployment
              ? [deployment(NEXT_DEPLOY, HISTORICAL, false, "2026-10-09T12:00:00Z")]
              : []),
          ],
        },
      }), { status: options.httpError ?? 200 });
    }
    const id = u.pathname.split("/").at(-1);
    return new Response(JSON.stringify({ success: true, result: version(
      options.wrongId ? HISTORICAL : id,
      id === CURRENT ? options.currentEtag ?? "a".repeat(64) :
        options.referenceEtag === undefined ? "a".repeat(64) : options.referenceEtag,
      id === CURRENT ? {
        flags: options.currentFlags,
        missingRuntime: options.missingRuntime,
        bindings: options.currentBindings,
        badSource: options.badSource,
      } : {
        flags: options.referenceFlags,
        bindings: options.referenceBindings,
        badSource: options.badSource,
      },
    ) }), { status: 200 });
  };
  return {
    calls, fetchImpl, input: {
      accountId: ACCOUNT, referenceVersionId: HISTORICAL, token: TOKEN,
    },
  };
}

async function errorCode(run, code) {
  await assert.rejects(run, (error) =>
    error instanceof ProvenanceError && error.code === code);
}

test("identical script and safe metadata; never expose binding or secret values", async () => {
  const f = fixture();
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.status, "matching_script");
  assert.equal(result.scriptEtagEqual, true);
  assert.equal(result.runtimeMetadataParity, "matching");
  assert.equal(result.bindingMetadataParity, "matching");
  assert.equal(result.secretValueParity, "unverified");
  assert.equal(result.activeDeploymentId, DEPLOY);
  assert.equal(result.deploymentSource, "wrangler");
  assert.equal(result.activeVersionSource, "wrangler");
  assert.equal(result.referenceVersionSource, "wrangler");
  assert.equal(result.activeVersionCreatedOn, "2026-10-08T12:01:00.000Z");
  assert.equal(result.activeVersionId, CURRENT);
  assert.equal(result.referenceVersionId, HISTORICAL);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((item) => item.method === "GET"));
  const output = JSON.stringify(result);
  for (const forbidden of ["private-", "MCP_OWNER_TOKEN", TOKEN, ACCOUNT, "etag"]) {
    assert.ok(!output.includes(forbidden), forbidden);
  }
});

test("different script etag is distinct from metadata and secrets", async () => {
  const f = fixture({ referenceEtag: "b".repeat(64) });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.status, "different_script");
  assert.equal(result.scriptEtagEqual, false);
  assert.equal(result.secretValueParity, "unverified");
});

test("unknown etag is inconclusive, not a match", async () => {
  const f = fixture({ referenceEtag: null });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.scriptEtagEqual, null);
  assert.equal(result.status, "inconclusive");
});

test("runtime difference reported separately from matching script", async () => {
  const f = fixture({ referenceFlags: ["different_flag"] });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.scriptEtagEqual, true);
  assert.equal(result.runtimeMetadataParity, "different");
});

test("binding types different but values always unverified", async () => {
  const f = fixture({ referenceBindings: { MCP_SESSION: { type: "plain_text" } } });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.bindingMetadataParity, "different");
  assert.equal(result.secretValueParity, "unverified");
});

test("non-standard binding shape produces unverified metadata", async () => {
  const f = fixture({ referenceBindings: { X: { value: "do not read" } } });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.bindingMetadataParity, "unverified");
});

test("split deployment is rejected before version reads", async () => {
  const f = fixture({ splitTraffic: true });
  await errorCode(() => compareWorkerVersions(f.input, f.fetchImpl),
    "TRAFFIC_SPLIT_UNSUPPORTED");
  assert.equal(f.calls.length, 1);
});

test("deployment change between reads fails closed", async () => {
  const f = fixture({ drift: true });
  await errorCode(() => compareWorkerVersions(f.input, f.fetchImpl),
    "DEPLOYMENT_CHANGED_DURING_READ");
  assert.equal(f.calls.length, 4);
});

test("wrong version ID in API response fails closed", async () => {
  const f = fixture({ wrongId: true });
  await errorCode(() => compareWorkerVersions(f.input, f.fetchImpl),
    "VERSION_ID_MISMATCH");
});

test("invalid IDs and absent token fail before the network", async () => {
  const f = fixture();
  await errorCode(() => compareWorkerVersions({ ...f.input, accountId: "x" }, f.fetchImpl),
    "ACCOUNT_ID_INVALID");
  await errorCode(() => compareWorkerVersions({
    ...f.input, referenceVersionId: "invalid",
  }, f.fetchImpl), "REFERENCE_VERSION_INVALID");
  await errorCode(() => compareWorkerVersions({ ...f.input, token: "" }, f.fetchImpl),
    "READ_TOKEN_MISSING");
  assert.equal(f.calls.length, 0);
});

test("HTTP error, API negative response and network error are sanitized", async () => {
  for (const [opts, code] of [
    [{ httpError: 403 }, "CLOUDFLARE_READ_FAILED"],
    [{ successFalse: true }, "RESPONSE_SHAPE_INVALID"],
    [{ networkFailure: true }, "CLOUDFLARE_NETWORK_FAILED"],
  ]) {
    const f = fixture(opts);
    await errorCode(() => compareWorkerVersions(f.input, f.fetchImpl), code);
  }
});

test("responses above byte limit fail closed before parsing", async () => {
  const f = fixture({ responseTooLarge: true });
  await errorCode(() => compareWorkerVersions(f.input, f.fetchImpl),
    "RESPONSE_TOO_LARGE");
});

test("Cloudflare's first deployment stays authoritative, even if another has newer timestamp", async () => {
  const f = fixture({ secondDeployment: true });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.activeDeploymentId, DEPLOY);
  assert.equal(result.activeVersionId, CURRENT);
});

test("untrusted version and deployment source never propagates raw metadata", async () => {
  const f = fixture({ badSource: "private-token-should-not-appear" });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.deploymentSource, "unverified");
  assert.equal(result.activeVersionSource, "unverified");
  assert.equal(result.referenceVersionSource, "unverified");
  assert.ok(!JSON.stringify(result).includes("private-token"));
});

test("same binding types cannot attest equality of secret values", async () => {
  const f = fixture({
    referenceBindings: {
      MCP_SESSION: { type: "durable_object_namespace", secret_value: "another-private-binding" },
      MCP_OWNER_TOKEN: { type: "secret_text", text: "another-secret" },
    },
  });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.bindingMetadataParity, "matching");
  assert.equal(result.secretValueParity, "unverified");
  assert.ok(!JSON.stringify(result).includes("another-"));
});

test("workflow is manual, main-guarded and contains no deploy or secret-sync command", async () => {
  const source = await readFile(new URL(
    "../../.github/workflows/cloudflare-version-provenance.yml", import.meta.url), "utf8");
  assert.match(source, /^on:\n  workflow_dispatch:/mu);
  assert.doesNotMatch(source, /^\s*(push|schedule|pull_request_target):/mu);
  assert.match(source, /^permissions:\n  contents: read$/mu);
  assert.match(source, /^concurrency:[\s\S]*?cancel-in-progress: false/mu);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/u);
  assert.match(source, /GITHUB_SHA" == "\$EXPECTED_MAIN_SHA/u);
  assert.match(source, /environment: cloudflare-observability/u);
  assert.match(source, /node tooling\/release\/compare-cloudflare-worker-versions\.mjs/u);
  assert.doesNotMatch(source, /wrangler|secret put|npm run deploy|curl.*-X\s*(POST|PUT|DELETE)/iu);
});

test("missing runtime metadata is not treated as equal", async () => {
  const f = fixture({ missingRuntime: true });
  const result = await compareWorkerVersions(f.input, f.fetchImpl);
  assert.equal(result.runtimeMetadataParity, "unverified");
});

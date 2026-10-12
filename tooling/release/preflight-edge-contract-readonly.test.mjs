import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { EdgePreflightError, preflightEdgeContract } from "./preflight-edge-contract-readonly.mjs";

const SAFE_ID = "11111111-1111-4111-8111-111111111111";
const CHANGED_ID = "22222222-2222-4222-8222-222222222222";
const TRUSTED = "a".repeat(64);
const NEXT = "b".repeat(64);
const OTHER = "c".repeat(64);
const TOKEN = "synthetic-isolated-bearer-token";
const BASE = "https://edge.example/";

function input(extra = {}) {
  return {
    accountId: "d".repeat(32), cloudflareToken: "synthetic-cf-token",
    inspectionToken: TOKEN, trustedVersionId: SAFE_ID,
    trustedRevision: TRUSTED, nextRevision: NEXT,
    edgeBaseUrl: BASE, ...extra,
  };
}
function provenance(override = {}) {
  return {
    activeVersionId: SAFE_ID, referenceVersionId: SAFE_ID,
    activeDeploymentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    status: "matching_script", scriptEtagEqual: true,
    runtimeMetadataParity: "matching", bindingMetadataParity: "matching",
    ...override,
  };
}
function status(extra = {}) {
  return {
    activeContractRevision: TRUSTED,
    candidateConnectorReady: false,
    ...extra,
  };
}
function fake({ deployments = [provenance()], payload = status(), responseStatus = 200,
  contentType = "application/json", errors = {}, mutateResponse } = {}) {
  const requests = [];
  const cfCalls = [];
  let cfReads = 0;
  const compare = async (args) => {
    cfCalls.push(args);
    if (errors.cf) throw new Error("external-secret-failure");
    return deployments[Math.min(cfReads++, deployments.length - 1)];
  };
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init });
    if (errors.edge) throw new Error("private-upstream");
    if (mutateResponse) return mutateResponse();
    return new Response(JSON.stringify(payload), {
      status: responseStatus, headers: { "content-type": contentType },
    });
  };
  return { compare, fetchImpl, requests, cfCalls };
}
async function fails(code, args, deps) {
  await assert.rejects(() => preflightEdgeContract(args, deps),
    error => error instanceof EdgePreflightError && error.code === code &&
      !String(error.message).includes(TOKEN) &&
      !String(error.message).includes("synthetic-cf-token"));
}

test("refuses without independently approved immutable inspection version before network/DO", async () => {
  for (const missing of [undefined, "", "legacy-version", CHANGED_ID.slice(0, 14)]) {
    const f = fake();
    await fails("SAFE_INSPECTION_VERSION_NOT_APPROVED", input({ trustedVersionId: missing }), f);
    assert.equal(f.cfCalls.length, 0);
    assert.equal(f.requests.length, 0);
  }
});

test("refuses invalid revisions, HTTPS base URL, missing credentials without network", async () => {
  const cases = [
    ["REVISION_INPUT_INVALID", { nextRevision: "not-a-revision" }],
    ["REVISION_INPUT_INVALID", { trustedRevision: "not-a-revision" }],
    ["EDGE_BASE_URL_INVALID", { edgeBaseUrl: "http://edge.example/" }],
    ["EDGE_BASE_URL_INVALID", { edgeBaseUrl: "https://edge.example/evil" }],
    ["EDGE_BASE_URL_INVALID", { edgeBaseUrl: "https://someone:password@edge.example/" }],
    ["READ_CREDENTIAL_UNAVAILABLE", { inspectionToken: "" }],
    ["READ_CREDENTIAL_UNAVAILABLE", { cloudflareToken: undefined }],
  ];
  for (const [error, changes] of cases) {
    const f = fake();
    await fails(error, input(changes), f);
    assert.equal(f.cfCalls.length, 0);
    assert.equal(f.requests.length, 0);
  }
});

test("never touches legacy beta.84 worker when active version differs from approved safe version", async () => {
  for (const change of [
    { activeVersionId: CHANGED_ID },
    { scriptEtagEqual: false, status: "different_script" },
    { referenceVersionId: CHANGED_ID },
    { bindingMetadataParity: "different" },
    { runtimeMetadataParity: "different" },
    { runtimeMetadataParity: undefined },
    { bindingMetadataParity: undefined },
    { status: "inconclusive", scriptEtagEqual: null },
  ]) {
    const f = fake({ deployments: [provenance(change)] });
    await fails("ACTIVE_SCRIPT_NOT_APPROVED_FOR_INSPECTION", input(), f);
    assert.equal(f.cfCalls.length, 1);
    assert.equal(f.requests.length, 0);
  }
});

test("accepts unavailable optional metadata only for the exact pinned immutable version", async () => {
  const f = fake({ deployments: [provenance({
    runtimeMetadataParity: "unverified",
    bindingMetadataParity: "unverified",
  })] });
  const result = await preflightEdgeContract(input(), f);
  assert.deepEqual(result, { activeRevision: TRUSTED, candidateRevision: null });
  assert.equal(f.cfCalls.length, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].init.method, "GET");
});

test("rejects newly detected metadata drift after read-only inspection", async () => {
  for (const override of [
    { runtimeMetadataParity: "different" },
    { bindingMetadataParity: "different" },
    { referenceVersionId: CHANGED_ID },
  ]) {
    const f = fake({ deployments: [
      provenance({ runtimeMetadataParity: "unverified", bindingMetadataParity: "unverified" }),
      provenance(override),
    ] });
    await fails("ACTIVE_SCRIPT_NOT_APPROVED_FOR_INSPECTION", input(), f);
    assert.equal(f.requests.length, 1);
  }
});

test("fails closed if Cloudflare API is unavailable, before Worker resolution", async () => {
  const f = fake({ errors: { cf: true } });
  await fails("SCRIPT_PROVENANCE_UNAVAILABLE", input(), f);
  assert.equal(f.requests.length, 0);
});

test("read-only GET inspection with CAS verified against stable prior contract", async () => {
  const f = fake();
  const result = await preflightEdgeContract(input(), f);
  assert.deepEqual(result, { activeRevision: TRUSTED, candidateRevision: null });
  assert.equal(f.cfCalls.length, 2);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, BASE + "_internal/contract-rollout/status");
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.requests[0].init.body, undefined);
  assert.equal(f.requests[0].init.redirect, "error");
  assert.equal(f.requests[0].init.headers.authorization, "Bearer " + TOKEN);
  assert.equal(f.cfCalls[0].referenceVersionId, SAFE_ID);
});

test("existing same-build candidate is idempotently accepted while preserving expected active CAS", async () => {
  const f = fake({ payload: status({ activeContractRevision: OTHER,
    candidateContractRevision: TRUSTED, candidateConnectorReady: false }) });
  assert.deepEqual(await preflightEdgeContract(input({
    trustedRevision: TRUSTED, nextRevision: TRUSTED,
  }), f), { activeRevision: OTHER, candidateRevision: TRUSTED });
});

test("same-build already-active with no candidate is accepted", async () => {
  const f = fake();
  const got = await preflightEdgeContract(input({ nextRevision: TRUSTED }), f);
  assert.equal(got.activeRevision, TRUSTED);
});

test("rejects outdated active CAS and any competing candidate before deploying", async () => {
  const cases = [
    ["CONTRACT_CHANGE_REQUIRES_STABLE_PREVIOUS_EDGE", status({ activeContractRevision: OTHER })],
    ["CONTRACT_CHANGE_HAS_EXISTING_CANDIDATE", status({ candidateContractRevision: OTHER })],
  ];
  for (const [err, state] of cases) {
    const f = fake({ payload: state });
    await fails(err, input(), f);
    assert.equal(f.cfCalls.length, 1);
    assert.equal(f.requests.length, 1);
  }
});

test("same-build operation refuses another candidate or missing prepared state", async () => {
  const cases = [
    ["CONTRACT_CANDIDATE_CONFLICT", status({ candidateContractRevision: OTHER })],
    ["CONTRACT_NOT_ACTIVE_OR_PREPARED", status({ activeContractRevision: OTHER })],
  ];
  for (const [err, state] of cases) {
    const f = fake({ payload: state });
    await fails(err, input({ nextRevision: TRUSTED }), f);
  }
});

test("invalid/malformed/unavailable/bounded inspection responses fail closed", async () => {
  const cases = [
    ["INSPECTION_RESPONSE_INVALID", { responseStatus: 404 }],
    ["INSPECTION_RESPONSE_INVALID", { responseStatus: 503 }],
    ["INSPECTION_RESPONSE_INVALID", { contentType: "text/plain" }],
    ["INSPECTION_RESPONSE_INVALID", { mutateResponse: () => new Response("not-json", { headers: { "content-type": "application/json" } }) }],
    ["INSPECTION_RESPONSE_TOO_LARGE", { payload: { data: "x".repeat(10_000) } }],
    ["ROLLOUT_STATUS_INVALID", { payload: {} }],
    ["ROLLOUT_STATUS_INVALID", { payload: status({ activeContractRevision: "invalid" }) }],
    ["ROLLOUT_STATUS_INVALID", { payload: status({ candidateContractRevision: TRUSTED }) }],
    ["ROLLOUT_STATUS_INVALID", { payload: status({ candidateConnectorReady: "true" }) }],
    ["INSPECTION_UNAVAILABLE", { errors: { edge: true } }],
  ];
  for (const [err, config] of cases) {
    const f = fake(config);
    await fails(err, input(), f);
  }
});

test("drift on deployment or provenance during inspection fails closed", async () => {
  for (const changes of [
    { activeDeploymentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { activeVersionId: CHANGED_ID },
    { scriptEtagEqual: false, status: "different_script" },
  ]) {
    const f = fake({ deployments: [provenance(), provenance(changes)] });
    await fails(changes.activeDeploymentId ? "DEPLOYMENT_CHANGED_DURING_PREFLIGHT" :
      "ACTIVE_SCRIPT_NOT_APPROVED_FOR_INSPECTION", input(), f);
    assert.equal(f.requests.length, 1);
  }
});

test("release workflow does not access legacy /health until after deploy and requires ready runtime", async () => {
  const source = (await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const preflightStart = source.indexOf("      - name: Preflight contract rollout compatibility");
  const deployStart = source.indexOf("npm run deploy --workspace @mcp-access-stack/edge-gateway");
  const readinessStart = source.indexOf("      - name: Verify prepared Edge contract before publication");
  assert.ok(preflightStart >= 0 && deployStart > preflightStart && readinessStart > deployStart);
  const predeploy = source.slice(preflightStart, deployStart);
  assert.ok(predeploy.includes("tooling/release/preflight-edge-contract-readonly.mjs"));
  assert.ok(predeploy.includes("vars.EDGE_SAFE_INSPECTION_VERSION_ID"));
  assert.ok(predeploy.includes("vars.EDGE_SAFE_INSPECTION_CONTRACT_REVISION"));
  assert.ok(!predeploy.includes("/health"), "legacy health cold-start must not be invoked before deploy");
  const verify = source.slice(readinessStart, source.indexOf("      - name:", readinessStart + 10));
  assert.ok(verify.includes('candidate_connector_ready" == "true"'));
  assert.ok(verify.includes('candidate_runtime_revision" == "$EXPECTED_CONTRACT_REVISION"'));
  assert.ok(verify.includes('execution_plane_ready" == "true"'));
  assert.ok(verify.includes('active_runtime_revision" == "$EXPECTED_CONTRACT_REVISION"'));
  assert.ok(!verify.includes('connected_runtime_safe=true'));
  assert.ok(verify.includes("control_plane_ready"));
});

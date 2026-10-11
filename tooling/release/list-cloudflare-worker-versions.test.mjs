import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inventoryWorkerVersions, InventoryError } from "./list-cloudflare-worker-versions.mjs";

const ACCOUNT = "a".repeat(32);
const TOKEN = "synthetic-read-token";
const VERSION = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const createItem = (n, meta = {}) => ({
  id: VERSION(n),
  metadata: { created_on: "2026-10-11T02:17:05.000Z", source: "wrangler", ...meta },
  author_email: "private@example.com",
  resources: { bindings: [{ name: "SECRET_TOKEN", value: "private-credential" }] },
});
function mockPages(pages, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u.href, method: init.method });
    assert.equal(u.origin, "https://api.cloudflare.com");
    assert.equal(u.pathname, `/client/v4/accounts/${ACCOUNT}/workers/scripts/mcp-access-stack/versions`);
    assert.equal(u.searchParams.get("per_page"), "20");
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, "Bearer " + TOKEN);
    if (opts.networkError) throw new Error("private-network-secret");
    const page = Number(u.searchParams.get("page"));
    const data = opts.badPayload || { success: true, result: { items: pages[page - 1] ?? [] },
      result_info: opts.noResultInfo ? undefined : { page, per_page: 20, total_pages: pages.length } };
    return new Response(JSON.stringify(data), { status: opts.httpStatus ?? 200 });
  };
  return { calls, fetchImpl };
}
async function fails(fetchImpl, code, overrides = {}) {
  await assert.rejects(inventoryWorkerVersions({ accountId: ACCOUNT, token: TOKEN, ...overrides }, fetchImpl),
    e => e instanceof InventoryError && e.code === code);
}

test("only GET requests; sanitized IDs, UTC timestamps and allowlisted sources", async () => {
  const pages = [Array.from({ length: 20 }, (_, i) => createItem(i + 1)), [
    createItem(21, { source: "private-secret-from-API", created_on: "not-a-date" }),
    createItem(22, { source: "api" }),
  ]];
  const m = mockPages(pages);
  const result = await inventoryWorkerVersions({ accountId: ACCOUNT, token: TOKEN }, m.fetchImpl);
  assert.equal(result.worker, "mcp-access-stack");
  assert.equal(result.status, "complete");
  assert.equal(result.versions.length, 22);
  assert.equal(result.versions[0].createdOn, "2026-10-11T02:17:05.000Z");
  assert.deepEqual(result.versions[20], { id: VERSION(21), createdOn: null, source: "unverified" });
  assert.equal(result.versions[21].source, "api");
  assert.equal(m.calls.length, 2);
  assert.ok(m.calls.every(c => c.method === "GET"));
  const output = JSON.stringify(result);
  for (const forbidden of ["private", ACCOUNT, TOKEN, "SECRET_TOKEN", "bindings", "author_email", "resources"]) {
    assert.ok(!output.includes(forbidden), forbidden);
  }
});
test("bounded pagination declares partial inventory rather than claiming exhaustive coverage", async () => {
  const pages = Array.from({ length: 8 }, (_, p) =>
    Array.from({ length: 20 }, (_, i) => createItem(p * 20 + i + 1)));
  const m = mockPages(pages);
  const result = await inventoryWorkerVersions({ accountId: ACCOUNT, token: TOKEN }, m.fetchImpl);
  assert.equal(result.status, "bounded_partial");
  assert.equal(result.pagesRead, 5);
  assert.equal(result.versions.length, 100);
  assert.equal(m.calls.length, 5);
});
test("pagination without metadata remains partial at hard page cap", async () => {
  const m = mockPages(Array.from({ length: 5 }, (_, p) =>
    Array.from({ length: 20 }, (_, i) => createItem(p * 20 + i + 1))), { noResultInfo: true });
  const result = await inventoryWorkerVersions({ accountId: ACCOUNT, token: TOKEN }, m.fetchImpl);
  assert.equal(result.status, "bounded_partial");
});
test("short page without API pagination metadata must not claim completeness", async () => {
  const m = mockPages([[createItem(1)]], { noResultInfo: true });
  const result = await inventoryWorkerVersions({ accountId: ACCOUNT, token: TOKEN }, m.fetchImpl);
  assert.equal(result.status, "bounded_partial");
  assert.equal(result.versions.length, 1);
});
test("duplicate IDs and conflicting pagination fail closed", async () => {
  const list = Array.from({ length: 20 }, (_, i) => createItem(i + 1));
  await fails(mockPages([list, [createItem(1)]]).fetchImpl, "DUPLICATE_VERSION_ID");
  await fails(mockPages([[createItem(1)]], { badPayload: {
    success: true, result: { items: [createItem(1)] },
    result_info: { page: 2, per_page: 20, total_pages: 2 },
  }}).fetchImpl, "PAGINATION_INVALID");
});
test("negative API responses, shape errors, and network errors are sanitized", async () => {
  await fails(mockPages([], { httpStatus: 403 }).fetchImpl, "CLOUDFLARE_READ_FAILED");
  await fails(mockPages([], { networkError: true }).fetchImpl, "CLOUDFLARE_NETWORK_FAILED");
  await fails(mockPages([], { badPayload: { success: false, errors: [{ message: "secret" }] } }).fetchImpl, "RESPONSE_SHAPE_INVALID");
  await fails(mockPages([], { badPayload: { success: true, result: { items: "unsafe" } } }).fetchImpl, "RESPONSE_SHAPE_INVALID");
  await fails(mockPages([], { badPayload: { success: true, result: { items: [{ id: "bad" }] } } }).fetchImpl, "VERSION_ID_INVALID");
});
test("invalid input fails before contacting Cloudflare", async () => {
  const m = mockPages([]);
  await fails(m.fetchImpl, "ACCOUNT_ID_INVALID", { accountId: "bad" });
  await fails(m.fetchImpl, "READ_TOKEN_MISSING", { token: "" });
  assert.equal(m.calls.length, 0);
});
test("oversized responses fail closed without exposing body", async () => {
  const payload = { success: true, result: { items: [], noise: "private-".repeat(40000) } };
  await fails(mockPages([], { badPayload: payload }).fetchImpl, "RESPONSE_TOO_LARGE");
});
test("inventory workflow is isolated, main-pinned, read-only, and has no release action", async () => {
  const yaml = await import("yaml");
  const text = await readFile(".github/workflows/cloudflare-version-inventory.yml", "utf8");
  const doc = yaml.parseDocument(text, { uniqueKeys: true });
  assert.equal(doc.errors.length, 0);
  const flow = doc.toJS();
  assert.ok(flow.on.workflow_dispatch.inputs.expected_main_sha.required);
  assert.deepEqual(flow.permissions, { contents: "read" });
  assert.equal(flow.jobs.inventory.environment, "cloudflare-observability");
  assert.equal(flow.jobs.inventory.permissions.contents, "read");
  assert.equal(flow.concurrency["cancel-in-progress"], false);
  const steps = flow.jobs.inventory.steps;
  assert.equal(steps.filter(s => s.uses?.startsWith("actions/checkout@")).length, 1);
  assert.equal(steps.find(s => s.uses?.startsWith("actions/checkout@")).with.ref,
    "${{ inputs.expected_main_sha }}");
  assert.equal(steps.find(s => s.uses?.startsWith("actions/checkout@")).with["persist-credentials"], false);
  const audit = JSON.stringify(flow);
  assert.ok(audit.includes("CF_PROVENANCE_READ_TOKEN"));
  assert.ok(audit.includes("list-cloudflare-worker-versions.mjs"));
  for (const forbidden of ["wrangler versions upload", "wrangler deploy", "CLOUDFLARE_API_TOKEN", "actions/upload-artifact@"]) {
    assert.ok(!audit.includes(forbidden), forbidden);
  }
});
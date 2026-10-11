import { pathToFileURL } from "node:url";
import path from "node:path";

// Inventory is deliberately restricted to one Worker, GET, and 100 entries maximum.
// No author identities, bindings, script content, account id, or tokens enter output.
const API = "https://api.cloudflare.com/client/v4/accounts/";
const WORKER = "mcp-access-stack";
const ACCOUNT = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const PER_PAGE = 20;
const MAX_PAGES = 5;
const MAX_BODY_BYTES = 256 * 1024;
const SOURCES = new Set(["unknown", "api", "wrangler", "terraform", "dash",
  "cf_cli", "dash_template", "integration", "quick_editor", "playground", "workersci"]);

export class InventoryError extends Error {
  constructor(code) {
    super(code);
    this.name = "InventoryError";
    this.code = code;
  }
}
function fail(code) { throw new InventoryError(code); }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function time(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString() : null;
}
async function boundedJson(response) {
  if (response.status !== 200) fail("CLOUDFLARE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) fail("RESPONSE_STREAM_INVALID");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) fail("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof InventoryError) throw error;
    fail("CLOUDFLARE_NETWORK_FAILED");
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const out = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(out));
  } catch { fail("RESPONSE_JSON_INVALID"); }
}
function parsePage(body, page) {
  if (!record(body) || body.success !== true || !record(body.result) ||
      !Array.isArray(body.result.items) || body.result.items.length > PER_PAGE) {
    fail("RESPONSE_SHAPE_INVALID");
  }
  // Cloudflare's Versions endpoint documents result.items but does not
  // guarantee the optional result_info fields. Validate each field *if*
  // supplied, never trust missing metadata as evidence of completeness.
  const info = body.result_info;
  if (info !== undefined && !record(info)) fail("PAGINATION_SHAPE_INVALID");
  if (info && "page" in info && info.page !== page) {
    fail("PAGINATION_PAGE_MISMATCH");
  }
  if (info && "per_page" in info && info.per_page !== PER_PAGE) {
    fail("PAGINATION_PER_PAGE_MISMATCH");
  }
  if (info && "total_pages" in info &&
      (!Number.isSafeInteger(info.total_pages) || info.total_pages < page)) {
    fail("PAGINATION_TOTAL_PAGES_INVALID");
  }
  if (info && Number.isSafeInteger(info.total_pages) &&
      info.total_pages > page && body.result.items.length === 0) {
    fail("PAGINATION_EMPTY_NONFINAL");
  }
  const items = body.result.items.map(item => {
    if (!record(item) || typeof item.id !== "string" || !UUID.test(item.id)) {
      fail("VERSION_ID_INVALID");
    }
    return {
      id: item.id,
      createdOn: time(item.metadata?.created_on),
      source: SOURCES.has(item.metadata?.source) ? item.metadata.source : "unverified",
    };
  });
  const hasTotalPages = info && Number.isSafeInteger(info.total_pages);
  const hasMore = hasTotalPages
    ? page < info.total_pages : items.length === PER_PAGE;
  const completenessVerified = Boolean(hasTotalPages &&
    info.page === page && info.per_page === PER_PAGE);
  return { items, hasMore, completenessVerified };
}
export async function inventoryWorkerVersions(input, fetchImpl = fetch) {
  if (typeof input?.accountId !== "string" || !ACCOUNT.test(input.accountId)) {
    fail("ACCOUNT_ID_INVALID");
  }
  if (typeof input.token !== "string" || input.token.length < 12) fail("READ_TOKEN_MISSING");
  const prefix = API + input.accountId + "/workers/scripts/" + WORKER + "/versions";
  const seen = new Set();
  const versions = [];
  let pagesRead = 0;
  let hasMore = false;
  let completenessVerified = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = prefix + "?page=" + page + "&per_page=" + PER_PAGE;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: "Bearer " + input.token, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
    } catch { fail("CLOUDFLARE_NETWORK_FAILED"); }
    const parsed = parsePage(await boundedJson(response), page);
    for (const item of parsed.items) {
      if (seen.has(item.id)) fail("DUPLICATE_VERSION_ID");
      seen.add(item.id);
      versions.push(item);
    }
    pagesRead = page;
    hasMore = parsed.hasMore;
    completenessVerified = parsed.completenessVerified;
    if (!hasMore) break;
  }
  return { worker: WORKER, status: hasMore || !completenessVerified ? "bounded_partial" : "complete",
    pagesRead, versions };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await inventoryWorkerVersions({
      accountId: process.env.CF_ACCOUNT_ID,
      token: process.env.CF_PROVENANCE_READ_TOKEN,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error("cloudflare_inventory: " + (error instanceof InventoryError
      ? error.code : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  }
}

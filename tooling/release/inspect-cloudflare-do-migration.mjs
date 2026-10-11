import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4/accounts/";
const WORKER = "mcp-access-stack";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const TAG = /^[a-zA-Z0-9._-]{1,64}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class MigrationInspectionError extends Error {
  constructor(code) {
    super(code);
    this.name = "MigrationInspectionError";
    this.code = code;
  }
}

function fail(code) { throw new MigrationInspectionError(code); }
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function valid(value, re, code) {
  if (typeof value !== "string" || !re.test(value)) fail(code);
  return value;
}

async function jsonWithLimit(response) {
  if (response.status !== 200) fail("CLOUDFLARE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) fail("RESPONSE_STREAM_INVALID");
  let count = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > MAX_RESPONSE_BYTES) fail("RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try {
    const bytes = new Uint8Array(count);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("RESPONSE_JSON_INVALID");
  }
}

function unwrap(response) {
  if (!record(response) || response.success !== true || !record(response.result)) {
    fail("RESPONSE_SHAPE_INVALID");
  }
  return response.result;
}

function activeDeployment(payload) {
  const rows = unwrap(payload).deployments;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100) {
    fail("DEPLOYMENT_LIST_INVALID");
  }
  // Cloudflare documents the first deployment as the one actively serving traffic.
  const current = rows[0];
  if (!record(current) || !UUID.test(current.id) ||
      !Array.isArray(current.versions) || current.versions.length !== 1 ||
      !record(current.versions[0]) || !UUID.test(current.versions[0].version_id) ||
      current.versions[0].percentage !== 100) fail("DEPLOYMENT_TRAFFIC_INVALID");
  return { id: current.id, versionId: current.versions[0].version_id };
}

function versionTag(payload, id) {
  const result = unwrap(payload);
  if (result.id !== id) fail("VERSION_ID_MISMATCH");
  if (!record(result.resources) || !record(result.resources.script)) {
    fail("VERSION_SHAPE_INVALID");
  }
  // Optional API metadata is NOT evidence of a pending migration.
  const tag = result.resources.script.migration_tag;
  if (tag === undefined || tag === null) return null;
  return valid(tag, TAG, "MIGRATION_TAG_INVALID");
}

export async function inspectWorkerDoMigration(input, fetchImpl = fetch) {
  if (!record(input)) fail("INPUT_INVALID");
  const accountId = valid(input.accountId, ACCOUNT, "ACCOUNT_ID_INVALID");
  const expectedDeploymentId = valid(input.expectedDeploymentId, UUID, "DEPLOYMENT_ID_INVALID");
  const expectedVersionId = valid(input.expectedVersionId, UUID, "VERSION_ID_INVALID");
  const expectedTag = valid(input.expectedMigrationTag, TAG, "EXPECTED_TAG_INVALID");
  if (typeof input.token !== "string" || input.token.length < 12) fail("READ_TOKEN_INVALID");

  const prefix = API + accountId + "/workers/scripts/" + WORKER;
  const read = async suffix => {
    let response;
    try {
      response = await fetchImpl(prefix + suffix, {
        method: "GET", headers: {
          authorization: "Bearer " + input.token,
          accept: "application/json",
          "user-agent": "mcp-cloudflare-do-migration-observability",
        }, redirect: "error", signal: AbortSignal.timeout(10000),
      });
    } catch {
      fail("CLOUDFLARE_NETWORK_FAILED");
    }
    return jsonWithLimit(response);
  };
  const first = activeDeployment(await read("/deployments"));
  if (first.id !== expectedDeploymentId || first.versionId !== expectedVersionId) {
    fail("ACTIVE_DEPLOYMENT_CAS_MISMATCH");
  }
  const actualTag = versionTag(await read("/versions/" + expectedVersionId), expectedVersionId);
  const last = activeDeployment(await read("/deployments"));
  if (last.id !== first.id || last.versionId !== first.versionId) {
    fail("DEPLOYMENT_CHANGED_DURING_READ");
  }
  const parity = actualTag === null ? "unverified" :
    actualTag === expectedTag ? "matching" : "different";
  // Never emit the remote tag itself, account, credential or API payload.
  return {
    worker: WORKER,
    activeDeploymentId: first.id,
    activeVersionId: first.versionId,
    migrationTagParity: parity,
    status: parity,
  };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const config = JSON.parse(await readFile(path.join(root,
    "services/mcp-edge-gateway/wrangler.jsonc"), "utf8"));
  const list = config.migrations;
  if (config.name !== WORKER || !Array.isArray(list) || list.length !== 1 ||
      list[0]?.tag !== "v1" ||
      !Array.isArray(list[0]?.new_sqlite_classes) ||
      list[0].new_sqlite_classes.length !== 1 ||
      list[0].new_sqlite_classes[0] !== "McpSession") {
    fail("CANONICAL_MIGRATION_CONFIG_DRIFT");
  }
  console.log(JSON.stringify(await inspectWorkerDoMigration({
    accountId: process.env.CF_ACCOUNT_ID,
    token: process.env.CF_PROVENANCE_READ_TOKEN,
    expectedDeploymentId: process.env.EXPECTED_ACTIVE_DEPLOYMENT_ID,
    expectedVersionId: process.env.EXPECTED_ACTIVE_VERSION_ID,
    expectedMigrationTag: "v1",
  })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error("migration_inspection: " +
      (error instanceof MigrationInspectionError ? error.code : "INSPECTION_UNAVAILABLE"));
    process.exitCode = 1;
  });
}

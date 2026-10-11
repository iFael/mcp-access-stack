import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const WORKER = "mcp-access-stack";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const ACCOUNT = /^[a-f0-9]{32}$/u;
const MAX_BYTES = 256 * 1024;
const WRITE_GROUPS = new Set(["Workers Scripts Write", "Workers Scripts Edit"]);

export class PublisherAuditError extends Error {
  constructor(code) { super(code); this.name = "PublisherAuditError"; this.code = code; }
}
function deny(code) { throw new PublisherAuditError(code); }
function isObject(x) { return x !== null && typeof x === "object" && !Array.isArray(x); }
function required(x, re, code) { if (typeof x !== "string" || !re.test(x)) deny(code); return x; }
function unwrap(x) {
  if (!isObject(x) || x.success !== true || !isObject(x.result)) deny("RESPONSE_INVALID");
  return x.result;
}

async function request(fetchImpl, token, pathname, optional = false) {
  let response;
  try {
    response = await fetchImpl(API + pathname, {
      method: "GET", redirect: "error",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
  } catch { deny("CLOUDFLARE_GET_UNAVAILABLE"); }
  if (optional && [401, 403, 404].includes(response.status)) return null;
  if (response.status !== 200) deny("CLOUDFLARE_GET_FAILED");
  const reader = response.body?.getReader();
  if (!reader) deny("RESPONSE_STREAM_INVALID");
  let count = 0;
  const chunks = [];
  try {
    for (;;) {
      const entry = await reader.read();
      if (entry.done) break;
      count += entry.value.byteLength;
      if (count > MAX_BYTES) deny("RESPONSE_TOO_LARGE");
      chunks.push(entry.value);
    }
  } catch (error) {
    if (error instanceof PublisherAuditError) throw error;
    deny("RESPONSE_STREAM_INVALID");
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(count);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { deny("RESPONSE_JSON_INVALID"); }
}

function active(doc) {
  const rows = unwrap(doc).deployments;
  const first = Array.isArray(rows) ? rows[0] : null;
  if (!isObject(first) || !UUID.test(first.id) || !Array.isArray(first.versions) ||
      first.versions.length !== 1 || !isObject(first.versions[0]) ||
      !UUID.test(first.versions[0].version_id) || first.versions[0].percentage !== 100) {
    deny("ACTIVE_DEPLOYMENT_INVALID");
  }
  return { deploymentId: first.id, versionId: first.versions[0].version_id };
}

function tokenStatus(doc) {
  if (doc === null) return null;
  const t = unwrap(doc);
  if (!ACCOUNT.test(t.id) || !["active", "disabled", "expired"].includes(t.status)) {
    deny("TOKEN_VERIFY_INVALID");
  }
  return t;
}

function policySummary(doc, accountId) {
  if (doc === null) return { visibility: "unverified", writeGroup: "unverified", accountScope: "unverified" };
  const policies = unwrap(doc).policies;
  if (!Array.isArray(policies)) {
    return { visibility: "unverified", writeGroup: "unverified", accountScope: "unverified" };
  }
  const candidates = policies.filter(p => isObject(p) && p.effect === "allow" &&
    Array.isArray(p.permission_groups) &&
    p.permission_groups.some(g => isObject(g) && WRITE_GROUPS.has(g.name)));
  const allAccount = candidates.some(p => isObject(p.resources) &&
    Object.keys(p.resources).some(key => key === "com.cloudflare.api.account." + accountId));
  const denied = policies.some(p => isObject(p) && p.effect === "deny" &&
    Array.isArray(p.permission_groups) &&
    p.permission_groups.some(g => isObject(g) && WRITE_GROUPS.has(g.name)));
  return {
    visibility: "readable",
    writeGroup: candidates.length && !denied ? "present" : "not_observed",
    accountScope: allAccount && !denied ? "target_account_included" : "unverified",
  };
}

function settingsSummary(doc, vars) {
  if (doc === null) return { visibility: "unverified", varsParity: "unverified", secretNameCollision: "unverified" };
  const bindings = unwrap(doc).bindings;
  if (!Array.isArray(bindings) || !bindings.every(b => isObject(b) &&
      typeof b.name === "string" && typeof b.type === "string")) {
    return { visibility: "unverified", varsParity: "unverified", secretNameCollision: "unverified" };
  }
  const known = Object.entries(vars);
  const secretCollision = bindings.some(b => Object.hasOwn(vars, b.name) && b.type === "secret_text");
  const matching = known.every(([name, value]) => bindings.some(b =>
    b.name === name && b.type === "plain_text" && b.text === value));
  return {
    visibility: "readable",
    varsParity: matching ? "matching" : "different",
    secretNameCollision: secretCollision ? "present" : "not_observed",
  };
}

export async function inspectPublisherReadOnly(input, fetchImpl = fetch) {
  if (!isObject(input)) deny("INPUT_INVALID");
  const accountId = required(input.accountId, ACCOUNT, "ACCOUNT_INVALID");
  const deploymentId = required(input.deploymentId, UUID, "DEPLOYMENT_INVALID");
  const versionId = required(input.versionId, UUID, "VERSION_INVALID");
  if (typeof input.token !== "string" || input.token.length < 12) deny("TOKEN_UNAVAILABLE");
  if (!isObject(input.vars) || !Object.entries(input.vars).every(([k, v]) =>
      /^[A-Z][A-Z0-9_]{0,80}$/u.test(k) && typeof v === "string")) deny("VARS_INVALID");

  const get = (p, optional = false) => request(fetchImpl, input.token, p, optional);
  const before = active(await get("/accounts/" + accountId + "/workers/scripts/" + WORKER + "/deployments"));
  if (before.deploymentId !== deploymentId || before.versionId !== versionId) deny("ACTIVE_CAS_MISMATCH");

  // Token ownership is not assumed. No token IDs, policies, or raw responses are logged.
  const a = tokenStatus(await get("/accounts/" + accountId + "/tokens/verify", true));
  const u = tokenStatus(await get("/user/tokens/verify", true));
  const scope = a && !u ? "account" : u && !a ? "user" : "unverified";
  const verified = scope === "account" ? a : scope === "user" ? u : null;
  const tokenState = verified?.status ?? "unverified";
  const detailPath = scope === "account"
    ? "/accounts/" + accountId + "/tokens/" + verified.id
    : scope === "user" ? "/user/tokens/" + verified.id : null;
  const policy = policySummary(detailPath ? await get(detailPath, true) : null, accountId);

  const service = await get("/accounts/" + accountId + "/workers/services/" + WORKER, true);
  let serviceTag = "unverified";
  if (service !== null) {
    const tag = unwrap(service).default_environment?.script?.migration_tag;
    if (typeof tag === "string") serviceTag = tag === "v1" ? "matching" : "different";
  }
  const settings = settingsSummary(
    await get("/accounts/" + accountId + "/workers/scripts/" + WORKER + "/settings", true),
    input.vars);
  const after = active(await get("/accounts/" + accountId + "/workers/scripts/" + WORKER + "/deployments"));
  if (after.deploymentId !== before.deploymentId || after.versionId !== before.versionId) {
    deny("ACTIVE_DEPLOYMENT_CHANGED");
  }
  return {
    worker: WORKER, activeDeploymentId: before.deploymentId, activeVersionId: before.versionId,
    tokenOwnership: scope, tokenStatus: tokenState,
    tokenPolicyReadability: policy.visibility, writePolicyGroup: policy.writeGroup,
    writePolicyAccountScope: policy.accountScope,
    publisherWriteScope: "unverified", // Even policy visibility is not an effective write authorization test.
    serviceMigrationTagParity: serviceTag,
    remoteSettingsReadability: settings.visibility,
    remotePlainVarsParity: settings.varsParity,
    remoteSecretNameCollision: settings.secretNameCollision,
    inspection: "get_only",
  };
}

async function main() {
  const root = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const config = JSON.parse(await readFile(path.join(root, "services/mcp-edge-gateway/wrangler.jsonc"), "utf8"));
  if (config.name !== WORKER || config.migrations?.length !== 1 ||
      config.migrations[0].tag !== "v1") deny("CANONICAL_CONFIG_INVALID");
  const report = await inspectPublisherReadOnly({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    deploymentId: process.env.EXPECTED_ACTIVE_DEPLOYMENT_ID,
    versionId: process.env.EXPECTED_ACTIVE_VERSION_ID,
    vars: config.vars,
  });
  console.log(JSON.stringify(report));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => {
    console.error("publisher_audit: " +
      (e instanceof PublisherAuditError ? e.code : "AUDIT_UNAVAILABLE"));
    process.exitCode = 1;
  });
}

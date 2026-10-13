import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";
import { inspectPublisherReadOnly } from "./inspect-cloudflare-publisher-policy.mjs";
import { validateActiveProvenance, readUploadedVersionId, verifyUploadedVersion } from "./stage-edge-beta84-bridge-guard.mjs";
import { classifyUploadLogFile } from "./diagnose-edge-beta84-stage-upload.mjs";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HEX32 = /^[a-f0-9]{32}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const WORKER = "mcp-access-stack";
const LOG = "edge-cas-candidate-upload.log";
const BASELINE = "edge-cas-candidate-stage-baseline.json";
const SECRET_FILE = "edge-cas-candidate-secrets.json";
const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

function deny(code) { throw new Error("EDGE_CAS_STAGE_" + code); }
export function verifyLocalCandidate(config, source, expectedRevision) {
  if (!REVISION.test(expectedRevision) ||
      config?.name !== WORKER || config?.main !== "src/index.ts" ||
      config?.workers_dev !== true || config?.alias !== undefined ||
      config?.routes !== undefined || config?.route !== undefined ||
      config?.durable_objects?.bindings?.length !== 1 ||
      config.durable_objects.bindings[0]?.name !== "MCP_SESSION" ||
      config.durable_objects.bindings[0]?.class_name !== "McpSession" ||
      config?.migrations?.length !== 1 ||
      config.migrations[0]?.tag !== "v1" ||
      JSON.stringify(config.migrations[0]?.new_sqlite_classes) !== '["McpSession"]' ||
      JSON.stringify(config?.secrets?.required) !== '["MCP_CONTRACT_PREPARE_TOKEN"]') {
    deny("CONFIG_DRIFT");
  }
  const match = /"contractRevision":\s*"([a-f0-9]{64})"/u.exec(source);
  if (!match || match[1] !== expectedRevision ||
      !/"toolCount":\s*99\b/u.test(source)) deny("BUILD_CONTRACT_MISMATCH");
  return expectedRevision;
}
export function requirePublisherPrerequisites(report, expectedDeployment, expectedVersion, options = {}) {
  const requiredPresence = report?.remoteRequiredSecretsPresence;
  const secretAcceptable = requiredPresence === "present" ||
    (options.bundledSecret === true && requiredPresence === "not_observed");
  if (report?.worker !== WORKER ||
      report?.activeDeploymentId !== expectedDeployment ||
      report?.activeVersionId !== expectedVersion ||
      report?.tokenStatus !== "active" ||
      report?.remoteSettingsReadability !== "readable" ||
      report?.remotePlainVarsParity !== "matching" ||
      report?.serviceMigrationTagParity !== "matching" ||
      !secretAcceptable ||
      report?.remoteSecretNameCollision !== "not_observed") {
    deny("PUBLISHER_PRECONDITION_UNVERIFIED");
  }
  // GET-only token introspection cannot prove effective WRITE access.
  return true;
}
export async function writeStageSecretFile(rawSecret, runnerTemp) {
  // The GH environment secret is injected only into the upload step; no output
  // includes the secret, and this path is outside the checkout/artifacts.
  if (typeof rawSecret !== "string" ||
      !/^[A-Za-z0-9+/_=-]{43,256}$/u.test(rawSecret) ||
      typeof runnerTemp !== "string" || !path.isAbsolute(runnerTemp)) {
    deny("SECRET_INVALID");
  }
  const filepath = path.join(runnerTemp, SECRET_FILE);
  await writeFile(filepath, JSON.stringify({
    MCP_CONTRACT_PREPARE_TOKEN: rawSecret,
  }), { flag: "wx", mode: 0o600 });
  return filepath;
}

export function verifyVersionSecretBinding(payload) {
  // Cloudflare Workers Version details can expose bindings as an object keyed
  // by name OR an array of descriptors. Never inspect or return secret values.
  const bindings = payload?.result?.resources?.bindings;
  const required = "MCP_CONTRACT_PREPARE_TOKEN";
  if (Array.isArray(bindings)) {
    if (!bindings.every(item => item && typeof item === "object" &&
        !Array.isArray(item) && typeof item.name === "string" &&
        typeof item.type === "string")) {
      deny("VERSION_SECRET_UNVERIFIED");
    }
    const matches = bindings.filter(item => item.name === required);
    if (matches.length !== 1 || matches[0].type !== "secret_text") {
      deny("VERSION_SECRET_UNVERIFIED");
    }
    return true;
  }
  if (!bindings || typeof bindings !== "object" ||
      !Object.hasOwn(bindings, required) ||
      bindings[required]?.type !== "secret_text") {
    deny("VERSION_SECRET_UNVERIFIED");
  }
  return true;
}

export function verifyNoTrafficChange(before, after) {
  if (before?.deploymentId !== after?.deploymentId ||
      before?.activeVersionId !== after?.activeVersionId) deny("ACTIVE_CAS_CHANGED");
  return true;
}
export function parseInput(mode, env) {
  if (!["preflight", "before", "after", "diagnose", "secret-file"].includes(mode)) deny("MODE_INVALID");
  if (!HEX32.test(env.CLOUDFLARE_ACCOUNT_ID ?? "") ||
      !UUID.test(env.EXPECTED_ACTIVE_DEPLOYMENT_ID ?? "") ||
      !UUID.test(env.EXPECTED_ACTIVE_VERSION_ID ?? "") ||
      !REVISION.test(env.EXPECTED_CONTRACT_REVISION ?? "") ||
      typeof env.RUNNER_TEMP !== "string" || !path.isAbsolute(env.RUNNER_TEMP)) deny("INPUT_INVALID");
  if (mode !== "preflight" && mode !== "diagnose" &&
      (typeof env.CLOUDFLARE_API_TOKEN !== "string" || env.CLOUDFLARE_API_TOKEN.length < 12)) {
    deny("READ_CREDENTIAL_UNAVAILABLE");
  }
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID, token: env.CLOUDFLARE_API_TOKEN,
    expectedDeployment: env.EXPECTED_ACTIVE_DEPLOYMENT_ID,
    expectedVersion: env.EXPECTED_ACTIVE_VERSION_ID,
    expectedRevision: env.EXPECTED_CONTRACT_REVISION,
    temp: env.RUNNER_TEMP,
  };
}
async function validateLocal(expectedRevision) {
  const config = JSON.parse(await readFile(path.join(ROOT, "services/mcp-edge-gateway/wrangler.jsonc"), "utf8"));
  const manifest = await readFile(path.join(ROOT, "services/mcp-edge-gateway/src/generated/mcp-tool-manifest.ts"), "utf8");
  verifyLocalCandidate(config, manifest, expectedRevision);
  return config;
}
async function activeSnapshot(input) {
  const comparison = await compareWorkerVersions({
    accountId: input.accountId, token: input.token,
    referenceVersionId: input.expectedVersion,
  });
  return validateActiveProvenance(comparison, input.expectedDeployment, input.expectedVersion);
}
async function immutableVersion(input, id) {
  const response = await fetch(
    "https://api.cloudflare.com/client/v4/accounts/" + input.accountId +
    "/workers/scripts/" + WORKER + "/versions/" + id, {
      method: "GET", headers: {
        authorization: "Bearer " + input.token, accept: "application/json",
      }, redirect: "error", signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status !== 200) deny("VERSION_LOOKUP_FAILED");
  const raw = await response.text();
  if (raw.length > 262144) deny("VERSION_RESPONSE_TOO_LARGE");
  const payload = JSON.parse(raw);
  verifyUploadedVersion(payload, id);
  verifyVersionSecretBinding(payload);
  return id;
}
async function main() {
  const mode = process.argv[2];
  if (process.argv.length !== 3) deny("MODE_INVALID");
  const input = parseInput(mode, process.env);
  if (mode === "diagnose") {
    const reason = await classifyUploadLogFile(path.join(input.temp, LOG));
    console.log("EDGE_CAS_STAGE_UPLOAD_DIAGNOSTIC " + reason + "; outcome_unknown; DO_NOT_RETRY");
    return;
  }
  const config = await validateLocal(input.expectedRevision);
  if (mode === "secret-file") {
    await writeStageSecretFile(process.env.MCP_CONTRACT_PREPARE_TOKEN, input.temp);
    console.log("EDGE_CAS_STAGE_PROTECTED_SECRET_FILE_READY");
    return;
  }
  if (mode === "preflight") {
    console.log("EDGE_CAS_STAGE_LOCAL_CONTRACT_VERIFIED");
    return;
  }
  if (mode === "before") {
    const first = await activeSnapshot(input);
    const report = await inspectPublisherReadOnly({
      accountId: input.accountId, token: input.token,
      deploymentId: input.expectedDeployment, versionId: input.expectedVersion,
      vars: config.vars, requiredSecrets: config.secrets.required,
    });
    requirePublisherPrerequisites(report, input.expectedDeployment, input.expectedVersion, { bundledSecret: true });
    const second = await activeSnapshot(input);
    verifyNoTrafficChange(first, second);
    await writeFile(path.join(input.temp, BASELINE), JSON.stringify({
      ...first, revision: input.expectedRevision,
    }), { flag: "wx", mode: 0o600 });
    console.log("EDGE_CAS_STAGE_SAFE_BASELINE_VERIFIED");
    return;
  }
  const baseline = JSON.parse(await readFile(path.join(input.temp, BASELINE), "utf8"));
  if (baseline.revision !== input.expectedRevision ||
      baseline.deploymentId !== input.expectedDeployment ||
      baseline.activeVersionId !== input.expectedVersion) deny("BASELINE_MISMATCH");
  const uploadLog = await readFile(path.join(input.temp, LOG), "utf8");
  const uploaded = readUploadedVersionId(uploadLog, input.expectedVersion);
  await immutableVersion(input, uploaded);
  verifyNoTrafficChange(baseline, await activeSnapshot(input));
  if (!process.env.GITHUB_OUTPUT) deny("OUTPUT_UNAVAILABLE");
  await appendFile(process.env.GITHUB_OUTPUT, "version_id=" + uploaded + "\n", "utf8");
  console.log("EDGE_CAS_STAGE_UPLOADED_NO_TRAFFIC version_id=" + uploaded);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Preserve only allowlisted classification codes; never print Cloudflare replies or credentials.
    const message = typeof error?.message === "string" && /^EDGE_CAS_STAGE_[A-Z_]+$/u.test(error.message)
      ? error.message : "EDGE_CAS_STAGE_UNAVAILABLE";
    console.error(message);
    process.exitCode = 1;
  });
}

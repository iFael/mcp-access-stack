import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareWorkerVersions } from "./compare-cloudflare-worker-versions.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const HEX32 = /^[a-f0-9]{32}$/u;
const SCRIPT = "mcp-access-stack";

export function validateActiveProvenance(result, expectedDeploymentId, expectedVersionId) {
  if (!UUID.test(expectedDeploymentId) || !UUID.test(expectedVersionId) ||
      result?.worker !== SCRIPT || result.activeDeploymentId !== expectedDeploymentId ||
      result.activeVersionId !== expectedVersionId ||
      result.referenceVersionId !== expectedVersionId ||
      result.status !== "matching_script" || result.scriptEtagEqual !== true ||
      !["matching", "unverified"].includes(result.runtimeMetadataParity) ||
      !["matching", "unverified"].includes(result.bindingMetadataParity)) {
    throw Error("EDGE_STAGE_ACTIVE_PROVENANCE_MISMATCH");
  }
  return { deploymentId: expectedDeploymentId, activeVersionId: expectedVersionId };
}

export function readUploadedVersionId(log, previousVersionId) {
  const pattern = /\b(?:Worker\s+)?Version\s+ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/giu;
  const ids = [...String(log).matchAll(pattern)].map(match => match[1].toLowerCase());
  if (ids.length !== 1 || !UUID.test(ids[0]) || ids[0] === previousVersionId) {
    throw Error("EDGE_STAGE_VERSION_ID_UNVERIFIED");
  }
  return ids[0];
}

export function verifyUploadedVersion(payload, versionId) {
  if (payload?.success !== true || payload.result?.id !== versionId ||
      !/^[a-f0-9]{16,128}$/iu.test(payload.result?.resources?.script?.etag ?? "")) {
    throw Error("EDGE_STAGE_UPLOADED_VERSION_UNVERIFIED");
  }
  return versionId;
}

async function verifyImmutableVersion(accountId, token, versionId, fetchImpl = fetch) {
  const url = "https://api.cloudflare.com/client/v4/accounts/" + accountId +
    "/workers/scripts/" + SCRIPT + "/versions/" + versionId;
  const response = await fetchImpl(url, {
    method: "GET", headers: {
      authorization: "Bearer " + token,
      accept: "application/json",
    }, redirect: "error", signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200) throw Error("EDGE_STAGE_VERSION_LOOKUP_FAILED");
  const body = await response.text();
  if (body.length > 262144) throw Error("EDGE_STAGE_VERSION_RESPONSE_TOO_LARGE");
  return verifyUploadedVersion(JSON.parse(body), versionId);
}

async function main() {
  const mode = process.argv[2];
  if (!["before", "after"].includes(mode) || process.argv.length !== 3) {
    throw Error("EDGE_STAGE_MODE_INVALID");
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
  const deployment = process.env.EXPECTED_ACTIVE_DEPLOYMENT_ID ?? "";
  const version = process.env.EXPECTED_ACTIVE_VERSION_ID ?? "";
  const runnerTemp = process.env.RUNNER_TEMP ?? "";
  if (!HEX32.test(accountId) || token.length < 12 ||
      !UUID.test(deployment) || !UUID.test(version) || !path.isAbsolute(runnerTemp)) {
    throw Error("EDGE_STAGE_INPUT_INVALID");
  }
  const snapshotFile = path.join(runnerTemp, "edge-beta84-stage-baseline.json");
  const compare = () => compareWorkerVersions({
    accountId, token, referenceVersionId: version,
  });
  const current = validateActiveProvenance(await compare(), deployment, version);
  if (mode === "before") {
    // No overwrite: a repeated attempt is never a new authorization to stage.
    await writeFile(snapshotFile, JSON.stringify(current), { flag: "wx", mode: 0o600 });
    console.log("EDGE_STAGE_BASELINE_VERIFIED");
    return;
  }
  const saved = JSON.parse(await readFile(snapshotFile, "utf8"));
  if (saved.deploymentId !== deployment || saved.activeVersionId !== version) {
    throw Error("EDGE_STAGE_BASELINE_CHANGED");
  }
  const uploadLog = await readFile(path.join(runnerTemp, "edge-beta84-stage-upload.log"), "utf8");
  const uploadedVersionId = readUploadedVersionId(uploadLog, version);
  await verifyImmutableVersion(accountId, token, uploadedVersionId);
  // Recheck the exact ACTIVE deployment after verifying the uploaded immutable version.
  validateActiveProvenance(await compare(), deployment, version);
  if (!process.env.GITHUB_OUTPUT) throw Error("EDGE_STAGE_GITHUB_OUTPUT_UNAVAILABLE");
  await appendFile(process.env.GITHUB_OUTPUT, "version_id=" + uploadedVersionId + "\n", "utf8");
  console.log("EDGE_STAGE_VERSION_UPLOADED_WITHOUT_TRAFFIC_CHANGE " + uploadedVersionId);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Never emit Cloudflare responses, CLI logs or credentials to public CI logs.
    console.error("EDGE_STAGE_REFUSED " +
      (typeof error?.message === "string" && /^EDGE_STAGE_[A-Z_]+$/u.test(error.message)
        ? error.message : "UNEXPECTED_ERROR"));
    process.exitCode = 1;
  });
}

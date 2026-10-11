import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const MAX_ARCHIVE = 300_000_000;
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const POSITIVE = /^[1-9][0-9]*$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export function identity(input) {
  if (!REPOSITORY.test(input.repository) || !SHA.test(input.sourceSha) ||
      !POSITIVE.test(input.ciRunId) || !POSITIVE.test(input.distributionRunId) ||
      !HASH.test(input.expectedArchiveSha256)) throw Error("INVALID_PINNED_IDENTITY");
  const releaseId = "1.1.0-companion." + input.ciRunId;
  return {
    ...input,
    releaseId,
    tag: "v" + releaseId,
    artifactName: "windows-companion-" + releaseId + "-" + input.sourceSha,
    zipName: "v" + releaseId + "-windows-x64.zip",
  };
}

export function validateRuns(ci, distribution, ref, input) {
  const matches = (run, event, name) =>
    run?.repository?.full_name?.toLowerCase() === input.repository.toLowerCase() &&
    run?.status === "completed" && run?.conclusion === "success" &&
    run?.event === event && run?.name === name &&
    run?.head_branch === "main" && run?.head_sha === input.sourceSha;
  if (ref?.object?.sha !== input.sourceSha ||
      !matches(ci, "push", "CI") ||
      !matches(distribution, "workflow_run", "Windows companion-only signed distribution")) {
    throw Error("SOURCE_CI_DISTRIBUTION_OR_MAIN_MISMATCH");
  }
}

export function findArtifact(list, input) {
  if (!Number.isSafeInteger(list?.total_count) || list.total_count > 100 ||
      !Array.isArray(list.artifacts)) throw Error("ARTIFACT_LIST_UNBOUNDED");
  const matching = list.artifacts.filter(item => item?.name === input.artifactName &&
    !item.expired && item?.workflow_run?.id === Number(input.distributionRunId) &&
    item?.workflow_run?.head_sha === input.sourceSha);
  if (matching.length !== 1 || !Number.isSafeInteger(matching[0].id) ||
      matching[0].digest !== "sha256:" + input.expectedArchiveSha256 ||
      !Number.isSafeInteger(matching[0].size_in_bytes) ||
      matching[0].size_in_bytes <= 0 || matching[0].size_in_bytes > MAX_ARCHIVE) {
    throw Error("ARTIFACT_IDENTITY_OR_DIGEST_MISMATCH");
  }
  return matching[0];
}

export function verifyRedirect(location) {
  if (!location) throw Error("MISSING_ARTIFACT_REDIRECT");
  let url;
  try { url = new URL(location); } catch { throw Error("INVALID_ARTIFACT_REDIRECT"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !(host === "objects.githubusercontent.com" ||
        /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(host) ||
        /^[a-z0-9-]+\.actions\.githubusercontent\.com$/u.test(host))) {
    throw Error("UNTRUSTED_ARTIFACT_REDIRECT");
  }
  return url.href;
}

async function json(fetchImpl, url, token) {
  const r = await fetchImpl(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28" },
    redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw Error("GITHUB_API_FAILED_" + r.status);
  const data = await r.text();
  if (Buffer.byteLength(data) > 1_000_000) throw Error("API_METADATA_TOO_LARGE");
  return JSON.parse(data);
}

export async function materialize(input, { token, directory, fetchImpl = fetch }) {
  const pin = identity(input);
  if (!token || !directory) throw Error("MISSING_WORKFLOW_CONTEXT");
  const api = "https://api.github.com/repos/" + pin.repository;
  const [ci, distribution, ref, list] = await Promise.all([
    json(fetchImpl, api + "/actions/runs/" + pin.ciRunId, token),
    json(fetchImpl, api + "/actions/runs/" + pin.distributionRunId, token),
    json(fetchImpl, api + "/git/ref/heads/main", token),
    json(fetchImpl, api + "/actions/runs/" + pin.distributionRunId + "/artifacts?per_page=100", token),
  ]);
  validateRuns(ci, distribution, ref, pin);
  const artifact = findArtifact(list, pin);
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "outer-actions-artifact.zip");
  // The runner temporary directory is owned by this single job; never overwrite on replay.
  const handle = await open(archive, "wx", 0o600);
  await handle.close();
  try {
    const response = await fetchImpl(api + "/actions/artifacts/" + artifact.id + "/zip", {
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
      redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
    if (response.status !== 302) throw Error("GITHUB_ARTIFACT_REDIRECT_MISSING");
    const destination = verifyRedirect(response.headers.get("location"));
    await response.body?.cancel();
    // Intentionally never forward the GitHub bearer to the signed storage redirect.
    const archiveResponse = await fetchImpl(destination, { redirect: "error",
      signal: AbortSignal.timeout(180_000) });
    if (!archiveResponse.ok || !archiveResponse.body) throw Error("ARCHIVE_FETCH_FAILED");
    const declared = Number(archiveResponse.headers.get("content-length") || "0");
    if (!Number.isFinite(declared) || declared > MAX_ARCHIVE) throw Error("ARCHIVE_TOO_LARGE");
    let size = 0;
    const hash = createHash("sha256");
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > MAX_ARCHIVE) return callback(Error("ARCHIVE_TOO_LARGE"));
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(archiveResponse.body), counter,
      createWriteStream(archive, { flags: "w" }));
    if (size !== artifact.size_in_bytes ||
        hash.digest("hex") !== pin.expectedArchiveSha256) throw Error("ARCHIVE_DIGEST_MISMATCH");
    return { archive, releaseId: pin.releaseId, tag: pin.tag, zipName: pin.zipName,
      sourceSha: pin.sourceSha, ciRunId: pin.ciRunId, distributionRunId: pin.distributionRunId };
  } catch (error) {
    await rm(archive, { force: true }).catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pin = await materialize({
      repository: process.env.GITHUB_REPOSITORY,
      sourceSha: process.env.EXPECTED_SOURCE_SHA,
      ciRunId: process.env.CI_RUN_ID,
      distributionRunId: process.env.DISTRIBUTION_RUN_ID,
      expectedArchiveSha256: process.env.EXPECTED_ARTIFACT_SHA256,
    }, { token: process.env.GH_TOKEN, directory: process.env.ARTIFACT_OUTPUT_DIR });
    if (process.env.GITHUB_OUTPUT) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(process.env.GITHUB_OUTPUT, [
        "release_id=" + pin.releaseId, "release_tag=" + pin.tag,
        "zip_name=" + pin.zipName, "source_sha=" + pin.sourceSha,
      ].join("\n") + "\n");
    }
    console.log("Actions archive provenance and outer SHA-256 verified.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "ARTIFACT_VERIFICATION_FAILED");
    process.exitCode = 1;
  }
}

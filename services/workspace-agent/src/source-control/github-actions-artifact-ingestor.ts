import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, type OperationContext } from "@vs-code-gpt/shared";
import type { GitHubCredentialProvider } from "./github-credential-provider.js";

const API = "https://api.github.com";
const MAX_METADATA_BYTES = 1_000_000;
const MAX_ARCHIVE_BYTES = 300_000_000;
const EXPECTED_WORKFLOW = "Windows companion-only signed distribution";
const actionArtifactPattern = /^windows-companion-[0-9]+\.[0-9]+\.[0-9]+-companion\.[0-9]+-[a-f0-9]{40}$/u;

export interface ActionsArtifactRequest {
  owner: string;
  repository: string;
  runId: number;
  artifactName: string;
  expectedCommitSha: string;
  expectedArtifactSha256: string;
}

export interface MaterializedActionsArtifact {
  status: "materialized" | "already_materialized";
  runId: number;
  commitSha: string;
  artifactName: string;
  archivePath: string;
  archiveSha256: string;
  sizeBytes: number;
  /** Outer Actions archive only. The signed inner ZIP must be verified before staging. */
  validation: "actions_archive_sha256_verified";
}

export interface GitHubActionsArtifactIngestorOptions {
  credentialProvider: GitHubCredentialProvider;
  fetchImpl?: typeof fetch;
}

export class GitHubActionsArtifactIngestor {
  private readonly credentialProvider: GitHubCredentialProvider;
  private readonly fetchImpl: typeof fetch;
  constructor(options: GitHubActionsArtifactIngestorOptions) {
    this.credentialProvider = options.credentialProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async materialize(
    input: ActionsArtifactRequest,
    workspaceRoot: string,
    context: OperationContext = {},
  ): Promise<MaterializedActionsArtifact> {
    if (!Number.isSafeInteger(input.runId) || input.runId <= 0 ||
      !/^[a-f0-9]{40}$/u.test(input.expectedCommitSha) ||
      !/^[a-f0-9]{64}$/u.test(input.expectedArtifactSha256) ||
      !actionArtifactPattern.test(input.artifactName) ||
      !input.artifactName.endsWith("-" + input.expectedCommitSha) ||
      !/^[A-Za-z0-9-]{1,100}$/u.test(input.owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(input.repository)) {
      throw new AppError("INVALID_ARGUMENT", "Invalid pinned GitHub Actions artifact identity.");
    }

    const root = await realpath(workspaceRoot);
    const base = path.join(root, ".runtime-tools", "github-actions-artifacts");
    await assertNoReparseAncestors(root, base);
    await mkdir(base, { recursive: true });
    await assertNoReparseAncestors(root, base);
    const directory = path.join(base, String(input.runId));
    await assertNoReparseAncestors(root, directory);
    await mkdir(directory, { recursive: true });
    await assertNoReparseAncestors(root, directory);
    const archivePath = path.join(directory, input.artifactName + ".zip");
    const lockPath = archivePath + ".lock";
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch {
      throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Artifact materialization already in progress or requires reconciliation.");
    }
    const tmpPath = archivePath + ".partial";
    let ownsPartial = false;
    try {
      if (await exists(tmpPath)) {
        throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "A prior partial artifact requires reconciliation.");
      }
      // Validate the run and artifact BEFORE any network-controlled bytes are written.
      const credential = await this.credentialProvider.getCredential(context);
      const authHeaders = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Authorization": "Bearer " + credential.token,
      };
      const prefix = API + "/repos/" + encodeURIComponent(input.owner) + "/" + encodeURIComponent(input.repository);
      const run = await readJson(this.fetchImpl, prefix + "/actions/runs/" + input.runId, authHeaders, context.signal);
      if (run?.status !== "completed" || run?.conclusion !== "success" ||
        run?.event !== "workflow_run" || run?.name !== EXPECTED_WORKFLOW ||
        run?.head_sha !== input.expectedCommitSha || run?.head_branch !== "main" ||
        run?.repository?.full_name?.toLowerCase() !== (input.owner + "/" + input.repository).toLowerCase()) {
        throw new AppError("INVALID_ARGUMENT", "Actions run does not match the pinned successful main distribution.");
      }
      const page = await readJson(this.fetchImpl, prefix + "/actions/runs/" + input.runId + "/artifacts?per_page=100", authHeaders, context.signal);
      if (!Number.isSafeInteger(page?.total_count) || page.total_count > 100 || !Array.isArray(page.artifacts)) {
        throw new AppError("LIMIT_EXCEEDED", "Actions artifact listing is incomplete.");
      }
      const matches = page.artifacts.filter((item: any) => item?.name === input.artifactName && !item?.expired);
      if (matches.length !== 1 || !Number.isSafeInteger(matches[0].id) ||
        matches[0].digest !== "sha256:" + input.expectedArtifactSha256) {
        throw new AppError("INVALID_ARGUMENT", "Actions artifact identity or GitHub digest mismatched.");
      }
      // Even a completed local file is trusted only after rechecking GitHub provenance.
      const existing = await existingArchive(archivePath, input.expectedArtifactSha256);
      if (existing !== undefined) {
        return this.makeResult(input, archivePath, existing.size, "already_materialized");
      }

      const target = prefix + "/actions/artifacts/" + matches[0].id + "/zip";
      const redirectResponse = await this.fetchImpl(target, {
        method: "GET", headers: authHeaders, redirect: "manual",
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (redirectResponse.status !== 302) {
        await redirectResponse.body?.cancel();
        throw new AppError("AGENT_UNAVAILABLE", "Expected GitHub artifact redirect was unavailable.");
      }
      const location = redirectResponse.headers.get("location");
      await redirectResponse.body?.cancel();
      const url = checkSignedArtifactRedirect(location);
      // Do not send GitHub authorization or follow unbounded external redirects.
      const result = await this.fetchImpl(url, { method: "GET", redirect: "error",
        ...(context.signal === undefined ? {} : { signal: context.signal }) });
      if (!result.ok || !result.body) {
        await result.body?.cancel();
        throw new AppError("AGENT_UNAVAILABLE", "Signed Actions download was unavailable.");
      }
      const declaredLength = Number(result.headers.get("content-length") || "0");
      if (!Number.isFinite(declaredLength) || declaredLength > MAX_ARCHIVE_BYTES) {
        await result.body.cancel();
        throw new AppError("LIMIT_EXCEEDED", "Actions archive exceeded the maximum size.");
      }
      const hash = createHash("sha256");
      let size = 0;
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_ARCHIVE_BYTES) {
            callback(new AppError("LIMIT_EXCEEDED", "Actions archive exceeded the maximum size."));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      ownsPartial = true;
      await pipeline(Readable.fromWeb(result.body as never), verifier, createWriteStream(tmpPath, { flags: "wx", mode: 0o600 }), { signal: context.signal });
      if (hash.digest("hex") !== input.expectedArtifactSha256) {
        throw new AppError("INVALID_ARGUMENT", "Downloaded Actions archive failed pinned SHA-256 verification.");
      }
      // Fail closed if another writer materialized the same identity concurrently.
      if (await exists(archivePath)) throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Actions artifact destination changed during transfer.");
      // Atomic no-overwrite publication prevents replacing a concurrent result.
      try { await link(tmpPath, archivePath); }
      catch { throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Actions artifact cannot be atomically materialized."); }
      return this.makeResult(input, archivePath, size, "materialized");
    } finally {
      if (ownsPartial) await rm(tmpPath, { force: true }).catch(() => undefined);
      await lock.close();
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private makeResult(input: ActionsArtifactRequest, archivePath: string, sizeBytes: number, status: MaterializedActionsArtifact["status"]): MaterializedActionsArtifact {
    return {
      status, runId: input.runId, commitSha: input.expectedCommitSha,
      artifactName: input.artifactName, archivePath,
      archiveSha256: input.expectedArtifactSha256, sizeBytes,
      validation: "actions_archive_sha256_verified",
    };
  }
}

async function exists(filename: string): Promise<boolean> {
  try { await lstat(filename); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function existingArchive(filename: string, expectedHash: string): Promise<{ size: number } | undefined> {
  if (!await exists(filename)) return undefined;
  const metadata = await lstat(filename);
  if (!metadata.isFile() || metadata.size > MAX_ARCHIVE_BYTES) {
    throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Existing Actions archive is not a bounded regular file.");
  }
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filename)) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) {
      throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Existing Actions archive exceeds the size cap.");
    }
    hash.update(chunk);
  }
  if (hash.digest("hex") !== expectedHash) {
    throw new AppError("SOURCE_CONTROL_RECONCILIATION_REQUIRED", "Existing Actions archive does not match pinned digest.");
  }
  return { size };
}

async function assertNoReparseAncestors(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError("PATH_OUTSIDE_WORKSPACE", "Actions archive would escape its trusted workspace.");
  }
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AppError("BLOCKED_PATH", "Actions archive parent is not a trusted directory.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function checkSignedArtifactRedirect(location: string | null): string {
  if (!location) throw new AppError("INVALID_ARGUMENT", "GitHub did not supply an artifact redirect.");
  let url: URL;
  try { url = new URL(location); } catch { throw new AppError("INVALID_ARGUMENT", "Invalid GitHub artifact redirect."); }
  const host = url.hostname.toLowerCase();
  const trustedHost = host === "objects.githubusercontent.com" ||
    /^productionresultssa[0-9]+\.blob\.core\.windows\.net$/u.test(host) ||
    /^[a-z0-9-]+\.actions\.githubusercontent\.com$/u.test(host);
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password || url.port || url.hash) {
    throw new AppError("INVALID_ARGUMENT", "GitHub artifact redirect was outside the fixed trusted hosts.");
  }
  return url.toString();
}

async function readJson(fetchImpl: typeof fetch, url: string, headers: Record<string,string>, signal?: AbortSignal): Promise<any> {
  const response = await fetchImpl(url, { method: "GET", headers, redirect: "error",
    ...(signal === undefined ? {} : { signal }) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new AppError(response.status === 401 || response.status === 403 ? "AUTHENTICATION_FAILED" : "AGENT_UNAVAILABLE", "GitHub Actions metadata was unavailable.");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytes += value.byteLength;
      if (bytes > MAX_METADATA_BYTES) throw new AppError("LIMIT_EXCEEDED", "GitHub Actions metadata exceeded the size limit.");
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts.map(x => Buffer.from(x))).toString("utf8")); }
  catch { throw new AppError("INVALID_ARGUMENT", "Malformed GitHub Actions metadata."); }
}

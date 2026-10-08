import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { GitHubCredentialProvider } from "../../../src/source-control/github-credential-provider.js";
import { GitHubActionsArtifactIngestor } from "../../../src/source-control/github-actions-artifact-ingestor.js";

const sha = "a".repeat(40);
const runId = 37777047603;
const artifactName = "windows-companion-1.1.0-companion.37776640817-" + sha;
const payload = Buffer.from("test-archive-content-not-an-installable-zip");
const digest = createHash("sha256").update(payload).digest("hex");
const provider: GitHubCredentialProvider = {
  async getCredential() { return { source: "gh-cli-user", token: "secret-test-credential" }; },
};
const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-actions-artifact-"));
  roots.push(root);
  return root;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200, headers: { "content-type": "application/json" },
  });
}
function makeFetch(options: { wrongCommit?: boolean; wrongDigest?: boolean; redirect?: string; payload?: Buffer } = {}) {
  const actual = options.payload ?? payload;
  return jest.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
    const url = String(_url);
    if (url.endsWith("/actions/runs/" + runId)) {
      return json({
        status: "completed", conclusion: "success", event: "workflow_run",
        name: "Windows companion-only signed distribution",
        head_sha: options.wrongCommit ? "b".repeat(40) : sha,
        head_branch: "main", repository: { full_name: "octo/repo" },
      });
    }
    if (url.endsWith("/actions/runs/" + runId + "/artifacts?per_page=100")) {
      return json({ total_count: 1, artifacts: [{
        id: 42, expired: false, name: artifactName,
        digest: "sha256:" + (options.wrongDigest ? "f".repeat(64) : digest),
      }] });
    }
    if (url.endsWith("/actions/artifacts/42/zip")) {
      return new Response(null, {
        status: 302, headers: {
          location: options.redirect ?? "https://productionresultssa0.blob.core.windows.net/actions-results/signed-url",
        },
      });
    }
    if (url.startsWith("https://productionresultssa0.blob.core.windows.net/")) {
      return new Response(actual, { status: 200 });
    }
    throw new Error("Unexpected external URL: " + url + String(init?.method));
  });
}
function request() {
  return {
    owner: "octo", repository: "repo", runId,
    artifactName, expectedCommitSha: sha, expectedArtifactSha256: digest,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("native GitHub Actions artifact materialization", () => {
  it("validates run and digest, downloads without forwarding GitHub bearer and replays idempotently", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch();
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    const first = await ingestor.materialize(request(), root);
    expect(first).toMatchObject({
      status: "materialized", archiveSha256: digest, sizeBytes: payload.length,
      validation: "actions_archive_sha256_verified",
    });
    expect(await readFile(first.archivePath)).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const call of fetchImpl.mock.calls.slice(0, 3)) {
      expect(JSON.stringify(call[1])).toContain("Bearer secret-test-credential");
    }
    expect(JSON.stringify(fetchImpl.mock.calls[3]?.[1])).not.toContain("secret-test-credential");
    const second = await ingestor.materialize(request(), root);
    expect(second).toMatchObject({ status: "already_materialized", archivePath: first.archivePath });
    expect(fetchImpl).toHaveBeenCalledTimes(6); // Replay revalidates GitHub run and artifact metadata.
  });

  it("rejects mismatched source commit before download", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch({ wrongCommit: true });
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects metadata digest mismatches and prevents archive creation", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch({ wrongDigest: true });
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const files = await readdir(path.join(root, ".runtime-tools", "github-actions-artifacts", String(runId)));
    expect(files).toHaveLength(0);
  });

  it("rejects untrusted download redirects and cancels before reading payload", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch({ redirect: "https://evil.example.invalid/actions.zip" });
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects changed bytes and cleans partial files before any replay", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch({ payload: Buffer.from("corrupted") });
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const files = await readdir(path.join(root, ".runtime-tools", "github-actions-artifacts", String(runId)));
    expect(files).toHaveLength(0);
  });

  it("blocks traversal through an existing symlinked artifact directory", async () => {
    const root = await fixture();
    const external = await fixture();
    await symlink(external, path.join(root, ".runtime-tools"), "dir");
    const fetchImpl = makeFetch();
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves pre-existing partial bytes and refuses a blind retry", async () => {
    const root = await fixture();
    const folder = path.join(root, ".runtime-tools", "github-actions-artifacts", String(runId));
    await mkdir(folder, { recursive: true });
    const partial = path.join(folder, artifactName + ".zip.partial");
    await writeFile(partial, "prior-unknown-transfer");
    const fetchImpl = makeFetch();
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({
      code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
    });
    expect(await readFile(partial, "utf8")).toBe("prior-unknown-transfer");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails closed on an existing external archive symlink", async () => {
    const root = await fixture();
    const external = await fixture();
    const folder = path.join(root, ".runtime-tools", "github-actions-artifacts", String(runId));
    await mkdir(folder, { recursive: true });
    const target = path.join(external, "contents.zip");
    await writeFile(target, payload);
    await symlink(target, path.join(folder, artifactName + ".zip"), "file");
    const fetchImpl = makeFetch();
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize(request(), root)).rejects.toMatchObject({
      code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // Metadata verified; no archive downloaded.
  });

  it("rejects invalid or user-crafted artifact names before filesystem writes", async () => {
    const root = await fixture();
    const fetchImpl = makeFetch();
    const ingestor = new GitHubActionsArtifactIngestor({ credentialProvider: provider, fetchImpl: fetchImpl as typeof fetch });
    await expect(ingestor.materialize({ ...request(), artifactName: "../escape" }, root)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(await readdir(root)).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

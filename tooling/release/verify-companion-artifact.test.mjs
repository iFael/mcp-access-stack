import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { identity, validateRuns, findArtifact, verifyRedirect, materialize } from "./verify-companion-artifact.mjs";

const sha = "a".repeat(40);
const repo = "iFael/mcp-access-stack";
const input = { repository: repo, sourceSha: sha, ciRunId: "37795843286",
  distributionRunId: "37796338088", expectedArchiveSha256: "b".repeat(64) };
const pin = identity(input);
const ci = { repository: { full_name: repo }, status: "completed", conclusion: "success",
  event: "push", name: "CI", head_branch: "main", head_sha: sha };
const distribution = { ...ci, event: "workflow_run", name: "Windows companion-only signed distribution" };
const artifact = { id: 918, name: pin.artifactName, expired: false, digest: "sha256:" + input.expectedArchiveSha256,
  size_in_bytes: 100, workflow_run: { id: Number(input.distributionRunId), head_sha: sha } };

test("release tag is pinned to exact successful main CI, never supplied as arbitrary input", () => {
  assert.equal(pin.tag, "v1.1.0-companion.37795843286");
  assert.equal(pin.artifactName, "windows-companion-1.1.0-companion.37795843286-" + sha);
  assert.throws(() => identity({ ...input, ciRunId: "../etc" }), /INVALID_PINNED_IDENTITY/);
  assert.throws(() => identity({ ...input, sourceSha: "b".repeat(39) }), /INVALID_PINNED_IDENTITY/);
});

test("CI, distribution and main CAS must all agree", () => {
  validateRuns(ci, distribution, { object: { sha } }, input);
  assert.throws(() => validateRuns(ci, { ...distribution, head_sha: "b".repeat(40) }, { object: { sha } }, input));
  assert.throws(() => validateRuns(ci, distribution, { object: { sha: "b".repeat(40) } }, input));
  assert.throws(() => validateRuns({ ...ci, conclusion: "failure" }, distribution, { object: { sha } }, input));
});

test("artifact identity requires unique exact digest, run and bounded size", () => {
  assert.equal(findArtifact({ total_count: 1, artifacts: [artifact] }, pin).id, 918);
  assert.throws(() => findArtifact({ total_count: 101, artifacts: [artifact] }, pin));
  assert.throws(() => findArtifact({ total_count: 2, artifacts: [artifact, artifact] }, pin));
  assert.throws(() => findArtifact({ total_count: 1, artifacts: [{ ...artifact, digest: "sha256:" + "c".repeat(64) }] }, pin));
  assert.throws(() => findArtifact({ total_count: 1, artifacts: [{ ...artifact, expired: true }] }, pin));
});

test("only pinned signed HTTPS artifact redirect hosts can receive download (without token)", () => {
  assert.match(verifyRedirect("https://objects.githubusercontent.com/signed?x=1"), /^https:/);
  for (const url of ["http://objects.githubusercontent.com/zip",
    "https://objects.githubusercontent.com.evil.test/", "https://localhost/zip",
    "https://user:pass@objects.githubusercontent.com/zip",
    "https://objects.githubusercontent.com:444/zip", "https://evil.test/zip"]) {
    assert.throws(() => verifyRedirect(url), /UNTRUSTED_ARTIFACT_REDIRECT/);
  }
});

test("downloads exact archive digest and never forwards GitHub token to signed destination", async () => {
  const bytes = Buffer.from("outer-artifact-fixture");
  const expectedHash = createHash("sha256").update(bytes).digest("hex");
  const fixed = identity({ ...input, expectedArchiveSha256: expectedHash });
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers });
    if (url.endsWith("/actions/runs/" + fixed.ciRunId)) return Response.json(ci);
    if (url.endsWith("/actions/runs/" + fixed.distributionRunId)) return Response.json(distribution);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha } });
    if (url.includes("/artifacts?per_page=100")) return Response.json({ total_count: 1, artifacts: [{
      ...artifact, digest: "sha256:" + expectedHash, size_in_bytes: bytes.length,
    }] });
    if (url.endsWith("/actions/artifacts/918/zip")) return new Response(null,
      { status: 302, headers: { location: "https://objects.githubusercontent.com/signed?fixture=1" } });
    if (url.startsWith("https://objects.githubusercontent.com/")) return new Response(bytes);
    throw Error("UNEXPECTED_NETWORK_REQUEST");
  };
  const directory = await mkdtemp(join(tmpdir(), "companion-bridge-test-"));
  try {
    const result = await materialize(fixed, { token: "test-token-do-not-log", directory, fetchImpl });
    assert.equal(result.releaseId, fixed.releaseId);
    assert.deepEqual(await readFile(result.archive), bytes);
    assert.equal(calls.at(-1).headers, undefined);
    assert.equal(calls.length, 6);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects mismatched archive bytes and cleans temporary file", async () => {
  const bytes = Buffer.from("wrong");
  const fetchImpl = async url => {
    if (url.endsWith("/actions/runs/" + input.ciRunId)) return Response.json(ci);
    if (url.endsWith("/actions/runs/" + input.distributionRunId)) return Response.json(distribution);
    if (url.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha } });
    if (url.includes("/artifacts?per_page=100")) return Response.json({ total_count: 1, artifacts: [{ ...artifact, size_in_bytes: bytes.length }] });
    if (url.endsWith("/actions/artifacts/918/zip")) return new Response(null, { status: 302,
      headers: { location: "https://objects.githubusercontent.com/signed" } });
    return new Response(bytes);
  };
  const directory = await mkdtemp(join(tmpdir(), "companion-bridge-reject-"));
  try {
    await assert.rejects(materialize(input, { token: "fixture", directory, fetchImpl }), /ARCHIVE_DIGEST_MISMATCH/);
    await assert.rejects(readFile(join(directory, "outer-actions-artifact.zip")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow must not contain an Edge deploy and public workflow excludes companion tags", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(new URL("../../.github/workflows/companion-windows-release-bridge.yml", import.meta.url), "utf8");
  const full = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /environment: public-release/);
  assert.match(workflow, /verify-companion-artifact\.mjs/);
  assert.match(workflow, /Publish-McpCompanionWindowsOnly\.ps1/);
  assert.doesNotMatch(workflow, /wrangler deploy|cloudflare-api-token|MCP_OWNER_TOKEN/i);
  assert.match(full, /"!v\*-companion\.\*"/);
  assert.match(full, /contains\(inputs\.tag \|\| github\.ref_name, '-companion\.'\)/);
  const parsed = parseYaml(workflow);
  const publicRelease = parseYaml(full);
  assert.equal(parsed.on.workflow_dispatch.inputs.expected_source_sha.required, true);
  assert.equal(parsed.jobs["publish-windows-only"].environment, "public-release");
  assert.equal(parsed.jobs["publish-windows-only"].permissions.contents, "write");
  assert.deepEqual(publicRelease.on.push.tags, ["v*", "!v*-companion.*"]);
});

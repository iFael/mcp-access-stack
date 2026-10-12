import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { verifyOracleSourceArtifact } from "./Verify-OracleLinuxSourceArtifact.mjs";

const sha = "a".repeat(40);
const ci = "38157605386";
const name = "oracle-linux-source-" + sha + ".tar.gz";
const source = Buffer.from("synthetic git archive fixture");
const digest = createHash("sha256").update(source).digest("hex");
const manifest = {
  schemaVersion: 1, product: "mcp-access-stack", kind: "source-archive",
  sourceCommit: sha, ciRunId: ci, artifactName: name, artifactSha256: digest,
};
const valid = () => ({
  source, checksum: digest + "  " + name + "\n",
  manifest, archiveName: name, expectedSha: sha, expectedCiRun: ci,
});

test("accepts an exact archive checksum and pinned provenance manifest", () => {
  assert.deepEqual(verifyOracleSourceArtifact(valid()), {
    status: "verified", sourceCommit: sha, ciRunId: ci,
  });
});

test("rejects tampering, truncated archives and wrong checksum", () => {
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), source: Buffer.from("tampered") }),
    /SOURCE_CHECKSUM_MISMATCH/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), source: Buffer.alloc(0) }),
    /SOURCE_ARCHIVE_INVALID/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), checksum: digest + "  other.tar.gz\n" }),
    /SOURCE_CHECKSUM_MISMATCH/);
});

test("rejects different commit, CI, artifact name, or unexpected manifest fields", () => {
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), expectedSha: "b".repeat(40) }),
    /SOURCE_ARCHIVE_INVALID/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), expectedCiRun: "12" }),
    /SOURCE_MANIFEST_MISMATCH/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), archiveName: "../" + name }),
    /SOURCE_ARCHIVE_INVALID/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), manifest: { ...manifest, extra: "ignored?" } }),
    /SOURCE_MANIFEST_MISMATCH/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), manifest: { ...manifest, kind: "runtime" } }),
    /SOURCE_MANIFEST_MISMATCH/);
});

test("fails closed on malformed identity and manifest", () => {
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), expectedSha: sha + "x" }),
    /EXPECTED_IDENTITY_INVALID/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), expectedCiRun: "0" }),
    /EXPECTED_IDENTITY_INVALID/);
  assert.throws(() => verifyOracleSourceArtifact({ ...valid(), manifest: null }),
    /SOURCE_MANIFEST_MISMATCH/);
});

test("Oracle-only workflow enforces existing tag, main CAS and successful CI", () => {
  const workflow = readFileSync(".github/workflows/oracle-linux-only-distribution.yml", "utf8").replace(/\r\n/g, "\n");
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|workflow_run|schedule):/m);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /RELEASE_TAG/);
  assert.match(workflow, /-oracle/);
  assert.match(workflow, /git\/ref\/tags\/\$RELEASE_TAG/);
  assert.match(workflow, /tag_sha.*EXPECTED_SHA/);
  assert.match(workflow, /CI_RUN_ID/);
  assert.match(workflow, /head_branch == "main"/);
  assert.match(workflow, /conclusion == "success"/);
  assert.match(workflow, /workflow_id == \$id/);
  assert.match(workflow, /git\/ref\/heads\/main/g);
  assert.match(workflow, /duplicate_count/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /git archive --format=tar/);
  assert.match(workflow, /gzip -n/);
  assert.match(workflow, /Verify-OracleLinuxSourceArtifact\.mjs/);
  assert.match(workflow, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /gh release create "\$RELEASE_TAG"/);
  assert.match(workflow, /--verify-tag --prerelease/);
  assert.match(workflow, /^  publish:\n    needs: \[preflight, package\]$/m);
  assert.match(workflow, /environment: public-release/);
  assert.match(workflow, /^      contents: write$/m);
  assert.doesNotMatch(workflow, /\bgh workflow run\b|\bnpx wrangler\b|npm run deploy\b/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|MCP_CONTRACT_PREPARE_TOKEN|MCP_OWNER_TOKEN/);
});

test("typed public release workflow pins main, lightweight tag and stable run UUID",()=>{
  const release=readFileSync(".github/workflows/release.yml","utf8").replace(/\r\n/g,"\n");
  assert.match(release,/run-name: .*mcp-release-/u);
  assert.match(release,/expected_main_sha:/u);
  assert.match(release,/operation_id:/u);
  assert.match(release,/environment: public-release/u);
  assert.match(release,/GITHUB_SHA.*EXPECTED_MAIN_SHA/u);
  assert.match(release,/git\/ref\/tags\/\$RELEASE_TAG/u);
  assert.match(release,/commit:\$EXPECTED_MAIN_SHA/u);
  assert.match(release,/GITHUB_RUN_ATTEMPT.*"1"/u);
  assert.match(release,/github\.event_name == 'workflow_dispatch' && inputs\.operation_id != ''/u);
});

test("reserved Oracle-only tags cannot invoke the existing public Edge release jobs", () => {
  const release = readFileSync(".github/workflows/release.yml", "utf8").replace(/\r\n/g, "\n");
  const guard = "if: " + "$" +
    "{{ !contains(github.ref_name, '-oracle.') && !contains(inputs.tag, '-oracle.') && !contains(github.ref_name, '-companion.') && !contains(inputs.tag, '-companion.') }}";
  assert.ok(release.includes(guard), "public release must fail closed for Oracle-only and Companion-only tags");
  assert.match(release, /metadata:\n\s+needs: signing-preflight/);
  assert.match(release, /edge:\n\s+needs:/);
  assert.match(release, /publish:\n\s+needs:/);
});

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { hashTree, verifyCampaignRunnerDirectory, MANIFEST_NAME } from "./Verify-CampaignRunnerLinux.mjs";

const SHA = "b36041e79cd79b2ea926f715407472706ce1a4d6";
const FILES = [
  "runtime/node",
  "runtime/LICENSE",
  "node_modules/@vs-code-gpt/shared/package.json",
  "node_modules/@vs-code-gpt/shared/dist/index.js",
  "node_modules/@vs-code-gpt/local-agent/package.json",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/campaign-service-cli.js",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/trusted-campaign-service-entrypoint.js",
];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-campaign-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of FILES) {
    const target = path.join(root, ...file.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file + "\n");
  }
  const manifest = {
    schemaVersion: 1, format: "mcp-v3-trusted-campaign-runner",
    platform: "linux-x64", nodeVersion: "v26.10.0",
    nodeArchiveSha256: "ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022",
    lockSha256: "a".repeat(64), sourceCommit: SHA, files: await hashTree(root),
  };
  const manifestPath = path.join(root, MANIFEST_NAME);
  await writeFile(manifestPath, JSON.stringify(manifest) + "\n");
  return { root, manifestPath, manifest };
}

test("validates all runtime files against the exact source SHA and pinned version", async t => {
  const f = await fixture(t);
  const result = await verifyCampaignRunnerDirectory(f.root, SHA);
  assert.deepEqual(result, { sourceCommit: SHA, nodeVersion: "v26.10.0", files: FILES.length });
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, "c".repeat(40)), /CAMPAIGN_ARTIFACT_INVALID_MANIFEST/u,
  );
});

test("fails closed on any added or altered dependency, not just owned code", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, FILES[2]), "tampered");
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_HASH_MISMATCH/u,
  );
  await writeFile(path.join(f.root, FILES[2]), FILES[2] + "\n");
  await writeFile(path.join(f.root, "node_modules", "unmanifested.js"), "bad");
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_FILES_DIFFER/u,
  );
});

test("rejects symlinks and escapes even when the manifest looks consistent", async t => {
  const f = await fixture(t);
  const link = path.join(f.root, "runtime", "shadow");
  await symlink(path.join(f.root, FILES[0]), link);
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_SYMLINK/u,
  );
  await rm(link);
  f.manifest.files[0].path = "../escape";
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_UNSAFE_PATH/u,
  );
});

test("rejects duplicate entries and mismatched manifest schema", async t => {
  const f = await fixture(t);
  f.manifest.files.push({ ...f.manifest.files[0] });
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_DUPLICATE_RECORD/u,
  );
  f.manifest.files.pop();
  f.manifest.nodeVersion = "v26.11.0";
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_INVALID_MANIFEST/u,
  );
});

test("fails when manifest silently omits critical bootstrap", async t => {
  const f = await fixture(t);
  f.manifest.files = f.manifest.files.filter(e => !e.path.endsWith("campaign-service-cli.js"));
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(
    () => verifyCampaignRunnerDirectory(f.root, SHA), /CAMPAIGN_ARTIFACT_MISSING_ENTRYPOINT/u,
  );
});

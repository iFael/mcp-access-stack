#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_NAME = "mcp-v3-campaign-runner-manifest.json";
const SHA = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const OFFICIAL_NODE_SHA256 = "ca70e9e349de048b9522abb3adc05b3bd6f43c5ffd3ec57916c7da292f59f022";
export function isCompilerOnly(name) {
  return /(?:\.d\.(?:ts|cts|mts)(?:\.map)?|\.tsbuildinfo|\.(?:js|mjs|cjs)\.map)$/u.test(name);
}
const FIRST_PARTY_DIST = [
  "node_modules/@vs-code-gpt/local-agent/dist/",
  "node_modules/@vs-code-gpt/shared/dist/",
];
const EXACT_FILES = [
  "runtime/node",
  "runtime/LICENSE",
  "node_modules/@vs-code-gpt/shared/package.json",
  "node_modules/@vs-code-gpt/shared/dist/index.js",
  "node_modules/@vs-code-gpt/local-agent/package.json",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/campaign-service-cli.js",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/campaign-g4-probe-cli.js",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/campaign-g4-safety-probe.js",
  "node_modules/@vs-code-gpt/local-agent/dist/campaign/trusted-campaign-service-entrypoint.js",
];

export async function sha256File(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

function validRelative(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") ||
    path.posix.isAbsolute(value) || value.includes("\0") ||
    value.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error("CAMPAIGN_ARTIFACT_UNSAFE_PATH");
  }
  return value;
}

export async function hashTree(root, { ignoreManifest = true } = {}) {
  const entries = [];
  async function visit(relative) {
    const dir = path.join(root, ...relative.split("/").filter(Boolean));
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = relative ? relative + "/" + entry.name : entry.name;
      const info = await lstat(path.join(dir, entry.name));
      if (info.isSymbolicLink()) throw new Error("CAMPAIGN_ARTIFACT_SYMLINK");
      if (info.isDirectory()) await visit(rel);
      else if (info.isFile()) {
        validRelative(rel);
        if (!ignoreManifest || rel !== MANIFEST_NAME) {
          entries.push({ path: rel, sha256: await sha256File(path.join(root, ...rel.split("/"))) });
        }
      } else throw new Error("CAMPAIGN_ARTIFACT_UNSUPPORTED_FILE");
    }
  }
  await visit("");
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return entries;
}

export async function verifyCampaignRunnerDirectory(directory, expectedCommit) {
  const root = path.resolve(directory);
  const file = path.join(root, MANIFEST_NAME);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("CAMPAIGN_ARTIFACT_BAD_MANIFEST");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(",") !==
      "files,format,lockSha256,nodeArchiveSha256,nodeVersion,platform,schemaVersion,sourceCommit" ||
      manifest.schemaVersion !== 1 || manifest.format !== "mcp-v3-trusted-campaign-runner" ||
      manifest.platform !== "linux-x64" || manifest.nodeVersion !== "v26.10.0" ||
      !COMMIT_SHA.test(manifest.sourceCommit) || !SHA.test(manifest.lockSha256) ||
      manifest.nodeArchiveSha256 !== OFFICIAL_NODE_SHA256 ||
      (expectedCommit !== undefined && manifest.sourceCommit !== expectedCommit) ||
      !Array.isArray(manifest.files)) {
    throw new Error("CAMPAIGN_ARTIFACT_INVALID_MANIFEST");
  }
  const expected = new Map();
  for (const record of manifest.files) {
    if (!record || Object.keys(record).sort().join(",") !== "path,sha256" ||
        !SHA.test(record.sha256)) throw new Error("CAMPAIGN_ARTIFACT_INVALID_FILE_RECORD");
    const rel = validRelative(record.path);
    if (rel === MANIFEST_NAME || expected.has(rel)) throw new Error("CAMPAIGN_ARTIFACT_DUPLICATE_RECORD");
    if (FIRST_PARTY_DIST.some(prefix => rel.startsWith(prefix)) &&
        isCompilerOnly(path.posix.basename(rel))) {
      throw new Error("CAMPAIGN_ARTIFACT_COMPILE_ONLY_INCLUDED");
    }
    expected.set(rel, record.sha256);
  }
  if (EXACT_FILES.some(fileName => !expected.has(fileName))) {
    throw new Error("CAMPAIGN_ARTIFACT_MISSING_ENTRYPOINT");
  }
  const observed = await hashTree(root);
  if (observed.length !== expected.size) throw new Error("CAMPAIGN_ARTIFACT_FILES_DIFFER");
  for (const record of observed) {
    if (!expected.has(record.path) || expected.get(record.path) !== record.sha256) {
      throw new Error("CAMPAIGN_ARTIFACT_HASH_MISMATCH");
    }
  }
  return { sourceCommit: manifest.sourceCommit, nodeVersion: manifest.nodeVersion, files: observed.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, commit] = process.argv.slice(2);
  if (!directory || !commit || !COMMIT_SHA.test(commit) || process.argv.length !== 4) {
    process.stderr.write("CAMPAIGN_ARTIFACT_VERIFY_USAGE\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyCampaignRunnerDirectory(directory, commit);
      process.stdout.write(JSON.stringify({ status: "verified", ...result }) + "\n");
    } catch {
      process.stderr.write("CAMPAIGN_ARTIFACT_VERIFY_FAILED\n");
      process.exitCode = 1;
    }
  }
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const HASH_CONCURRENCY = 16;

const [rootArg, manifestArg] = process.argv.slice(2);
if (!rootArg || !manifestArg) {
  fail("usage: Verify-McpV3LocalPackage.mjs <package-root> <manifest>");
}

try {
  const result = await verifyPackage(rootArg, manifestArg);
  process.stdout.write(JSON.stringify({
    status: "verified",
    files: result.files,
  }) + "\n");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

async function verifyPackage(rootValue, manifestValue) {
  const root = path.resolve(rootValue);
  const manifestPath = path.resolve(manifestValue);
  assertInsideRoot(root, manifestPath, true);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest || typeof manifest !== "object" || !Array.isArray(manifest.files)) {
    throw new Error("manifest.files is missing or invalid");
  }

  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.path !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("manifest contains an invalid file record");
    }
    const relative = normalizeManifestPath(entry.path);
    if (relative === "mcp-v3-local-manifest.json") {
      throw new Error("manifest cannot hash itself");
    }
    if (expected.has(relative)) {
      throw new Error(`manifest contains duplicate path: ${relative}`);
    }
    expected.set(relative, entry.sha256);
  }

  const observed = [];
  for (const [relative, expectedHash] of expected) {
    const full = path.resolve(root, ...relative.split("/"));
    assertInsideRoot(root, full);
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(
        `runtime package critical file is missing or invalid: ${relative}`,
      );
    }
    observed.push({ relative, full, expectedHash });
  }

  // Third-party node_modules are covered by the immutable asset
  // checksum/provenance attestation. Package-owned files are still scanned
  // for unexpected additions and symlinks, while critical internal modules
  // inside node_modules are hashed through their manifest entries above.
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = normalizeManifestPath(path.relative(root, full));
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(`runtime package contains a symlink: ${relative}`);
      }
      if (info.isDirectory()) {
        if (current === root && entry.name === "node_modules") continue;
        stack.push(full);
        continue;
      }
      if (!info.isFile() || relative === "mcp-v3-local-manifest.json") {
        continue;
      }
      if (!expected.has(relative)) {
        throw new Error(`runtime package contains an unmanifested file: ${relative}`);
      }
    }
  }

  let cursor = 0;
  let mismatch;
  async function worker() {
    while (mismatch === undefined) {
      const index = cursor++;
      if (index >= observed.length) return;
      const item = observed[index];
      const digest = createHash("sha256")
        .update(await readFile(item.full))
        .digest("hex");
      if (digest !== item.expectedHash) {
        mismatch = item.relative;
        return;
      }
    }
  }

  const concurrency = Math.min(
    HASH_CONCURRENCY,
    Math.max(1, observed.length),
  );
  await Promise.all(
    Array.from({ length: concurrency }, () => worker()),
  );
  if (mismatch !== undefined) {
    throw new Error(`runtime package hash mismatch: ${mismatch}`);
  }

  return { files: observed.length };
}

function normalizeManifestPath(value) {
  const relative = String(value).replaceAll("\\", "/");
  const segments = relative.split("/");
  if (
    !relative ||
    path.posix.isAbsolute(relative) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`unsafe runtime package path: ${relative}`);
  }
  return relative;
}

function assertInsideRoot(root, candidate, allowRootFile = false) {
  if (
    candidate === root ||
    (!allowRootFile && !candidate.startsWith(root + path.sep)) ||
    (allowRootFile && candidate !== root && !candidate.startsWith(root + path.sep))
  ) {
    throw new Error(`path escaped runtime package root: ${candidate}`);
  }
}

function fail(message) {
  process.stderr.write(
    `MCP V3 package integrity verification failed: ${message}\n`,
  );
  process.exit(1);
}

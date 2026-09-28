#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const packageRoot = path.resolve(required(args, "package-root"));
const output = path.resolve(required(args, "output"));
const releaseId = required(args, "release-id");
const signIdentity = args["sign-identity"] ?? "";
if (signIdentity.length > 512 || signIdentity.includes("\0")) {
  throw new Error("Invalid macOS installer sign identity.");
}

if (process.platform !== "darwin") {
  throw new Error("MCP V3 .pkg bootstrap must be built on macOS.");
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[.+~-][0-9A-Za-z.+~-]+)*$/u.test(releaseId)) {
  throw new Error("macOS package release id must be a SemVer-compatible version.");
}

const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "mcp-v3-local-manifest.json"), "utf8"),
);
if (manifest.schemaVersion !== 1 ||
    manifest.product !== "MCP V3" ||
    manifest.runtime !== "local-companion" ||
    manifest.releaseId !== releaseId ||
    !/^darwin-(x64|arm64)$/u.test(manifest.platform)) {
  throw new Error("MCP V3 macOS package manifest is invalid.");
}
verifyRuntimePackage(packageRoot);

const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-macos-pkg-"));
const payload = path.join(temp, "payload");
const bootstrapRelative = path.join(
  "Library",
  "Application Support",
  "MCP V3",
  "Bootstrap",
  releaseId,
);
const bootstrapRoot = path.join(payload, bootstrapRelative);

try {
  await mkdir(bootstrapRoot, { recursive: true });
  await cp(packageRoot, bootstrapRoot, {
    recursive: true,
    force: false,
    dereference: false,
  });
  await assertNoSymlinks(bootstrapRoot);

  const bin = path.join(payload, "usr", "local", "bin");
  await mkdir(bin, { recursive: true });
  const bootstrap = "/" + bootstrapRelative.split(path.sep).join("/");

  const installCommand =
    `exec "${bootstrap}/deploy/macos/Install-McpV3Local.sh" "$@"`;
  await writeWrapper(path.join(bin, "mcp-v3"), installCommand);
  await writeWrapper(
    path.join(bin, "mcp-v3-local-install"),
    installCommand,
  );
  await writeWrapper(
    path.join(bin, "mcp-v3-local-update"),
    [
      'current="$HOME/Library/Application Support/MCP V3/App/current"',
      'script="$current/deploy/macos/Update-McpV3Local.sh"',
      'if [ ! -x "$script" ]; then echo "MCP V3 local companion is not installed for this user." >&2; exit 1; fi',
      'exec "$script" "$@"',
    ].join("\n"),
  );
  await writeWrapper(
    path.join(bin, "mcp-v3-local-uninstall"),
    [
      'current="$HOME/Library/Application Support/MCP V3/App/current"',
      'script="$current/deploy/macos/Uninstall-McpV3Local.sh"',
      `if [ ! -x "$script" ]; then script="${bootstrap}/deploy/macos/Uninstall-McpV3Local.sh"; fi`,
      'exec "$script" "$@"',
    ].join("\n"),
  );

  await mkdir(path.dirname(output), { recursive: true });
  await rm(output, { force: true });
  const pkgbuildArgs = [
    "--root",
    payload,
    "--identifier",
    "com.mcpv3.local.bootstrap",
    "--version",
    releaseId,
    "--install-location",
    "/",
  ];
  if (signIdentity) {
    pkgbuildArgs.push("--sign", signIdentity);
  }
  pkgbuildArgs.push(output);
  run("pkgbuild", pkgbuildArgs);

  process.stdout.write(JSON.stringify({
    status: "created",
    releaseId,
    platform: manifest.platform,
    signed: Boolean(signIdentity),
    output,
  }) + "\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function writeWrapper(target, body) {
  await writeFile(
    target,
    ["#!/bin/sh", "set -eu", body, ""].join("\n"),
    "utf8",
  );
  await chmod(target, 0o755);
}

async function assertNoSymlinks(rootPath) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(`.pkg payload contains a filesystem link: ${full}`);
      }
      if (info.isDirectory()) stack.push(full);
    }
  }
}

function verifyRuntimePackage(root) {
  const node = path.join(root, "runtime", "node", "node");
  const verifier = path.join(
    root,
    "tooling",
    "release",
    "Verify-McpV3LocalPackage.mjs",
  );
  const manifest = path.join(root, "mcp-v3-local-manifest.json");
  run(node, [verifier, root, manifest]);
}

function run(file, argv) {
  const result = spawnSync(file, argv, {
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`${file} failed with exit ${result.status}.`);
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("Arguments must be --name value pairs.");
    }
    values[key.slice(2)] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

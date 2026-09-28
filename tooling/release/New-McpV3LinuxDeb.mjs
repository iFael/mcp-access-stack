#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmod,
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
const compressionLevel = parseCompressionLevel(args["compression-level"]);

if (process.platform !== "linux") {
  throw new Error("MCP V3 .deb packages must be built on Linux.");
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[.+~-][0-9A-Za-z.+~-]+)*$/u.test(releaseId)) {
  throw new Error("Debian package release id must be a SemVer-compatible version.");
}

const manifest = JSON.parse(
  await readFile(path.join(packageRoot, "mcp-v3-local-manifest.json"), "utf8"),
);
if (manifest.schemaVersion !== 1 ||
    manifest.product !== "MCP V3" ||
    manifest.runtime !== "local-companion" ||
    manifest.releaseId !== releaseId ||
    !/^linux-(x64|arm64)$/u.test(manifest.platform)) {
  throw new Error("MCP V3 Linux package manifest is invalid.");
}
const debArch = manifest.platform.endsWith("-arm64") ? "arm64" : "amd64";
verifyRuntimePackage(packageRoot);
const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-deb-"));
const root = path.join(temp, "root");
const bootstrapRelative = path.join(
  "usr",
  "lib",
  "mcp-v3",
  "bootstrap",
  releaseId,
);
const bootstrapRoot = path.join(root, bootstrapRelative);

try {
  await mkdir(bootstrapRoot, { recursive: true });
  run("cp", ["-a", "--link", packageRoot + "/.", bootstrapRoot]);
  await assertNoSymlinks(bootstrapRoot);

  const debian = path.join(root, "DEBIAN");
  const bin = path.join(root, "usr", "bin");
  const applications = path.join(root, "usr", "share", "applications");
  await mkdir(debian, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(applications, { recursive: true });

  const control = [
    "Package: mcp-v3-local",
    `Version: ${releaseId}`,
    `Architecture: ${debArch}`,
    "Section: devel",
    "Priority: optional",
    "Maintainer: MCP V3",
    "Depends: bash, git, libsecret-tools, gnome-keyring, xdg-utils, systemd, dbus-user-session, tar, ca-certificates",
    "Description: MCP V3 local companion bootstrap",
    " Self-contained Node.js companion runtime with per-user OAuth, repositories",
    " and local execution. Runtime state remains scoped to the invoking user.",
    "",
  ].join("\n");
  const controlPath = path.join(debian, "control");
  await writeFile(controlPath, control, "utf8");
  await chmod(controlPath, 0o644);

  const bootstrap = "/" + bootstrapRelative.split(path.sep).join("/");
  const installCommand =
    `exec "${bootstrap}/deploy/linux/Install-McpV3Local.sh" "$@"`;
  await writeWrapper(path.join(bin, "mcp-v3"), installCommand);
  await writeWrapper(
    path.join(bin, "mcp-v3-local-install"),
    installCommand,
  );
  await writeWrapper(
    path.join(bin, "mcp-v3-local-update"),
    [
      'current="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-v3/current"',
      'script="$current/deploy/linux/Update-McpV3Local.sh"',
      'if [ ! -x "$script" ]; then echo "MCP V3 local companion is not installed for this user." >&2; exit 1; fi',
      'exec "$script" "$@"',
    ].join("\n"),
  );
  await writeWrapper(
    path.join(bin, "mcp-v3-local-uninstall"),
    [
      'current="${XDG_DATA_HOME:-$HOME/.local/share}/mcp-v3/current"',
      'script="$current/deploy/linux/Uninstall-McpV3Local.sh"',
      `if [ ! -x "$script" ]; then script="${bootstrap}/deploy/linux/Uninstall-McpV3Local.sh"; fi`,
      'exec "$script" "$@"',
    ].join("\n"),
  );

  const desktopPath = path.join(applications, "mcp-v3.desktop");
  await writeFile(
    desktopPath,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Version=1.0",
      "Name=MCP V3",
      "Comment=Connect this computer to MCP V3",
      "Exec=/usr/bin/mcp-v3",
      "Terminal=false",
      "Categories=Development;Utility;",
      "StartupNotify=true",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(desktopPath, 0o644);

  await normalizeDirectoryModes(root);
  await mkdir(path.dirname(output), { recursive: true });
  await rm(output, { force: true });
  run("dpkg-deb", [
    "--build",
    "--root-owner-group",
    "-Zgzip",
    `-z${compressionLevel}`,
    root,
    output,
  ]);

  process.stdout.write(JSON.stringify({
    status: "created",
    releaseId,
    architecture: debArch,
    output,
  }) + "\n");
} finally {
  await rm(temp, { recursive: true, force: true });
}

async function writeWrapper(target, body) {
  const content = [
    "#!/bin/sh",
    "set -eu",
    body,
    "",
  ].join("\n");
  await writeFile(target, content, "utf8");
  await chmod(target, 0o755);
}

async function normalizeDirectoryModes(rootPath) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    await chmod(current, 0o755);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
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
        throw new Error(`.deb payload contains a filesystem link: ${full}`);
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

function parseCompressionLevel(value) {
  if (value === undefined || value === "") return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 9) {
    throw new Error("--compression-level must be an integer from 1 to 9.");
  }
  return parsed;
}

function required(values, name) {
  const value = values[name];
  if (!value) throw new Error(`Missing --${name}.`);
  return value;
}

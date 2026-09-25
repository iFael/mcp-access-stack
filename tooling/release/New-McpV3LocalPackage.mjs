#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";

const WORKSPACES = [
  "services/workspace-agent",
  "services/mcp-gateway",
  "packages/mcp-core",
  "packages/edge-protocol",
];

const CRITICAL_RUNTIME_MODULES = [
  "@vs-code-gpt/local-agent",
  "@vs-code-gpt/remote-mcp-gateway",
  "@vs-code-gpt/shared",
  "@mcp-access-stack/edge-protocol",
];

const GITLEAKS_VERSION = "8.30.1";
const GITLEAKS_ASSETS = {
  "linux-x64": {
    asset: "gitleaks_8.30.1_linux_x64.tar.gz",
    sha256: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  },
  "linux-arm64": {
    asset: "gitleaks_8.30.1_linux_arm64.tar.gz",
    sha256: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
  },
  "darwin-x64": {
    asset: "gitleaks_8.30.1_darwin_x64.tar.gz",
    sha256: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  },
  "darwin-arm64": {
    asset: "gitleaks_8.30.1_darwin_arm64.tar.gz",
    sha256: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  },
};

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args.root ?? process.cwd());
const output = path.resolve(required(args, "output"));
const releaseId = required(args, "release-id");
const sourceCommit = required(args, "source-commit");
const edgeBaseUrl = normalizeHttpsOrigin(required(args, "edge-base-url"));
const buildRunId = args["build-run-id"] ?? "";
const macosCodeSignIdentity = args["macos-code-sign-identity"] ?? "";
const allowDirty = args["allow-dirty"] === "true";
if (args["allow-dirty"] !== undefined &&
    args["allow-dirty"] !== "true" &&
    args["allow-dirty"] !== "false") {
  throw new Error("--allow-dirty must be true or false.");
}
const platform = normalizedPlatform(process.platform);
const arch = normalizedArch(process.arch);
const platformId = `${platform}-${arch}`;
if (macosCodeSignIdentity && platform !== "darwin") {
  throw new Error("--macos-code-sign-identity is valid only on macOS.");
}
if (macosCodeSignIdentity.length > 512 || macosCodeSignIdentity.includes("\0")) {
  throw new Error("Invalid macOS code-sign identity.");
}

assertSafeReleaseId(releaseId);
assertSha(sourceCommit);
assertNode26();

const head = runCapture(
  "git",
  ["rev-parse", "--verify", "HEAD^{commit}"],
  root,
).trim();
if (head !== sourceCommit) {
  throw new Error("Current Git HEAD does not match source commit.");
}
const sourceStatus = runCapture(
  "git",
  ["status", "--porcelain", "--", "."],
  root,
).trim();
if (!allowDirty && sourceStatus.length > 0) {
  throw new Error("Production MCP V3 local package requires a clean checkout.");
}

const staging = path.join(
  path.dirname(output),
  `.mcp-v3-local-${releaseId}-${process.pid}-${Date.now()}`,
);

try {
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  await copyFileRequired(root, staging, "package.json");
  await copyFileRequired(root, staging, "package-lock.json");

  for (const workspace of WORKSPACES) {
    const source = path.join(root, workspace);
    await assertDirectory(path.join(source, "dist"), `${workspace}/dist`);
    const target = path.join(staging, workspace);
    await mkdir(target, { recursive: true });
    await cp(path.join(source, "package.json"), path.join(target, "package.json"));
    await cp(path.join(source, "dist"), path.join(target, "dist"), {
      recursive: true,
      force: false,
    });
  }

  run("npm", [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--workspaces",
    "--include-workspace-root",
  ], staging);

  await materializeWorkspaceModules(staging);
  await Promise.all([
    rm(path.join(staging, "services"), { recursive: true, force: true }),
    rm(path.join(staging, "packages"), { recursive: true, force: true }),
  ]);
  // npm creates executable convenience links under node_modules/.bin. The
  // companion imports packages directly and never requires those shims.
  await rm(path.join(staging, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
  await assertNoSymlinks(path.join(staging, "node_modules"));

  const nodeTarget = path.join(staging, "runtime", "node", "node");
  await mkdir(path.dirname(nodeTarget), { recursive: true });
  await cp(process.execPath, nodeTarget);
  await import("node:fs/promises").then(({ chmod }) => chmod(nodeTarget, 0o755));
  const bundledVersion = runCapture(nodeTarget, ["--version"], staging).trim();
  if (bundledVersion !== process.version) {
    throw new Error(
      `Bundled Node.js mismatch: expected=${process.version} actual=${bundledVersion}`,
    );
  }

  for (const relative of platformRuntimeFiles(platform)) {
    await copyFileRequired(root, staging, relative);
    await import("node:fs/promises").then(({ chmod }) =>
      chmod(path.join(staging, relative), 0o755)
    );
  }

  await cp(
    path.join(root, "config", "validation"),
    path.join(staging, "config", "validation"),
    { recursive: true, force: false },
  );
  await installPinnedGitleaks(staging, platformId);

  if (platform === "darwin" && macosCodeSignIdentity) {
    await signDarwinRuntime(staging, macosCodeSignIdentity);
  }

  const manifest = {
    schemaVersion: 1,
    product: "MCP V3",
    runtime: "local-companion",
    releaseId,
    commit: sourceCommit,
    platform: platformId,
    edgeBaseUrl,
    nodeVersion: process.version,
    macosCodeSigned: platform === "darwin"
      ? Boolean(macosCodeSignIdentity)
      : null,
    buildRunId: buildRunId ? Number(buildRunId) : null,
    builtAt: new Date().toISOString(),
    dependencies: {
      node: "bundled",
      npm: "not-required-at-runtime",
      git: platform === "linux"
        ? "package-dependency"
        : "installer-managed-prerequisite",
      secureStore: platform === "linux"
        ? "secret-service"
        : "keychain",
      astGrep: "bundled-node-module",
      gitleaks: `bundled-${GITLEAKS_VERSION}`,
    },
    files: await hashRuntimeFiles(staging),
  };
  const manifestPath = path.join(staging, "mcp-v3-local-manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8",
  );
  const verifierPath = path.join(
    staging,
    "tooling",
    "release",
    "Verify-McpV3LocalPackage.mjs",
  );
  run(nodeTarget, [verifierPath, staging, manifestPath], staging);

  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  process.stdout.write(JSON.stringify({
    status: "created",
    releaseId,
    platform: platformId,
    output,
    nodeVersion: process.version,
  }) + "\n");
} catch (error) {
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  throw error;
}

async function materializeWorkspaceModules(stage) {
  const selected = new Set(WORKSPACES.map(normalizeRelative));
  for (const workspace of WORKSPACES) {
    const packageJson = JSON.parse(
      await readFile(path.join(stage, workspace, "package.json"), "utf8"),
    );
    const modulePath = workspaceModulePath(stage, packageJson.name);
    await rm(modulePath, { recursive: true, force: true });
    await mkdir(modulePath, { recursive: true });
    await cp(
      path.join(stage, workspace, "package.json"),
      path.join(modulePath, "package.json"),
    );
    await cp(
      path.join(stage, workspace, "dist"),
      path.join(modulePath, "dist"),
      { recursive: true },
    );
  }

  const lock = JSON.parse(
    await readFile(path.join(stage, "package-lock.json"), "utf8"),
  );
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json does not contain packages.");
  }
  for (const [moduleRelative, entry] of Object.entries(lock.packages)) {
    if (!moduleRelative.startsWith("node_modules/") ||
        !entry || entry.link !== true) {
      continue;
    }
    const resolved = normalizeRelative(String(entry.resolved ?? ""));
    if (selected.has(resolved)) continue;

    const modulePath = path.resolve(stage, moduleRelative);
    if (!modulePath.startsWith(path.resolve(stage, "node_modules") + path.sep)) {
      throw new Error(`Unsafe workspace module path: ${moduleRelative}`);
    }
    const info = await lstat(modulePath).catch(() => null);
    if (!info) continue;
    if (!info.isSymbolicLink()) {
      throw new Error(
        `Unexpected physical unselected workspace module: ${moduleRelative}`,
      );
    }
    await rm(modulePath, { force: true });
  }
}

async function assertNoSymlinks(rootPath) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true })
      .catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(`Runtime package contains a filesystem link: ${full}`);
      }
      if (info.isDirectory()) stack.push(full);
    }
  }
}

async function installPinnedGitleaks(stage, platformId) {
  const descriptor = GITLEAKS_ASSETS[platformId];
  if (!descriptor) {
    throw new Error(`No pinned Gitleaks asset for ${platformId}.`);
  }
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${descriptor.asset}`;
  const response = await fetch(url, {
    headers: { "user-agent": "mcp-v3-release-builder" },
  });
  if (!response.ok) {
    throw new Error(`Gitleaks download failed with HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== descriptor.sha256) {
    throw new Error(`Gitleaks ${GITLEAKS_VERSION} failed SHA-256 verification.`);
  }

  const archive = path.join(stage, `.gitleaks-${process.pid}.tar.gz`);
  const target = path.join(
    stage,
    ".runtime-tools",
    "gitleaks",
    GITLEAKS_VERSION,
  );
  await mkdir(target, { recursive: true });
  await writeFile(archive, bytes, { flag: "wx", mode: 0o600 });
  try {
    run("tar", ["-xzf", archive, "-C", target], stage);
  } finally {
    await rm(archive, { force: true });
  }
  const binary = path.join(target, "gitleaks");
  const info = await stat(binary).catch(() => null);
  if (!info?.isFile()) {
    throw new Error("Verified Gitleaks archive did not contain the expected binary.");
  }
  await import("node:fs/promises").then(({ chmod }) => chmod(binary, 0o755));
  const version = runCapture(binary, ["version"], stage);
  if (!version.includes(GITLEAKS_VERSION)) {
    throw new Error(`Bundled Gitleaks version mismatch: ${version.trim()}`);
  }
}
async function signDarwinRuntime(stage, identity) {
  const candidates = [];
  const stack = [stage];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        throw new Error(`Cannot code-sign runtime symlink: ${full}`);
      }
      if (info.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!info.isFile()) continue;
      const executable = (info.mode & 0o111) !== 0;
      const extension = path.extname(entry.name).toLowerCase();
      if (!executable && extension !== ".node" && extension !== ".dylib" && extension !== ".so") {
        continue;
      }
      const description = runCapture("file", ["-b", full], stage).trim();
      if (description.includes("Mach-O")) {
        candidates.push(full);
      }
    }
  }

  candidates.sort((left, right) =>
    right.split(path.sep).length - left.split(path.sep).length
  );
  for (const candidate of candidates) {
    run(
      "codesign",
      [
        "--force",
        "--options",
        "runtime",
        "--timestamp",
        "--sign",
        identity,
        candidate,
      ],
      stage,
    );
    run(
      "codesign",
      ["--verify", "--strict", "--verbose=2", candidate],
      stage,
    );
  }
}

async function hashRuntimeFiles(stage) {
  const values = [];
  const seen = new Set();
  const roots = [
    { root: stage, skipTopLevelNodeModules: true },
    ...CRITICAL_RUNTIME_MODULES.map((packageName) => ({
      root: workspaceModulePath(stage, packageName),
      skipTopLevelNodeModules: false,
    })),
  ];

  for (const entryRoot of roots) {
    await assertDirectory(
      entryRoot.root,
      normalizeRelative(path.relative(stage, entryRoot.root)) || ".",
    );
    const stack = [entryRoot.root];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        const relative = normalizeRelative(path.relative(stage, full));
        if (relative === "mcp-v3-local-manifest.json") continue;
        if (entry.isDirectory()) {
          if (
            entryRoot.skipTopLevelNodeModules &&
            path.dirname(full) === stage &&
            entry.name === "node_modules"
          ) {
            continue;
          }
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || seen.has(relative)) continue;
        seen.add(relative);
        const bytes = await readFile(full);
        values.push({
          path: relative,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
  }

  values.sort((left, right) => left.path.localeCompare(right.path));
  return values;
}

function platformRuntimeFiles(platform) {
  if (platform === "linux") {
    return [
      "deploy/unix/McpV3Local.Common.sh",
      "tooling/release/Verify-McpV3LocalPackage.mjs",
      "deploy/linux/Install-McpV3Local.sh",
      "deploy/linux/Update-McpV3Local.sh",
      "deploy/linux/Uninstall-McpV3Local.sh",
    ];
  }
  if (platform === "darwin") {
    return [
      "deploy/unix/McpV3Local.Common.sh",
      "tooling/release/Verify-McpV3LocalPackage.mjs",
      "deploy/macos/Install-McpV3Local.sh",
      "deploy/macos/Update-McpV3Local.sh",
      "deploy/macos/Uninstall-McpV3Local.sh",
    ];
  }
  throw new Error(`Unsupported Unix local package platform: ${platform}`);
}

function workspaceModulePath(stage, packageName) {
  if (typeof packageName !== "string" ||
      !/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/u.test(packageName)) {
    throw new Error(`Unsafe workspace package name: ${String(packageName)}`);
  }
  return path.join(stage, "node_modules", ...packageName.split("/"));
}

async function copyFileRequired(rootPath, stage, relative) {
  const source = path.join(rootPath, relative);
  const info = await stat(source).catch(() => null);
  if (!info?.isFile()) throw new Error(`Required runtime file is missing: ${relative}`);
  const target = path.join(stage, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}

async function assertDirectory(value, label) {
  const info = await stat(value).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Required runtime directory is missing: ${label}`);
}

function run(file, argv, cwd) {
  const result = spawnSync(file, argv, {
    cwd,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status}): ${file} ${argv.join(" ")}`);
  }
}

function runCapture(file, argv, cwd) {
  const result = spawnSync(file, argv, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Command failed: ${file}`);
  }
  return result.stdout;
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

function assertSafeReleaseId(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
    throw new Error("Invalid release id.");
  }
}

function assertSha(value) {
  if (!/^[a-f0-9]{40}$/u.test(value)) {
    throw new Error("Source commit must be a lowercase 40-character SHA.");
  }
}

function assertNode26() {
  if (!/^v26\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(process.version)) {
    throw new Error(`MCP V3 local package requires Node.js 26.x; observed ${process.version}`);
  }
}

function normalizedPlatform(value) {
  if (!["linux", "darwin"].includes(value)) {
    throw new Error(
      `Unsupported Unix local package platform: ${value}. Windows uses the signed public-distribution pipeline.`,
    );
  }
  return value;
}

function normalizeHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP V3 package edge base URL must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "MCP V3 package edge base URL must be a credential-free HTTPS origin.",
    );
  }
  return url.href;
}

function normalizedArch(value) {
  if (value === "x64" || value === "arm64") return value;
  throw new Error(`Unsupported local companion architecture: ${value}`);
}

function normalizeRelative(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
}

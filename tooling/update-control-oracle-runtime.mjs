#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

export const UPDATE_CONTROL_ORACLE_CHANNEL_URL =
  "wss://mcp-v3-update-control.mcp-v3-update-control.workers.dev/_internal/oracle-channel";
export const UPDATE_CONTROL_ORACLE_RUNTIME_PRODUCT = "mcp-v3-update-control-oracle-runtime";
export const UPDATE_CONTROL_ORACLE_RUNTIME_SCHEMA = 1;
export const UPDATE_CONTROL_ORACLE_RUNTIME_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export const UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES = 128 * 1024 * 1024;

const ORCHESTRATOR_PACKAGE = "services/oracle-release-orchestrator";
const CONTRACT_PACKAGE = "packages/update-control-contract";
const WS_PACKAGE = "node_modules/ws";
const ARTIFACT_CONTRACT_MODULE = "node_modules/@mcp-access-stack/update-control-contract";
const API_UNIT_NAME = "mcp-v3-oracle-read-api.service";
const CHANNEL_UNIT_NAME = "mcp-v3-update-control-oracle-channel.service";
const UNIT_NAMES = [API_UNIT_NAME, CHANNEL_UNIT_NAME];
const MAX_RUNTIME_FILES = 10_000;
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;

export async function buildOracleRuntimeArtifact({ repositoryRoot, sourceCommit, outputPath }) {
  const root = path.resolve(repositoryRoot);
  const output = path.resolve(outputPath);
  assertGitSha(sourceCommit);
  if (!path.isAbsolute(outputPath)) throw new Error("Artifact output path must be absolute.");
  if (isWithin(root, output)) throw new Error("Artifact output must be outside the repository checkout.");
  assertNode26(process.execPath);

  const servicePackagePath = path.join(root, ORCHESTRATOR_PACKAGE, "package.json");
  const servicePackage = await readJsonFile(servicePackagePath);
  const contractPackage = await readJsonFile(path.join(root, CONTRACT_PACKAGE, "package.json"));
  const lock = await readJsonFile(path.join(root, "package-lock.json"));
  const typescriptPackage = await readJsonFile(path.join(root, "node_modules", "typescript", "package.json"));
  const wsPackage = await readJsonFile(path.join(root, "node_modules", "ws", "package.json"));
  if (lock.packages?.["node_modules/typescript"]?.version !== typescriptPackage.version) {
    throw new Error("Oracle runtime compiler does not match the locked TypeScript dependency.");
  }
  if (servicePackage.dependencies?.["@mcp-access-stack/update-control-contract"] !== contractPackage.version) {
    throw new Error("Oracle runtime workspace contract version does not match the service dependency.");
  }
  if (servicePackage.dependencies?.ws !== "^8.21.0" ||
      lock.packages?.["node_modules/ws"]?.version !== wsPackage.version ||
      !versionSatisfiesPinnedMajor(wsPackage.version, "8.21.0")) {
    throw new Error("Oracle runtime ws dependency does not match the locked production dependency.");
  }
  if (lock.packages?.["packages/update-control-contract"]?.version !== contractPackage.version) {
    throw new Error("Oracle runtime workspace contract does not match package-lock.json.");
  }

  const stage = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-update-control-runtime-build-"));
  try {
    const manifestEntries = new Map();
    await copyJavaScriptTree(
      path.join(root, ORCHESTRATOR_PACKAGE, "dist"),
      path.join(stage, ORCHESTRATOR_PACKAGE, "dist"),
      ORCHESTRATOR_PACKAGE + "/dist",
      manifestEntries,
    );
    await copyJavaScriptTree(
      path.join(root, CONTRACT_PACKAGE, "dist"),
      path.join(stage, ARTIFACT_CONTRACT_MODULE, "dist"),
      ARTIFACT_CONTRACT_MODULE + "/dist",
      manifestEntries,
    );
    await copyPackageJson(
      servicePackagePath,
      path.join(stage, ORCHESTRATOR_PACKAGE, "package.json"),
      ORCHESTRATOR_PACKAGE + "/package.json",
      manifestEntries,
    );
    await copyPackageJson(
      path.join(root, CONTRACT_PACKAGE, "package.json"),
      path.join(stage, ARTIFACT_CONTRACT_MODULE, "package.json"),
      ARTIFACT_CONTRACT_MODULE + "/package.json",
      manifestEntries,
    );
    await copyRegularTree(
      path.join(root, "node_modules", "ws"),
      path.join(stage, WS_PACKAGE),
      WS_PACKAGE,
      manifestEntries,
    );
    for (const unitName of UNIT_NAMES) {
      const relative = "deploy/linux/" + unitName;
      await copyPackageJson(
        path.join(root, relative),
        path.join(stage, relative),
        relative,
        manifestEntries,
      );
    }
    const runtimeToolPath = fileURLToPath(import.meta.url);
    const runtimeToolRelative = "tooling/update-control-oracle-runtime.mjs";
    await copyPackageJson(
      runtimeToolPath,
      path.join(stage, runtimeToolRelative),
      runtimeToolRelative,
      manifestEntries,
    );

    assertRuntimeDependencies(manifestEntries, servicePackage, contractPackage, wsPackage);
    assertRequiredArtifactFiles(manifestEntries);
    await smokeOracleRuntimeDirectory(stage, process.execPath);

    const manifestFiles = [...manifestEntries.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([filePath, bytes]) => ({
        path: filePath,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      }));
    const manifest = {
      schemaVersion: UPDATE_CONTROL_ORACLE_RUNTIME_SCHEMA,
      product: UPDATE_CONTROL_ORACLE_RUNTIME_PRODUCT,
      sourceCommit,
      minimumNodeMajor: 26,
      dependencies: {
        "@mcp-access-stack/update-control-contract": contractPackage.version,
        ws: wsPackage.version,
      },
      files: manifestFiles,
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
    await writeNormalizedFile(path.join(stage, "manifest.json"), manifestBytes);
    const packed = gzipSync(createUstar(manifestEntries, manifestBytes), { level: 9, mtime: 0 });
    packed.fill(0, 4, 8);
    packed[9] = 255;
    if (packed.length > UPDATE_CONTROL_ORACLE_RUNTIME_MAX_ARTIFACT_BYTES) {
      throw new Error("Oracle runtime artifact exceeds its size bound.");
    }

    const verifiedEntries = parseUstar(gunzipSync(packed, {
      maxOutputLength: UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES,
    }));
    validateArtifactManifest(verifiedEntries, sourceCommit);
    await smokeArtifactEntries(verifiedEntries, process.execPath);

    await mkdir(path.dirname(output), { recursive: true });
    const pendingOutput = output + ".pending-" + randomBytes(8).toString("hex");
    await writeFile(pendingOutput, packed, { flag: "wx", mode: 0o600 });
    try {
      const existing = await readFile(output).catch((error) => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing) {
        if (sha256(existing) !== sha256(packed)) {
          throw new Error("Refusing to replace an existing artifact with different bytes.");
        }
        await unlink(pendingOutput);
        return {
          status: "existing",
          artifactPath: output,
          artifactSha256: sha256(existing),
          sourceCommit,
          fileCount: manifestFiles.length,
        };
      }
      await rename(pendingOutput, output);
    } finally {
      await unlink(pendingOutput).catch(() => undefined);
    }
    return {
      status: "created",
      artifactPath: output,
      artifactSha256: sha256(packed),
      sourceCommit,
      fileCount: manifestFiles.length,
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function readOracleRuntimeArtifact({
  artifactPath,
  expectedSourceCommit,
  expectedArtifactSha256,
}) {
  assertGitSha(expectedSourceCommit);
  if (!HEX_SHA256.test(expectedArtifactSha256)) {
    throw new Error("Expected artifact SHA-256 is invalid.");
  }
  const info = await lstat(artifactPath);
  if (!info.isFile() || info.isSymbolicLink() ||
      info.size < 1 || info.size > UPDATE_CONTROL_ORACLE_RUNTIME_MAX_ARTIFACT_BYTES) {
    throw new Error("Oracle runtime artifact must be a bounded regular file.");
  }
  const archive = await readFile(artifactPath);
  const artifactSha256 = sha256(archive);
  if (artifactSha256 !== expectedArtifactSha256) {
    throw new Error("Oracle runtime artifact digest does not match the supplied digest.");
  }

  let entries;
  try {
    const tarBytes = gunzipSync(archive, {
      maxOutputLength: UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES,
    });
    entries = parseUstar(tarBytes);
  } catch {
    throw new Error("Oracle runtime artifact archive is invalid.");
  }
  const manifest = validateArtifactManifest(entries, expectedSourceCommit);
  const files = new Map(entries);
  files.delete("manifest.json");
  return { artifactSha256, manifest, files };
}

export async function smokeOracleRuntimeDirectory(runtimeRoot, nodeExecutable = process.execPath) {
  assertNode26(nodeExecutable);
  const required = [
    ORCHESTRATOR_PACKAGE + "/dist/server.js",
    ORCHESTRATOR_PACKAGE + "/dist/oracle-channel-connector-server.js",
  ];
  for (const relative of required) {
    const absolute = path.join(runtimeRoot, ...relative.split("/"));
    const info = await lstat(absolute).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error("Oracle runtime entrypoint is missing or unsafe: " + relative);
    }
    runNode(nodeExecutable, ["--check", absolute], runtimeRoot);
    const moduleUrl = pathToFileURL(absolute).href;
    runNode(
      nodeExecutable,
      ["--input-type=module", "--eval", "await import(" + JSON.stringify(moduleUrl) + ");"],
      runtimeRoot,
    );
  }
}

export async function prepareOracleRuntime({
  artifactPath,
  expectedSourceCommit,
  expectedArtifactSha256,
  paths,
  expectedOwner = { uid: 0, gid: 0 },
  runSystemctl = runSystemctlCommand,
  nodeExecutable = process.execPath,
}) {
  assertNode26(nodeExecutable);
  validateManagedPaths(paths);
  await assertNoSymlinkAncestors(paths.credentialsRoot);
  await assertNoSymlinkAncestors(paths.configRoot);
  await assertNoSymlinkAncestors(paths.installationRoot);
  await assertNoSymlinkAncestors(paths.systemdUnitDirectory);
  const envPath = path.join(paths.configRoot, "oracle-channel.env");
  const envContent = "UPDATE_CONTROL_ORACLE_CHANNEL_URL=" + UPDATE_CONTROL_ORACLE_CHANNEL_URL + "\n";
  const existingEnv = await inspectOptionalConfig(envPath, expectedOwner);
  if (existingEnv !== undefined && existingEnv !== envContent) {
    throw new Error("Existing oracle-channel.env does not match the fixed channel URL.");
  }

  const artifact = await readOracleRuntimeArtifact({
    artifactPath,
    expectedSourceCommit,
    expectedArtifactSha256,
  });
  assertRuntimeDependencyManifest(artifact.manifest);
  await smokeArtifactEntries(artifact.files, nodeExecutable);

  const credentialDirectoryInfo = await lstat(paths.credentialsRoot).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!credentialDirectoryInfo || !credentialDirectoryInfo.isDirectory() ||
      credentialDirectoryInfo.isSymbolicLink()) {
    throw new Error("Required Update Control credentials directory is missing or unsafe.");
  }
  await assertOwnedDirectory(paths.credentialsRoot, expectedOwner, "credentials directory");
  const channelPath = path.join(paths.credentialsRoot, "oracle-channel-token");
  await assertProtectedCredential(channelPath, expectedOwner, "oracle-channel-token");

  const localTokenPath = path.join(paths.credentialsRoot, "orchestrator-token");
  const existingLocalToken = await inspectOptionalProtectedCredential(
    localTokenPath,
    expectedOwner,
    "orchestrator-token",
  );
  if (existingLocalToken !== undefined) {
    await assertValidOrchestratorCredential(localTokenPath, expectedOwner);
  }
  for (const unitName of UNIT_NAMES) {
    const status = await runSystemctl(["show", "--property=ActiveState", "--value", unitName]);
    if (status.exitCode !== 0 || !["inactive", "not-found"].includes(status.stdout.trim())) {
      throw new Error("Refusing runtime preparation while an Update Control unit is active or its state is unknown.");
    }
  }

  await ensureManagedDirectory(paths.configRoot, 0o700, expectedOwner);
  await ensureManagedDirectory(paths.credentialsRoot, 0o700, expectedOwner);
  await ensureManagedDirectory(paths.installationRoot, 0o755, expectedOwner);
  await ensureManagedDirectory(path.join(paths.installationRoot, "releases"), 0o755, expectedOwner);
  await assertOwnedDirectory(paths.systemdUnitDirectory, expectedOwner, "systemd unit directory");

  const currentPath = path.join(paths.installationRoot, "current");
  const previousTarget = await inspectCurrentLink(currentPath, paths.installationRoot);
  const releasePath = path.join(paths.installationRoot, "releases", expectedSourceCommit);
  let changed = false;
  let releaseCreated = false;

  const existingRelease = await lstat(releasePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingRelease) {
    if (!existingRelease.isDirectory() || existingRelease.isSymbolicLink()) {
      throw new Error("Expected Oracle runtime release path is not a safe directory.");
    }
    await verifyRuntimeDirectory(releasePath, artifact.manifest, expectedOwner);
  } else {
    const stagePath = path.join(
      paths.installationRoot,
      ".staging-" + expectedSourceCommit + "-" + randomBytes(8).toString("hex"),
    );
    try {
      await extractArtifactEntries(artifact, stagePath, expectedOwner);
      await verifyRuntimeDirectory(stagePath, artifact.manifest, expectedOwner);
      await smokeOracleRuntimeDirectory(stagePath, nodeExecutable);
      await rename(stagePath, releasePath);
      await syncDirectory(path.join(paths.installationRoot, "releases"));
      changed = true;
      releaseCreated = true;
    } catch (error) {
      await rm(stagePath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  const generatedLocalBearer = existingLocalToken === undefined
    ? await createLocalOrchestratorCredential(localTokenPath, paths.credentialsRoot, expectedOwner)
    : false;
  if (generatedLocalBearer) changed = true;

  if (existingEnv === undefined) {
    await createConfigWithoutReplacement(envPath, envContent, expectedOwner);
    changed = true;
  }

  let unitsChanged = false;
  for (const unitName of UNIT_NAMES) {
    const relative = "deploy/linux/" + unitName;
    const unitContent = await readFile(path.join(releasePath, ...relative.split("/")));
    const unitPath = path.join(paths.systemdUnitDirectory, unitName);
    const unitChanged = await replaceUnitAtomically(unitPath, unitContent, expectedOwner);
    unitsChanged = unitsChanged || unitChanged;
  }
  const reload = await runSystemctl(["daemon-reload"]);
  if (reload.exitCode !== 0) {
    throw new Error("systemd daemon-reload failed; no service was started or enabled.");
  }
  if (unitsChanged) changed = true;

  let currentChanged = false;
  if (previousTarget !== "releases/" + expectedSourceCommit) {
    await switchCurrentAtomically(currentPath, paths.installationRoot, expectedSourceCommit);
    currentChanged = true;
    changed = true;
  }

  return {
    status: "prepared",
    sourceCommit: expectedSourceCommit,
    artifactSha256: artifact.artifactSha256,
    releasePath,
    currentPath,
    releaseCreated,
    generatedLocalBearer,
    unitsChanged,
    currentChanged,
    changed,
    activation: "not_requested",
  };
}

function validateManagedPaths(paths) {
  for (const key of ["installationRoot", "configRoot", "credentialsRoot", "systemdUnitDirectory"]) {
    if (!paths || !path.isAbsolute(paths[key])) throw new Error("Runtime installation paths must be absolute.");
  }
}

async function inspectCurrentLink(currentPath, installationRoot) {
  const info = await lstat(currentPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isSymbolicLink()) throw new Error("Existing current path is not a symlink.");
  const target = await import("node:fs/promises").then((fs) => fs.readlink(currentPath));
  const normalized = target.split(path.sep).join("/");
  if (!/^releases\/[a-f0-9]{40}$/u.test(normalized)) {
    throw new Error("Existing current symlink points outside the versioned release directory.");
  }
  const resolved = path.resolve(installationRoot, target);
  if (!isWithin(path.join(installationRoot, "releases"), resolved)) {
    throw new Error("Existing current symlink points outside the versioned release directory.");
  }
  const releaseInfo = await lstat(resolved);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) {
    throw new Error("Existing current symlink target is not a release directory.");
  }
  return normalized;
}

async function switchCurrentAtomically(currentPath, installationRoot, sourceCommit) {
  const pending = path.join(installationRoot, ".current-pending-" + randomBytes(8).toString("hex"));
  await symlink("releases/" + sourceCommit, pending);
  try {
    await rename(pending, currentPath);
    await syncDirectory(installationRoot);
  } catch (error) {
    await unlink(pending).catch(() => undefined);
    throw error;
  }
}

async function createLocalOrchestratorCredential(targetPath, credentialsRoot, expectedOwner) {
  const pendingPaths = [];
  for (const entry of await readdir(credentialsRoot)) {
    if (!entry.startsWith(".orchestrator-token.pending-")) continue;
    const pendingPath = path.join(credentialsRoot, entry);
    const info = await lstat(pendingPath);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedOwner.uid ||
        info.gid !== expectedOwner.gid || (info.mode & 0o777) !== 0o600) {
      throw new Error("A pending orchestrator-token file is unsafe; manual reconciliation is required.");
    }
    pendingPaths.push(pendingPath);
  }
  for (const pendingPath of pendingPaths) await unlink(pendingPath);

  const token = randomBytes(32).toString("base64url");
  const pendingPath = path.join(
    credentialsRoot,
    ".orchestrator-token.pending-" + randomBytes(12).toString("hex"),
  );
  let handle;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(token, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.chown(expectedOwner.uid, expectedOwner.gid);
    await handle.close();
    handle = undefined;
    await link(pendingPath, targetPath);
    await unlink(pendingPath);
    await syncDirectory(credentialsRoot);
    await assertProtectedCredential(targetPath, expectedOwner, "orchestrator-token");
    return true;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    if (error?.code === "EEXIST") {
      await assertProtectedCredential(targetPath, expectedOwner, "orchestrator-token");
      return false;
    }
    throw new Error("Unable to create the local orchestrator credential safely.");
  }
}

async function createConfigWithoutReplacement(targetPath, content, expectedOwner) {
  const pendingPath = targetPath + ".pending-" + randomBytes(8).toString("hex");
  let handle;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.chown(expectedOwner.uid, expectedOwner.gid);
    await handle.close();
    handle = undefined;
    await link(pendingPath, targetPath);
    await unlink(pendingPath);
    await syncDirectory(path.dirname(targetPath));
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    if (error?.code === "EEXIST") {
      const existing = await inspectOptionalConfig(targetPath, expectedOwner);
      if (existing === content) return;
    }
    throw new Error("Unable to create oracle-channel.env safely.");
  }
}

async function replaceUnitAtomically(targetPath, content, expectedOwner) {
  const existingInfo = await lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (existingInfo) {
    if (!existingInfo.isFile() || existingInfo.isSymbolicLink() ||
        existingInfo.uid !== expectedOwner.uid || existingInfo.gid !== expectedOwner.gid) {
      throw new Error("Existing Update Control unit file is unsafe.");
    }
    const existingContent = await readFile(targetPath);
    if (existingContent.equals(content) && (existingInfo.mode & 0o777) === 0o644) return false;
  }
  const pendingPath = targetPath + ".pending-" + randomBytes(8).toString("hex");
  let handle;
  try {
    handle = await open(pendingPath, "wx", 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.chmod(0o644);
    await handle.chown(expectedOwner.uid, expectedOwner.gid);
    await handle.close();
    handle = undefined;
    await rename(pendingPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(pendingPath).catch(() => undefined);
    throw new Error("Unable to install an approved Update Control unit atomically.");
  }
}

async function inspectOptionalProtectedCredential(filePath, expectedOwner, label) {
  const info = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  await assertCredentialMetadata(info, expectedOwner, label);
  return true;
}

async function assertProtectedCredential(filePath, expectedOwner, label) {
  const info = await lstat(filePath).catch(() => undefined);
  if (!info) throw new Error(label + " is missing.");
  await assertCredentialMetadata(info, expectedOwner, label);
}

async function assertValidOrchestratorCredential(filePath, expectedOwner) {
  const info = await lstat(filePath).catch(() => undefined);
  if (!info) throw new Error("orchestrator-token is missing.");
  await assertCredentialMetadata(info, expectedOwner, "orchestrator-token");
  const raw = await readFile(filePath, "utf8");
  const token = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if (token.length < 32 || token.length > 2_048 || /[\r\n\0]/u.test(token)) {
    throw new Error("orchestrator-token contents are invalid.");
  }
}

async function assertCredentialMetadata(info, expectedOwner, label) {
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(label + " must be a regular non-symlink file.");
  if (info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid ||
      (info.mode & 0o777) !== 0o600) {
    throw new Error(label + " must have the required owner and mode 0600.");
  }
  if (info.size < 32 || info.size > 2_048) throw new Error(label + " must be non-empty and bounded.");
}

async function inspectOptionalConfig(filePath, expectedOwner) {
  const info = await lstat(filePath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== expectedOwner.uid ||
      info.gid !== expectedOwner.gid || (info.mode & 0o777) !== 0o600) {
    throw new Error("Existing oracle-channel.env has unsafe type, owner, or mode.");
  }
  const value = await readFile(filePath, "utf8");
  if (value.length > 512 || value.includes("\0")) {
    throw new Error("Existing oracle-channel.env is invalid.");
  }
  return value;
}

async function ensureManagedDirectory(directoryPath, mode, expectedOwner) {
  await assertNoSymlinkAncestors(directoryPath);
  await mkdir(directoryPath, { recursive: true, mode });
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid) {
    throw new Error("Managed Update Control directory has an unsafe type or owner.");
  }
  if ((info.mode & 0o777) !== mode) await chmod(directoryPath, mode);
  await chown(directoryPath, expectedOwner.uid, expectedOwner.gid);
}

async function assertOwnedDirectory(directoryPath, expectedOwner, label) {
  const info = await lstat(directoryPath).catch(() => undefined);
  if (!info || !info.isDirectory() || info.isSymbolicLink() ||
      info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid) {
    throw new Error(label + " must be a real directory owned by the expected account.");
  }
}

async function assertNoSymlinkAncestors(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  const components = path.relative(root, resolved).split(path.sep).filter(Boolean);
  let current = root;
  for (const component of components) {
    current = path.join(current, component);
    const info = await lstat(current).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error("Managed path traverses a symlink.");
  }
}

async function extractArtifactEntries(artifact, stagePath, expectedOwner) {
  await mkdir(stagePath, { recursive: false, mode: 0o700 });
  for (const [relative, bytes] of artifact.files) {
    assertSafeRelativePath(relative);
    const destination = path.join(stagePath, ...relative.split("/"));
    await assertNoSymlinkAncestors(destination);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
    const handle = await open(destination, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.chmod(0o644);
      await handle.chown(expectedOwner.uid, expectedOwner.gid);
    } finally {
      await handle.close();
    }
  }
  const manifestPath = path.join(stagePath, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(artifact.manifest, null, 2) + "\n", "utf8");
  const manifestHandle = await open(manifestPath, "wx", 0o600);
  try {
    await manifestHandle.writeFile(manifestBytes);
    await manifestHandle.sync();
    await manifestHandle.chmod(0o644);
    await manifestHandle.chown(expectedOwner.uid, expectedOwner.gid);
  } finally {
    await manifestHandle.close();
  }
  await normalizeRuntimeDirectory(stagePath, expectedOwner);
}

async function normalizeRuntimeDirectory(rootPath, expectedOwner) {
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Runtime package contains a symlink.");
      if (info.isDirectory()) {
        await chmod(target, 0o755);
        await chown(target, expectedOwner.uid, expectedOwner.gid);
        stack.push(target);
      } else if (info.isFile()) {
        await chmod(target, 0o644);
        await chown(target, expectedOwner.uid, expectedOwner.gid);
      } else {
        throw new Error("Runtime package contains a non-regular file.");
      }
    }
  }
  await chmod(rootPath, 0o755);
  await chown(rootPath, expectedOwner.uid, expectedOwner.gid);
}

async function verifyRuntimeDirectory(rootPath, expectedManifest, expectedOwner) {
  const rootInfo = await lstat(rootPath);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      rootInfo.uid !== expectedOwner.uid || rootInfo.gid !== expectedOwner.gid ||
      (rootInfo.mode & 0o777) !== 0o755) {
    throw new Error("Runtime release root owner or mode is invalid.");
  }
  const observed = new Map();
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error("Runtime release contains a symlink.");
      if (info.isDirectory()) {
        if (info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid ||
            (info.mode & 0o777) !== 0o755) {
          throw new Error("Runtime release directory owner or mode is invalid.");
        }
        stack.push(target);
      } else if (info.isFile()) {
        if (info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid ||
            (info.mode & 0o777) !== 0o644) {
          throw new Error("Runtime release file owner or mode is invalid.");
        }
        const relative = path.relative(rootPath, target).split(path.sep).join("/");
        observed.set(relative, await readFile(target));
      } else {
        throw new Error("Runtime release contains a non-regular file.");
      }
    }
  }
  const manifestPath = path.join(rootPath, "manifest.json");
  const parsedManifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (JSON.stringify(parsedManifest) !== JSON.stringify(expectedManifest)) {
    throw new Error("Runtime release manifest does not match the verified artifact.");
  }
  const verified = validateArtifactManifest(new Map([
    ...observed.entries(),
  ]), expectedManifest.sourceCommit);
  if (JSON.stringify(verified) !== JSON.stringify(expectedManifest)) {
    throw new Error("Runtime release contents do not match the verified manifest.");
  }
}

async function smokeArtifactEntries(files, nodeExecutable) {
  const stage = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-update-control-runtime-smoke-"));
  try {
    for (const [relative, bytes] of files) {
      if (relative === "manifest.json") continue;
      const destination = path.join(stage, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { mode: 0o600 });
    }
    await smokeOracleRuntimeDirectory(stage, nodeExecutable);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function copyJavaScriptTree(sourceRoot, targetRoot, relativeRoot, entries) {
  const sourceInfo = await lstat(sourceRoot).catch(() => undefined);
  if (!sourceInfo || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Required built JavaScript directory is missing or unsafe: " + relativeRoot);
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o755 });
  const children = (await readdir(sourceRoot, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const child of children) {
    const source = path.join(sourceRoot, child.name);
    const destination = path.join(targetRoot, child.name);
    const relative = relativeRoot + "/" + child.name;
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error("Build output contains a symlink: " + relative);
    if (info.isDirectory()) {
      await copyJavaScriptTree(source, destination, relative, entries);
    } else if (info.isFile() && child.name.endsWith(".js")) {
      const bytes = await readFile(source);
      await writeNormalizedFile(destination, bytes);
      entries.set(relative, bytes);
    } else if (!info.isFile()) {
      throw new Error("Build output contains a non-regular item: " + relative);
    }
  }
}

async function copyRegularTree(sourceRoot, targetRoot, relativeRoot, entries) {
  const sourceInfo = await lstat(sourceRoot).catch(() => undefined);
  if (!sourceInfo || !sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error("Required runtime dependency is missing or unsafe: " + relativeRoot);
  }
  await mkdir(targetRoot, { recursive: true, mode: 0o755 });
  const children = (await readdir(sourceRoot, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const child of children) {
    const source = path.join(sourceRoot, child.name);
    const destination = path.join(targetRoot, child.name);
    const relative = relativeRoot + "/" + child.name;
    const info = await lstat(source);
    if (info.isSymbolicLink()) throw new Error("Runtime dependency contains a symlink: " + relative);
    if (info.isDirectory()) {
      await copyRegularTree(source, destination, relative, entries);
    } else if (info.isFile()) {
      const bytes = await readFile(source);
      await writeNormalizedFile(destination, bytes);
      entries.set(relative, bytes);
    } else {
      throw new Error("Runtime dependency contains a non-regular item: " + relative);
    }
  }
}

async function copyPackageJson(source, destination, relative, entries) {
  const info = await lstat(source).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw new Error("Required runtime file is missing or unsafe: " + relative);
  }
  const bytes = await readFile(source);
  if (relative.endsWith(".json")) JSON.parse(bytes.toString("utf8"));
  await writeNormalizedFile(destination, bytes);
  entries.set(relative, bytes);
}

async function writeNormalizedFile(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  await writeFile(filePath, bytes, { flag: "wx", mode: 0o644 });
  await chmod(filePath, 0o644);
}

async function assertRuntimeDependencies(entries, servicePackage, contractPackage, wsPackage) {
  if (!entries.has(ORCHESTRATOR_PACKAGE + "/dist/server.js") ||
      !entries.has(ORCHESTRATOR_PACKAGE + "/dist/oracle-channel-connector-server.js")) {
    throw new Error("Both Oracle runtime entrypoints must be present in the artifact.");
  }
  if (!entries.has(ARTIFACT_CONTRACT_MODULE + "/dist/index.js") ||
      !entries.has(WS_PACKAGE + "/package.json")) {
    throw new Error("Oracle runtime artifact is missing workspace contract or ws.");
  }
  const service = JSON.parse(entries.get(ORCHESTRATOR_PACKAGE + "/package.json").toString("utf8"));
  const packagedContract = JSON.parse(entries.get(ARTIFACT_CONTRACT_MODULE + "/package.json").toString("utf8"));
  const packagedWs = JSON.parse(entries.get(WS_PACKAGE + "/package.json").toString("utf8"));
  if (service.dependencies?.["@mcp-access-stack/update-control-contract"] !== contractPackage.version ||
      packagedContract.version !== contractPackage.version ||
      packagedWs.version !== wsPackage.version ||
      service.dependencies?.ws !== "^8.21.0") {
    throw new Error("Oracle runtime artifact dependency metadata is inconsistent.");
  }
}

function assertRequiredArtifactFiles(entries) {
  const required = [
    ORCHESTRATOR_PACKAGE + "/package.json",
    ORCHESTRATOR_PACKAGE + "/dist/server.js",
    ORCHESTRATOR_PACKAGE + "/dist/oracle-channel-connector-server.js",
    ARTIFACT_CONTRACT_MODULE + "/package.json",
    ARTIFACT_CONTRACT_MODULE + "/dist/index.js",
    WS_PACKAGE + "/package.json",
    "tooling/update-control-oracle-runtime.mjs",
    "deploy/linux/" + API_UNIT_NAME,
    "deploy/linux/" + CHANNEL_UNIT_NAME,
  ];
  for (const relative of required) {
    if (!entries.has(relative)) throw new Error("Oracle runtime artifact is missing: " + relative);
  }
  const unitFiles = [...entries.keys()].filter((name) => name.endsWith(".service")).sort();
  const expectedUnits = UNIT_NAMES.map((name) => "deploy/linux/" + name).sort();
  if (JSON.stringify(unitFiles) !== JSON.stringify(expectedUnits)) {
    throw new Error("Oracle runtime artifact must contain exactly the two approved units.");
  }
}

function validateArtifactManifest(entries, expectedSourceCommit) {
  assertGitSha(expectedSourceCommit);
  const manifestBytes = entries.get("manifest.json");
  if (!manifestBytes || manifestBytes.length > 1024 * 1024) {
    throw new Error("Oracle runtime artifact manifest is missing or too large.");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("Oracle runtime artifact manifest is invalid.");
  }
  if (manifest.schemaVersion !== UPDATE_CONTROL_ORACLE_RUNTIME_SCHEMA ||
      manifest.product !== UPDATE_CONTROL_ORACLE_RUNTIME_PRODUCT ||
      manifest.sourceCommit !== expectedSourceCommit ||
      manifest.minimumNodeMajor !== 26 ||
      !Array.isArray(manifest.files) || manifest.files.length < 8 ||
      manifest.files.length > MAX_RUNTIME_FILES ||
      !manifest.dependencies ||
      typeof manifest.dependencies["@mcp-access-stack/update-control-contract"] !== "string" ||
      typeof manifest.dependencies.ws !== "string") {
    throw new Error("Oracle runtime artifact manifest does not match the required contract.");
  }

  const manifestPaths = new Set();
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" ||
        !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 ||
        !HEX_SHA256.test(entry.sha256)) {
      throw new Error("Oracle runtime artifact manifest contains an invalid file record.");
    }
    assertSafeRelativePath(entry.path);
    if (entry.path === "manifest.json" || manifestPaths.has(entry.path)) {
      throw new Error("Oracle runtime artifact manifest contains a duplicate path.");
    }
    manifestPaths.add(entry.path);
    const content = entries.get(entry.path);
    if (!content || content.length !== entry.sizeBytes || sha256(content) !== entry.sha256) {
      throw new Error("Oracle runtime artifact file does not match its manifest.");
    }
    totalBytes += content.length;
  }
  if (totalBytes > UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES) {
    throw new Error("Oracle runtime artifact contents exceed the configured bound.");
  }
  if (entries.size !== manifestPaths.size + 1 || !entries.has("manifest.json")) {
    throw new Error("Oracle runtime artifact contains unlisted files.");
  }

  const allowedPath = (filePath) => {
    const wsRelative = filePath.startsWith(WS_PACKAGE + "/")
      ? filePath.slice(WS_PACKAGE.length + 1)
      : "";
    return filePath === ORCHESTRATOR_PACKAGE + "/package.json" ||
      (filePath.startsWith(ORCHESTRATOR_PACKAGE + "/dist/") && filePath.endsWith(".js")) ||
      filePath === ARTIFACT_CONTRACT_MODULE + "/package.json" ||
      (filePath.startsWith(ARTIFACT_CONTRACT_MODULE + "/dist/") && filePath.endsWith(".js")) ||
      (wsRelative !== "" && (
        wsRelative === "package.json" ||
        /\.(?:js|mjs)$/u.test(wsRelative) ||
        wsRelative === "LICENSE" ||
        wsRelative === "README.md"
      )) ||
      filePath === "tooling/update-control-oracle-runtime.mjs" ||
      UNIT_NAMES.some((unit) => filePath === "deploy/linux/" + unit);
  };
  if ([...manifestPaths].some((filePath) => !allowedPath(filePath))) {
    throw new Error("Oracle runtime artifact contains a file outside the allowlist.");
  }
  assertRequiredArtifactFiles(new Map([...manifestPaths].map((filePath) => [filePath, Buffer.alloc(0)])));
  return manifest;
}

function parseUstar(input) {
  if (!Buffer.isBuffer(input) || input.length % 512 !== 0 ||
      input.length > UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES) {
    throw new Error("Oracle runtime tar size is invalid.");
  }
  const files = new Map();
  let offset = 0;
  let totalBytes = 0;
  let zeroBlocks = 0;
  while (offset + 512 <= input.length) {
    const header = input.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      zeroBlocks++;
      offset += 512;
      if (zeroBlocks >= 2) break;
      continue;
    }
    if (zeroBlocks > 0) throw new Error("Oracle runtime tar has data after its end marker.");
    if (header.toString("ascii", 257, 263) !== "ustar\u0000" ||
        header.toString("ascii", 263, 265) !== "00") {
      throw new Error("Oracle runtime tar must use the deterministic USTAR format.");
    }
    const observedChecksum = parseTarOctal(header, 148, 8);
    let calculatedChecksum = 0;
    for (let index = 0; index < header.length; index++) {
      calculatedChecksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (observedChecksum !== calculatedChecksum) throw new Error("Oracle runtime tar header checksum is invalid.");
    const typeFlag = header[156];
    if (typeFlag !== 0 && typeFlag !== 48) {
      throw new Error("Oracle runtime tar contains a non-regular entry.");
    }
    const leaf = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const filePath = prefix ? prefix + "/" + leaf : leaf;
    assertSafeRelativePath(filePath);
    if (files.has(filePath)) throw new Error("Oracle runtime tar contains a duplicate path.");
    const size = parseTarOctal(header, 124, 12);
    if (size > 16 * 1024 * 1024) throw new Error("Oracle runtime tar file exceeds its size bound.");
    const start = offset + 512;
    const end = start + size;
    if (end > input.length) throw new Error("Oracle runtime tar file is truncated.");
    const content = Buffer.from(input.subarray(start, end));
    files.set(filePath, content);
    totalBytes += size;
    if (totalBytes > UPDATE_CONTROL_ORACLE_RUNTIME_MAX_CONTENT_BYTES) {
      throw new Error("Oracle runtime tar contents exceed their size bound.");
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (zeroBlocks < 2 || [...input.subarray(offset)].some((byte) => byte !== 0)) {
    throw new Error("Oracle runtime tar end marker is missing or invalid.");
  }
  return files;
}

function createUstar(files, manifestBytes) {
  const entries = [...files.entries()].map(([name, content]) => [name, content]);
  entries.push(["manifest.json", manifestBytes]);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const blocks = [];
  for (const [name, content] of entries) {
    assertSafeRelativePath(name);
    const header = Buffer.alloc(512, 0);
    const split = splitTarPath(name);
    writeTarString(header, 0, 100, split.leaf);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\u0000", 257, "ascii");
    header.write("00", 263, "ascii");
    if (split.prefix) writeTarString(header, 345, 155, split.prefix);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    const checksumField = checksum.toString(8).padStart(6, "0") + "\u0000 ";
    header.write(checksumField, 148, 8, "ascii");
    blocks.push(header, content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function splitTarPath(filePath) {
  if (Buffer.byteLength(filePath, "utf8") <= 100) return { leaf: filePath, prefix: "" };
  const slashIndices = [];
  for (let index = 0; index < filePath.length; index++) if (filePath[index] === "/") slashIndices.push(index);
  for (const index of slashIndices.reverse()) {
    const prefix = filePath.slice(0, index);
    const leaf = filePath.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(leaf, "utf8") <= 100) {
      return { leaf, prefix };
    }
  }
  throw new Error("Oracle runtime artifact contains a path too long for deterministic USTAR.");
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("Oracle runtime tar string exceeds its field.");
  bytes.copy(buffer, offset);
}

function writeTarOctal(buffer, offset, length, value) {
  const octal = Math.trunc(value).toString(8);
  if (octal.length > length - 1) throw new Error("Oracle runtime tar numeric field overflow.");
  buffer.write(octal.padStart(length - 1, "0") + "\u0000", offset, length, "ascii");
}

function readTarString(buffer, offset, length) {
  const value = buffer.subarray(offset, offset + length);
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString("utf8");
}

function parseTarOctal(buffer, offset, length) {
  const value = buffer.toString("ascii", offset, offset + length).replace(/\0.*$/u, "").trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) throw new Error("Oracle runtime tar numeric field is invalid.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Oracle runtime tar numeric field is out of range.");
  return parsed;
}

function assertSafeRelativePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 ||
      filePath.includes("\\") || filePath.startsWith("/") || filePath.includes("\u0000")) {
    throw new Error("Oracle runtime artifact path is unsafe.");
  }
  const components = filePath.split("/");
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error("Oracle runtime artifact path traversal is rejected.");
  }
}

function assertRuntimeDependencyManifest(manifest) {
  if (manifest.dependencies["@mcp-access-stack/update-control-contract"] !== "0.1.0" ||
      !versionSatisfiesPinnedMajor(manifest.dependencies.ws, "8.21.0")) {
    throw new Error("Oracle runtime artifact dependency versions are not approved.");
  }
}

function versionSatisfiesPinnedMajor(observed, minimum) {
  const observedParts = String(observed).split(".").map(Number);
  const minimumParts = String(minimum).split(".").map(Number);
  if (observedParts.length !== 3 || minimumParts.length !== 3 ||
      observedParts.some((part) => !Number.isSafeInteger(part)) ||
      minimumParts.some((part) => !Number.isSafeInteger(part))) return false;
  if (observedParts[0] !== minimumParts[0]) return false;
  for (let index = 1; index < 3; index++) {
    if (observedParts[index] > minimumParts[index]) return true;
    if (observedParts[index] < minimumParts[index]) return false;
  }
  return true;
}

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function childNodeEnvironment() {
  const environment = {
    PATH: process.env.PATH ?? "",
    NODE_OPTIONS: "",
  };
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function runNode(executable, args, cwd) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    env: childNodeEnvironment(),
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Oracle runtime entrypoint failed its isolated Node smoke check.");
  }
}

function runSystemctlCommand(args) {
  const result = spawnSync("/usr/bin/systemctl", args, {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  });
  if (result.error) throw new Error("systemctl is unavailable.");
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "" };
}

async function buildOracleRuntimeTypescript(root) {
  const lock = await readJsonFile(path.join(root, "package-lock.json"));
  const compilerPackage = await readJsonFile(path.join(root, "node_modules", "typescript", "package.json"));
  if (lock.packages?.["node_modules/typescript"]?.version !== compilerPackage.version) {
    throw new Error("Oracle runtime compiler does not match the locked TypeScript dependency.");
  }
  const compiler = path.join(root, "node_modules", "typescript", "bin", "tsc");
  for (const packagePath of [CONTRACT_PACKAGE, ORCHESTRATOR_PACKAGE]) {
    await rm(path.join(root, packagePath, "dist"), { recursive: true, force: true });
  }
  for (const config of [
    path.join(CONTRACT_PACKAGE, "tsconfig.json"),
    path.join(ORCHESTRATOR_PACKAGE, "tsconfig.json"),
  ]) {
    const result = spawnSync(process.execPath, [compiler, "-p", config], {
      cwd: root,
      encoding: "utf8",
      timeout: 60_000,
      env: childNodeEnvironment(),
      windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error || result.status !== 0) {
      throw new Error("Oracle runtime TypeScript build failed.");
    }
  }
}

async function assertGitMainCheckout(root, sourceCommit) {
  const branch = gitText(root, ["branch", "--show-current"]);
  const head = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const status = gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (branch !== "main" || head !== sourceCommit || status !== "") {
    throw new Error("Build the Oracle runtime only from a clean main checkout at the exact supplied commit.");
  }
}

function gitText(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("Unable to verify the exact main source checkout.");
  return (result.stdout ?? "").trim();
}

function assertNode26(executable) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const version = (result.stdout ?? "").trim();
  const match = /^v(\d+)\./u.exec(version);
  if (result.error || result.status !== 0 || !match || Number(match[1]) < 26) {
    throw new Error("Oracle Update Control runtime requires Node.js 26 or newer.");
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertGitSha(value) {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error("Expected source commit must be a full 40-character Git SHA.");
  }
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

async function syncDirectory(directoryPath) {
  const handle = await open(directoryPath, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const DEFAULT_ORACLE_RUNTIME_PATHS = Object.freeze({
  installationRoot: "/opt/mcp-access-stack/update-control",
  configRoot: "/etc/mcp-access-stack/update-control",
  credentialsRoot: "/etc/mcp-access-stack/update-control/credentials",
  systemdUnitDirectory: "/etc/systemd/system",
});

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!key.startsWith("--")) throw new Error("Unexpected positional argument.");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("Every option requires a value.");
    if (Object.hasOwn(options, key)) throw new Error("Duplicate option: " + key);
    options[key] = value;
    index++;
  }
  return options;
}

async function runCli() {
  const command = process.argv[2];
  const options = parseOptions(process.argv.slice(3));
  if (command === "build") {
    const sourceCommit = options["--source-commit"];
    const outputPath = options["--output"];
    if (!sourceCommit || !outputPath || Object.keys(options).some((key) =>
      !["--source-commit", "--output"].includes(key))) {
      throw new Error("Usage: update-control-oracle-runtime.mjs build --source-commit SHA --output ABSOLUTE_PATH");
    }
    const repositoryRoot = process.cwd();
    await assertGitMainCheckout(repositoryRoot, sourceCommit);
    await buildOracleRuntimeTypescript(repositoryRoot);
    await assertGitMainCheckout(repositoryRoot, sourceCommit);
    const output = await buildOracleRuntimeArtifact({ repositoryRoot, sourceCommit, outputPath });
    process.stdout.write(JSON.stringify(output) + "\n");
    return;
  }
  if (command === "prepare") {
    const artifactPath = options["--artifact"];
    const sourceCommit = options["--source-commit"];
    const artifactSha256 = options["--artifact-sha256"];
    if (!artifactPath || !sourceCommit || !artifactSha256 ||
        Object.keys(options).some((key) => !["--artifact", "--source-commit", "--artifact-sha256"].includes(key))) {
      throw new Error("Usage: update-control-oracle-runtime.mjs prepare --artifact FILE --source-commit SHA --artifact-sha256 SHA256");
    }
    if (typeof process.getuid !== "function" || process.getuid() !== 0) {
      throw new Error("Runtime preparation requires root.");
    }
    const result = await prepareOracleRuntime({
      artifactPath: path.resolve(artifactPath),
      expectedSourceCommit: sourceCommit,
      expectedArtifactSha256: artifactSha256,
      paths: DEFAULT_ORACLE_RUNTIME_PATHS,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }
  throw new Error("Usage: update-control-oracle-runtime.mjs <build|prepare> [bounded options]");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    const message = error instanceof Error ? error.message : "unexpected failure";
    process.stderr.write("update-control-oracle-runtime: " + message + "\n");
    process.exitCode = 1;
  });
}

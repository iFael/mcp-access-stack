import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildOracleRuntimeArtifact,
  prepareOracleRuntime,
  readOracleRuntimeArtifact,
  smokeOracleRuntimeDirectory,
} from "./update-control-oracle-runtime.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const linuxOnly = process.platform !== "linux";
const owner = {
  uid: typeof process.getuid === "function" ? process.getuid() : 1000,
  gid: typeof process.getgid === "function" ? process.getgid() : 1000,
};
const rootTemp = await mkdtemp(path.join(os.tmpdir(), "mcp-update-control-runtime-test-"));
let artifactPath = path.join(rootTemp, "oracle-runtime.tar.gz");
let artifact;
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();

after(async () => {
  await rm(rootTemp, { recursive: true, force: true });
});

async function createInstallSandbox(label) {
  const base = await mkdtemp(path.join(rootTemp, `${label}-`));
  const paths = {
    installationRoot: path.join(base, "opt", "mcp-access-stack", "update-control"),
    configRoot: path.join(base, "etc", "mcp-access-stack", "update-control"),
    credentialsRoot: path.join(base, "etc", "mcp-access-stack", "update-control", "credentials"),
    systemdUnitDirectory: path.join(base, "etc", "systemd", "system"),
  };
  await mkdir(paths.credentialsRoot, { recursive: true, mode: 0o700 });
  await mkdir(paths.systemdUnitDirectory, { recursive: true, mode: 0o755 });
  await chmod(paths.configRoot, 0o700);
  await chmod(paths.credentialsRoot, 0o700);
  const channelSecret = "synthetic-wss-channel-token-for-tests";
  await writeFile(path.join(paths.credentialsRoot, "oracle-channel-token"), channelSecret, { mode: 0o600 });
  await chmod(path.join(paths.credentialsRoot, "oracle-channel-token"), 0o600);
  return { base, paths, channelSecret };
}

async function prepare(paths, extra = {}) {
  return prepareOracleRuntime({
    artifactPath,
    expectedSourceCommit: artifact.sourceCommit,
    expectedArtifactSha256: artifact.artifactSha256,
    paths,
    expectedOwner: owner,
    runSystemctl: async (args) => {
      if (args[0] === "show") return { exitCode: 0, stdout: "inactive\n" };
      return { exitCode: 0, stdout: "" };
    },
    ...extra,
  });
}

test("production build CLI rejects non-main or mismatched source before writing an artifact", async () => {
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const suppliedSha = branch === "main" ? "a".repeat(40) : sourceCommit;
  const rejectedOutput = path.join(rootTemp, "rejected-production-build.tar.gz");
  const result = spawnSync(process.execPath, [
    path.join(repositoryRoot, "tooling/update-control-oracle-runtime.mjs"),
    "build",
    "--source-commit",
    suppliedSha,
    "--output",
    rejectedOutput,
  ], { cwd: repositoryRoot, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /clean main checkout at the exact supplied commit/u);
  await assert.rejects(() => lstat(rejectedOutput), /ENOENT/u);
});

test("runtime artifact is deterministic, SHA-bound, dependency-complete and both entrypoints load", async () => {
  const testSha = "a".repeat(40);
  const firstPath = path.join(rootTemp, "oracle-runtime-first.tar.gz");
  const secondPath = path.join(rootTemp, "oracle-runtime-second.tar.gz");
  const first = await buildOracleRuntimeArtifact({ repositoryRoot, sourceCommit: testSha, outputPath: firstPath });
  const second = await buildOracleRuntimeArtifact({ repositoryRoot, sourceCommit: testSha, outputPath: secondPath });
  artifact = first;
  artifactPath = firstPath;
  assert.equal(artifact.sourceCommit, testSha);
  assert.equal(second.artifactSha256, artifact.artifactSha256);
  assert.match(artifact.artifactSha256, /^[a-f0-9]{64}$/u);

  const verified = await readOracleRuntimeArtifact({
    artifactPath,
    expectedSourceCommit: testSha,
    expectedArtifactSha256: artifact.artifactSha256,
  });
  const entries = [...verified.files.keys()];
  for (const required of [
    "services/oracle-release-orchestrator/dist/server.js",
    "services/oracle-release-orchestrator/dist/oracle-channel-connector-server.js",
    "node_modules/@mcp-access-stack/update-control-contract/package.json",
    "node_modules/@mcp-access-stack/update-control-contract/dist/index.js",
    "node_modules/ws/package.json",
    "tooling/update-control-oracle-runtime.mjs",
    "deploy/linux/mcp-v3-oracle-read-api.service",
    "deploy/linux/mcp-v3-update-control-oracle-channel.service",
  ]) assert.ok(entries.includes(required), `artifact is missing ${required}`);

  const extracted = path.join(rootTemp, "runtime-smoke");
  for (const [relative, bytes] of verified.files) {
    const target = path.join(extracted, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  await smokeOracleRuntimeDirectory(extracted, process.execPath);
});

test("prepare installs only the approved units, preserves WSS bytes, creates local bearer, and leaves units stopped", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("prepare");
  const commands = [];
  const result = await prepareOracleRuntime({
    artifactPath,
    expectedSourceCommit: artifact.sourceCommit,
    expectedArtifactSha256: artifact.artifactSha256,
    paths: sandbox.paths,
    expectedOwner: owner,
    runSystemctl: async (args) => {
      commands.push(args);
      if (args[0] === "show") return { exitCode: 0, stdout: "inactive\n" };
      return { exitCode: 0, stdout: "" };
    },
  });

  const credentialDirectory = await lstat(sandbox.paths.credentialsRoot);
  assert.equal(credentialDirectory.mode & 0o777, 0o700);
  const channelPath = path.join(sandbox.paths.credentialsRoot, "oracle-channel-token");
  assert.equal((await readFile(channelPath, "utf8")) === sandbox.channelSecret, true, "WSS credential bytes remain unchanged");
  assert.equal((await lstat(channelPath)).mode & 0o777, 0o600);

  const localTokenPath = path.join(sandbox.paths.credentialsRoot, "orchestrator-token");
  const localToken = await readFile(localTokenPath, "utf8");
  assert.match(localToken, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await lstat(localTokenPath)).mode & 0o777, 0o600);
  assert.equal(result.generatedLocalBearer, true);
  assert.equal(JSON.stringify(result).includes(localToken), false);
  assert.equal(JSON.stringify(result).includes(sandbox.channelSecret), false);

  const envText = await readFile(path.join(sandbox.paths.configRoot, "oracle-channel.env"), "utf8");
  assert.equal(envText, "UPDATE_CONTROL_ORACLE_CHANNEL_URL=wss://mcp-v3-update-control.mcp-v3-update-control.workers.dev/_internal/oracle-channel\n");
  assert.doesNotMatch(envText, /TOKEN|secret|Bearer/u);

  assert.equal(await readlink(path.join(sandbox.paths.installationRoot, "current")), `releases/${artifact.sourceCommit}`);
  assert.equal(result.sourceCommit, artifact.sourceCommit);
  assert.equal(result.activation, "not_requested");
  const units = (await readdir(sandbox.paths.systemdUnitDirectory)).sort();
  assert.deepEqual(units, [
    "mcp-v3-oracle-read-api.service",
    "mcp-v3-update-control-oracle-channel.service",
  ]);
  assert.ok(commands.every((args) => !["start", "enable", "restart", "reload-or-restart"].includes(args[0])));
  assert.equal(commands.filter((args) => args[0] === "daemon-reload").length, 1);
});

test("repeated prepare is idempotent and never overwrites a valid local bearer", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("idempotent");
  await prepare(sandbox.paths);
  const localTokenPath = path.join(sandbox.paths.credentialsRoot, "orchestrator-token");
  const tokenBefore = await readFile(localTokenPath, "utf8");
  const statBefore = await lstat(localTokenPath);
  const wssStatBefore = await lstat(path.join(sandbox.paths.credentialsRoot, "oracle-channel-token"));

  const result = await prepare(sandbox.paths);
  const tokenAfter = await readFile(localTokenPath, "utf8");
  const statAfter = await lstat(localTokenPath);
  const wssStatAfter = await lstat(path.join(sandbox.paths.credentialsRoot, "oracle-channel-token"));
  assert.equal(tokenAfter === tokenBefore, true, "existing bearer is unchanged");
  assert.equal(statAfter.ino, statBefore.ino);
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
  assert.equal(wssStatAfter.ino, wssStatBefore.ino);
  assert.equal(result.generatedLocalBearer, false);
  assert.equal(result.changed, false);
});

test("daemon-reload failure keeps current untouched and retry reconciles already installed units", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("daemon-reload-retry");
  let reloadAttempts = 0;
  const runSystemctl = async (args) => {
    if (args[0] === "show") return { exitCode: 0, stdout: "inactive\n" };
    if (args[0] === "daemon-reload") {
      reloadAttempts++;
      return { exitCode: reloadAttempts === 1 ? 1 : 0, stdout: "" };
    }
    assert.fail("prepare must not activate a systemd unit");
  };
  const currentPath = path.join(sandbox.paths.installationRoot, "current");
  await assert.rejects(
    () => prepare(sandbox.paths, { runSystemctl }),
    /systemd daemon-reload failed/u,
  );
  await assert.rejects(() => lstat(currentPath), /ENOENT/u);

  const result = await prepare(sandbox.paths, { runSystemctl });
  assert.equal(reloadAttempts, 2, "retry reloads even though the unit files are already present");
  assert.equal(result.unitsChanged, false);
  assert.equal(result.currentChanged, true);
  assert.equal(await readlink(currentPath), `releases/${artifact.sourceCommit}`);
});

test("an unsafe release root is rejected without changing current", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("release-root-mode");
  await prepare(sandbox.paths);
  const currentPath = path.join(sandbox.paths.installationRoot, "current");
  const currentTarget = await readlink(currentPath);
  const releasePath = path.join(sandbox.paths.installationRoot, "releases", artifact.sourceCommit);
  await chmod(releasePath, 0o777);

  await assert.rejects(() => prepare(sandbox.paths), /Runtime release root owner or mode is invalid/u);
  assert.equal(await readlink(currentPath), currentTarget);
});

test("missing or symlinked WSS credential fails before generating bearer or switching current", { skip: linuxOnly }, async (t) => {
  for (const mode of ["missing", "symlink", "empty"]) {
    await t.test(mode, async () => {
      const sandbox = await createInstallSandbox(`wss-${mode}`);
      const channelPath = path.join(sandbox.paths.credentialsRoot, "oracle-channel-token");
      if (mode === "missing") await rm(channelPath);
      else if (mode === "symlink") {
        await rm(channelPath);
        await symlink(path.join(sandbox.base, "elsewhere"), channelPath);
      } else {
        await writeFile(channelPath, "", { mode: 0o600 });
        await chmod(channelPath, 0o600);
      }
      await assert.rejects(() => prepare(sandbox.paths), /oracle-channel-token/u);
      await assert.rejects(() => lstat(path.join(sandbox.paths.credentialsRoot, "orchestrator-token")), /ENOENT/u);
      await assert.rejects(() => lstat(path.join(sandbox.paths.installationRoot, "current")), /ENOENT/u);
    });
  }
});

test("a conflicting oracle-channel.env fails before credentials or current are changed", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("config-mismatch");
  const envPath = path.join(sandbox.paths.configRoot, "oracle-channel.env");
  await writeFile(envPath, "UPDATE_CONTROL_ORACLE_CHANNEL_URL=wss://wrong.example/_internal/oracle-channel\n", { mode: 0o600 });
  await chmod(envPath, 0o600);
  await assert.rejects(() => prepare(sandbox.paths), /fixed channel URL/u);
  await assert.rejects(() => lstat(path.join(sandbox.paths.credentialsRoot, "orchestrator-token")), /ENOENT/u);
  await assert.rejects(() => lstat(path.join(sandbox.paths.installationRoot, "current")), /ENOENT/u);
});

test("incorrect WSS credential permissions fail closed and preserve the file", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("wss-mode");
  const channelPath = path.join(sandbox.paths.credentialsRoot, "oracle-channel-token");
  await chmod(channelPath, 0o644);
  await assert.rejects(() => prepare(sandbox.paths), /owner and mode 0600/u);
  assert.equal((await readFile(channelPath, "utf8")) === sandbox.channelSecret, true, "WSS credential bytes remain unchanged");
  await assert.rejects(() => lstat(path.join(sandbox.paths.credentialsRoot, "orchestrator-token")), /ENOENT/u);
});

test("existing local bearer symlinks and broad permissions are rejected without replacement", { skip: linuxOnly }, async (t) => {
  for (const mode of ["symlink", "permissions", "malformed"]) {
    await t.test(mode, async () => {
      const sandbox = await createInstallSandbox(`local-token-${mode}`);
      const localTokenPath = path.join(sandbox.paths.credentialsRoot, "orchestrator-token");
      if (mode === "symlink") {
        const target = path.join(sandbox.base, "token-target");
        await writeFile(target, "synthetic-existing-token", { mode: 0o600 });
        await symlink(target, localTokenPath);
      } else if (mode === "permissions") {
        await writeFile(localTokenPath, "synthetic-existing-token", { mode: 0o644 });
        await chmod(localTokenPath, 0o644);
      } else {
        await writeFile(localTokenPath, "synthetic-invalid\nbearer-token-value", { mode: 0o600 });
        await chmod(localTokenPath, 0o600);
      }
      await assert.rejects(() => prepare(sandbox.paths), /orchestrator-token/u);
      if (mode === "permissions") assert.equal(await readFile(localTokenPath, "utf8"), "synthetic-existing-token");
      else if (mode === "malformed") assert.equal(await readFile(localTokenPath, "utf8"), "synthetic-invalid\nbearer-token-value");
      else assert.equal((await lstat(localTokenPath)).isSymbolicLink(), true);
      await assert.rejects(() => lstat(path.join(sandbox.paths.installationRoot, "current")), /ENOENT/u);
    });
  }
});

test("a valid existing local bearer is retained exactly and never appears in status output", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("local-token-valid");
  const localTokenPath = path.join(sandbox.paths.credentialsRoot, "orchestrator-token");
  const sentinel = "synthetic-existing-orchestrator-bearer-for-test";
  await writeFile(localTokenPath, sentinel, { mode: 0o600 });
  await chmod(localTokenPath, 0o600);
  const result = await prepare(sandbox.paths);
  assert.equal((await readFile(localTokenPath, "utf8")) === sentinel, true, "existing local bearer is retained");
  assert.equal(result.generatedLocalBearer, false);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
  assert.doesNotMatch(JSON.stringify(result), /secret|tokenValue|bearerValue/iu);
});

test("an invalid bundle cannot change the previous current symlink", { skip: linuxOnly }, async () => {
  const sandbox = await createInstallSandbox("atomic-current");
  await prepare(sandbox.paths);
  const currentPath = path.join(sandbox.paths.installationRoot, "current");
  const previousTarget = await readlink(currentPath);
  const invalidArtifact = path.join(rootTemp, "invalid-runtime.tar.gz");
  const invalidBytes = Buffer.from(await readFile(artifactPath));
  invalidBytes[Math.floor(invalidBytes.length / 2)] ^= 0xff;
  await writeFile(invalidArtifact, invalidBytes);
  const invalidDigest = (await import("node:crypto")).createHash("sha256").update(invalidBytes).digest("hex");

  await assert.rejects(() => prepareOracleRuntime({
    artifactPath: invalidArtifact,
    expectedSourceCommit: artifact.sourceCommit,
    expectedArtifactSha256: invalidDigest,
    paths: sandbox.paths,
    expectedOwner: owner,
    runSystemctl: async (args) => args[0] === "show"
      ? { exitCode: 0, stdout: "inactive\n" }
      : { exitCode: 0, stdout: "" },
  }), /archive|manifest|package|missing/iu);
  assert.equal(await readlink(currentPath), previousTarget);
});

test("stager source contains no generic activation operation and artifact contains exactly two units", async () => {
  const verified = await readOracleRuntimeArtifact({
    artifactPath,
    expectedSourceCommit: artifact.sourceCommit,
    expectedArtifactSha256: artifact.artifactSha256,
  });
  const entries = [...verified.files.keys()];
  const unitFiles = entries.filter((entry) => entry.endsWith(".service"));
  assert.deepEqual(unitFiles, [
    "deploy/linux/mcp-v3-oracle-read-api.service",
    "deploy/linux/mcp-v3-update-control-oracle-channel.service",
  ]);
  const stager = await readFile(path.join(repositoryRoot, "tooling/update-control-oracle-runtime.mjs"), "utf8");
  assert.match(stager, /daemon-reload/u);
  assert.doesNotMatch(stager, /process\.(stdout|stderr)\.write\([^)]*\btoken\b/iu);
  for (const forbidden of ["systemctl start", "systemctl enable", "systemctl restart", "systemctl reload-or-restart"]) assert.equal(stager.includes(forbidden), false);
});

test("orchestrator bearer remains local to the loopback API and is not passed to the Worker", async () => {
  const readApi = await readFile(path.join(repositoryRoot, "services/oracle-release-orchestrator/src/server.ts"), "utf8");
  const connector = await readFile(path.join(repositoryRoot, "services/oracle-release-orchestrator/src/oracle-channel-connector.ts"), "utf8");
  const worker = await readFile(path.join(repositoryRoot, "services/update-control-worker/src/worker.ts"), "utf8");
  const channel = await readFile(path.join(repositoryRoot, "services/update-control-worker/src/oracle-channel.ts"), "utf8");
  const deploy = await readFile(path.join(repositoryRoot, ".github/workflows/update-control-deploy.yml"), "utf8");

  assert.match(readApi, /UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE/u);
  assert.match(connector, /UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE/u);
  assert.ok(connector.includes("http://127.0.0.1:9381"));
  assert.ok(connector.includes("authorization: `Bearer ${this.config.orchestratorToken}`"));
  assert.match(worker, /UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN/u);
  assert.match(channel, /UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN/u);
  assert.doesNotMatch(worker + deploy + channel, /UPDATE_CONTROL_ORCHESTRATOR_TOKEN/u);
});

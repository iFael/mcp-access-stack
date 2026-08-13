import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptPath = path.resolve("operations/runtime/Initialize-GptOnlyProduction.ps1");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-production-init-"));
  const privateRoot = path.join(root, "private");
  const runtimeRoot = path.join(root, "runtime");
  const outputPath = path.join(privateRoot, "gpt-only-production.json");
  const policyPath = path.join(root, "workspace-policy.local.json");
  const tunnelPath = path.join(root, process.platform === "win32" ? "ngrok.exe" : "ngrok");
  await mkdir(privateRoot, { recursive: true });
  await writeFile(policyPath, "{}\n", "utf8");
  await writeFile(tunnelPath, "test executable placeholder\n", "utf8");
  return { root, privateRoot, runtimeRoot, outputPath, policyPath, tunnelPath };
}

function runInitializer(fixture, extraArguments = []) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-File",
      scriptPath,
      "-PublicBaseUrl",
      "https://portable-stack.example",
      "-TunnelExecutable",
      fixture.tunnelPath,
      "-PolicyPath",
      fixture.policyPath,
      "-OutputPath",
      fixture.outputPath,
      "-PrivateRoot",
      fixture.privateRoot,
      "-RuntimeRoot",
      fixture.runtimeRoot,
      "-McpPath",
      "/mcp-portable-test",
      ...extraArguments,
    ],
    { encoding: "utf8" },
  );
}

function runDockerInitializer(fixture, extraArguments = []) {
  return spawnSync(
    "pwsh",
    [
      "-NoLogo",
      "-NoProfile",
      "-File",
      scriptPath,
      "-PublicBaseUrl",
      "https://portable-stack.example",
      "-PolicyPath",
      fixture.policyPath,
      "-OutputPath",
      fixture.outputPath,
      "-PrivateRoot",
      fixture.privateRoot,
      "-RuntimeRoot",
      fixture.runtimeRoot,
      "-McpPath",
      "/mcp-portable-test",
      "-DockerTunnel",
      ...extraArguments,
    ],
    { encoding: "utf8" },
  );
}

function outputOf(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

test("initializes a complete private production configuration without printing secrets", async () => {
  const fixture = await createFixture();
  try {
    const result = runInitializer(fixture, ["-EnableActions", "-ActionWorkspaceIds", "workspace-a", "-Force"]);

    assert.equal(result.status, 0, outputOf(result));
    const summary = JSON.parse(result.stdout.trim());
    const config = JSON.parse(await readFile(fixture.outputPath, "utf8"));
    const ownerTokenPath = path.join(fixture.privateRoot, "owner-token.txt");
    const actionsTokenPath = path.join(fixture.privateRoot, "gpt-actions-token.txt");
    const ownerToken = (await readFile(ownerTokenPath, "utf8")).trim();
    const actionsToken = (await readFile(actionsTokenPath, "utf8")).trim();

    assert.equal(config.schemaVersion, 1);
    assert.equal(config.architecture, "gpt-only");
    assert.equal(config.supervisor, undefined);
    assert.equal(config.nodeEnv, "production");
    assert.equal(config.authMode, "owner");
    assert.equal(config.ownerAuth.token, ownerToken);
    assert.equal(config.gpt.tokenSha, sha256(config.gpt.token));
    assert.equal(config.actions.tokenSha, sha256(actionsToken));
    assert.equal(config.actions.enabled, true);
    assert.deepEqual(config.actions.workspaceIds, ["workspace-a"]);
    assert.equal(config.mcpPath, "/mcp-portable-test");
    assert.equal(config.publicBaseUrl, "https://portable-stack.example");
    assert.equal(config.tunnel.url, "https://portable-stack.example");
    assert.deepEqual(config.tunnel.args, ["http", "3300", "--url=https://portable-stack.example"]);
    assert.ok(config.browser.userDataDirectory.startsWith(config.browser.privateDirectory));
    assert.equal(summary.ConfigPath, await realpath(fixture.outputPath));
    assert.equal(summary.OwnerTokenPath, await realpath(ownerTokenPath));
    assert.equal(summary.ActionsTokenPath, await realpath(actionsTokenPath));
    assert.ok(!result.stdout.includes(config.gpt.token));
    assert.ok(!result.stdout.includes(config.browser.token));
    assert.ok(!result.stdout.includes(ownerToken));
    assert.ok(!result.stdout.includes(actionsToken));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("supports the containerized ngrok tunnel without a native executable", async () => {
  const fixture = await createFixture();
  try {
    const result = runDockerInitializer(fixture, ["-Force"]);
    assert.equal(result.status, 0, outputOf(result));
    const config = JSON.parse(await readFile(fixture.outputPath, "utf8"));
    assert.equal(config.tunnel.provider, "docker-ngrok");
    assert.equal(config.tunnel.executable, null);
    assert.deepEqual(config.tunnel.args, [
      "http",
      "3300",
      "--url=https://portable-stack.example",
    ]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("rejects unsafe paths, port collisions and Action permissions without Actions", async () => {
  const fixture = await createFixture();
  try {
    const outside = runInitializer(
      { ...fixture, outputPath: path.join(fixture.root, "outside.json") },
      ["-Force"],
    );
    assert.notEqual(outside.status, 0);
    assert.match(outputOf(outside), /OutputPath must stay inside PrivateRoot/u);

    const duplicatePorts = runInitializer(fixture, ["-GatewayPort", "3300", "-Force"]);
    assert.notEqual(duplicatePorts.status, 0);
    assert.match(outputOf(duplicatePorts), /must be distinct/iu);

    const invalidActions = runInitializer(fixture, ["-AllowActionWrites", "-Force"]);
    assert.notEqual(invalidActions.status, 0);
    assert.match(outputOf(invalidActions), /require EnableActions/u);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("refuses accidental overwrite and removes stale credentials on explicit replacement", async () => {
  const fixture = await createFixture();
  try {
    const first = runInitializer(fixture, ["-EnableActions", "-ActionWorkspaceIds", "workspace-a", "-Force"]);
    assert.equal(first.status, 0, outputOf(first));
    const originalConfig = await readFile(fixture.outputPath, "utf8");

    const refused = runInitializer(fixture);
    assert.notEqual(refused.status, 0);
    assert.match(outputOf(refused), /already exists/u);
    assert.equal(await readFile(fixture.outputPath, "utf8"), originalConfig);

    const replaced = runInitializer(fixture, ["-AuthMode", "none", "-Force"]);
    assert.equal(replaced.status, 0, outputOf(replaced));
    const summary = JSON.parse(replaced.stdout.trim());
    const config = JSON.parse(await readFile(fixture.outputPath, "utf8"));
    assert.equal(config.authMode, "none");
    assert.equal(config.ownerAuth, undefined);
    assert.equal(config.actions.enabled, false);
    assert.equal(config.actions.tokenSha, undefined);
    assert.equal(summary.OwnerTokenPath, null);
    assert.equal(summary.ActionsTokenPath, null);
    await assert.rejects(readFile(path.join(fixture.privateRoot, "owner-token.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(fixture.privateRoot, "gpt-actions-token.txt")), { code: "ENOENT" });
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.supervisor, undefined);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

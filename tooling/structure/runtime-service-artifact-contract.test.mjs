import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const retiredCurrentContractTokens = [
  "WINDOWS_EXECUTION_ARTIFACT_ROLES",
  "currentEdgeRoles",
  "seven-role",
  "-Role 'workspace-agent'",
  "-Role 'browser-worker'",
  "-Role 'edge-connector'",
  "-Role 'edge-connector-launcher'",
  "-Role 'edge-host'",
  "-Role 'edge-native-launcher'",
  "-Role 'node-runtime'",
];

test("current Windows execution contract uses two logical services instead of seven roles", () => {
  const contract = read("packages/mcp-core/src/windows-execution-node-contracts.ts");
  assert.match(contract, /"edge-runtime"/u);
  assert.match(contract, /"browser-worker"/u);
  assert.match(contract, /entryArtifactId/u);
  assert.match(contract, /owner/u);
  assert.doesNotMatch(contract, /WINDOWS_EXECUTION_ARTIFACT_ROLES/u);
});

test("current distribution manifest emits services and owned artifacts", () => {
  const source = read("deploy/windows/New-McpPublicDistribution.ps1");
  assert.match(source, /services\s*=\s*@\(/u);
  assert.match(source, /id\s*=\s*'edge-runtime'/u);
  assert.match(source, /id\s*=\s*'browser-worker'/u);
  assert.match(source, /(?:owner\s*=\s*|-Owner\s+)'shared'/u);
  for (const token of retiredCurrentContractTokens.slice(3)) {
    assert.equal(source.includes(token), false, `distribution still emits retired role token: ${token}`);
  }
});

test("current validator and staging fixture do not encode a seven-role cardinality", () => {
  for (const relativePath of [
    "deploy/windows/WindowsExecutionNode.Common.ps1",
    "deploy/windows/Test-McpWindowsExecutionNodeStaging.ps1",
  ]) {
    const source = read(relativePath);
    for (const token of retiredCurrentContractTokens) {
      assert.equal(source.includes(token), false, `${relativePath} still contains ${token}`);
    }
  }
});

test("current Windows runtime consumers resolve artifacts by id, never by role", () => {
  const expectations = new Map([
    ["deploy/windows/Start-McpEdgeConnector.ps1", ["node-runtime", "edge-connector", "edge-validation-launcher"]],
    ["deploy/windows/Install-McpEdgeConnectorTask.ps1", ["edge-host", "edge-validation-launcher"]],
    ["deploy/windows/Install-McpBrowserWorkerTask.ps1", ["node-runtime", "browser-worker-server", "browser-native-launcher", "browser-credential-broker"]],
  ]);
  for (const [relativePath, artifactIds] of expectations) {
    const source = read(relativePath);
    assert.equal(source.includes(".role"), false, relativePath + " still reads artifact roles");
    for (const artifactId of artifactIds) {
      assert.match(source, new RegExp(artifactId, "u"), relativePath + " does not reference " + artifactId);
    }
  }
});

test("native Edge host validates the current manifest by artifact id", () => {
  const source = read("tooling/windows-edge-host/McpEdgeHost.cs");
  assert.match(source, /RequireJsonInteger\(executionManifest, "version"\) != 2/u);
  assert.match(source, /RequireJsonString\(artifact, "id"\)/u);
  assert.doesNotMatch(source, /RequireJsonString\(artifact, "role"\)/u);
  assert.match(source, /"edge-validation-launcher"/u);
  assert.match(source, /"--project-root"/u);
  assert.match(source, /VS_CODE_GPT_STACK_ROOT/u);
});

test("edge task recovery is derivable from active lifecycle state and persisted configuration", () => {
  const distribution = read("deploy/windows/New-McpPublicDistribution.ps1");
  const installer = read("deploy/windows/Install-McpEdgeConnectorTask.ps1");
  const accessInstaller = read("deploy/windows/Install-McpAccessStack.ps1");
  const cutoverBroker = read("deploy/windows/Invoke-McpAccessStackCutoverBroker.ps1");
  assert.match(distribution, /Repair-McpEdgeConnectorTask\.ps1/u);
  assert.match(distribution, /Install-McpEdgeConnectorTask\.ps1/u);
  assert.match(distribution, /Invoke-McpAccessStackCutoverBroker\.ps1/u);
  assert.match(accessInstaller, /Start-McpAccessStackCutover\.ps1/u);
  assert.doesNotMatch(accessInstaller, /Stop-ScheduledTask/u);
  assert.match(cutoverBroker, /edge-task-config\.v1\.json/u);
  assert.match(cutoverBroker, /projectRoot\s*=\s*\$projectRoot/u);
  assert.match(cutoverBroker, /Write-McpEdgeTaskRecoveryConfig/u);
  assert.doesNotMatch(installer, /edge-task-config\.v1\.json/u);
  const edgeStartIndex = cutoverBroker.lastIndexOf("Start-ScheduledTask -TaskName $edgeTaskName");
  const recoveryWriteIndex = cutoverBroker.lastIndexOf("Write-McpEdgeTaskRecoveryConfig -Path $edgeRecoveryConfigPath");
  const recoveryCatchIndex = cutoverBroker.indexOf("\ncatch {", edgeStartIndex);
  assert.ok(edgeStartIndex >= 0, "detached cutover broker must start the Edge task");
  assert.ok(recoveryWriteIndex > edgeStartIndex, "recovery config must be persisted only after Edge task start");
  assert.ok(recoveryCatchIndex > recoveryWriteIndex, "recovery config persistence must remain inside the broker transactional try block");
  assert.equal(existsSync(path.join(root, "deploy/windows/Repair-McpEdgeConnectorTask.ps1")), true);
  const repair = read("deploy/windows/Repair-McpEdgeConnectorTask.ps1");
  assert.match(repair, /lifecycle-state\.v1\.json/u);
  assert.match(repair, /edge-task-config\.v1\.json/u);
  assert.match(repair, /Get-RequiredProperty[^\n]+projectRoot/u);
  assert.match(repair, /Install-McpEdgeConnectorTask\.ps1/u);
  assert.match(repair, /active\.releaseId/u);
  assert.match(repair, /Start-ScheduledTask/u);
});

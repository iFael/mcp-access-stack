import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => readFileSync(path.join(root, p), "utf8");
const exists = (p) => existsSync(path.join(root, p));

const retired = [
  "tooling/windows-execution-node/McpHost.cs",
  "tooling/windows-execution-node/McpHostSupervisor.cs",
  "tooling/windows-execution-node/McpHostPersistence.cs",
  "deploy/windows/Invoke-McpWindowsExecutionNodeTransition.ps1",
  "deploy/windows/Install-McpWindowsExecutionNodeHostTask.ps1",
  "deploy/windows/Install-McpWindowsExecutionNodeCutoverTask.ps1",
  "deploy/windows/Invoke-McpWindowsExecutionNodeCutoverTask.ps1",
  "deploy/windows/Request-McpWindowsExecutionNodeCutover.ps1",
  "deploy/windows/Test-McpHostSupervisor.ps1",
  "deploy/windows/Test-McpWindowsExecutionNodePersistence.ps1",
  "deploy/windows/Test-McpWindowsExecutionNodeTransition.ps1",
  "deploy/windows/New-McpWindowsEdgeCandidate.ps1",
  "deploy/windows/Test-McpWindowsEdgeCandidate.ps1",
  "deploy/windows/Test-McpWindowsEdgeCandidateWorkflow.ps1",
];

test("retires persistent McpHost and transitional Edge candidate control planes", () => {
  for (const p of retired) assert.equal(exists(p), false, `${p} must be retired`);
});

test("new Windows artifacts and distributions are Edge-only", () => {
  for (const p of [
    "deploy/windows/New-McpWindowsExecutionNodeArtifacts.ps1",
    "deploy/windows/New-McpPublicDistribution.ps1",
  ]) {
    const source = read(p);
    for (const token of ["McpHost.exe", "mcp-host-contract-v3", "-Role 'mcp-host'"]) {
      assert.equal(source.includes(token), false, `${p} still contains ${token}`);
    }
  }
});

test("execution manifest validator isolates eight-role compatibility to the historical v1 branch", () => {
  const source = read("deploy/windows/WindowsExecutionNode.Common.ps1");
  assert.doesNotMatch(source, /currentEdgeRoles|legacySplitOwnerRoles/u);
  assert.match(source, /executionVersion -eq 2/u);
  assert.match(source, /Historical execution-node manifest must contain exactly the eight-role split-owner contract/u);
});

test("cutover is Edge-only and has no persistent-host branch", () => {
  const source = read("deploy/windows/Invoke-McpWindowsExecutionNodeCutover.ps1");
  for (const token of ["persistent-host", "McpHost.exe", "Install-McpWindowsExecutionNodeHostTask.ps1", "[switch]$EdgeOnly", "ScheduledTask"]) {
    assert.equal(source.includes(token), false, `cutover still contains ${token}`);
  }
  assert.match(source, /ownershipMode = 'edge-only'/u);
});

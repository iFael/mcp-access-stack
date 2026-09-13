import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exists = (relativePath) => existsSync(path.join(root, relativePath));

const retiredPaths = [
  "operations/runtime",
  "deploy/runtime",
  "deploy/release",
  "deploy/windows/Manage-McpCredential.ps1",
];

test("removes self-sustaining legacy runtime and release surfaces", () => {
  for (const relativePath of retiredPaths) {
    assert.equal(exists(relativePath), false, `${relativePath} must be retired`);
  }
});

test("keeps the active credential broker tooling outside retired runtime helpers", () => {
  for (const relativePath of [
    "tooling/windows-credential-broker/McpCredentialBroker.cs",
    "tooling/windows-credential-broker/CredentialBroker.Common.ps1",
    "tooling/windows-credential-broker/Test-CredentialBroker.ps1",
  ]) {
    assert.equal(exists(relativePath), true, `${relativePath} must remain available`);
  }
});

test("public distribution does not package retired runtime helpers", () => {
  const source = readFileSync(path.join(root, "deploy/windows/New-McpPublicDistribution.ps1"), "utf8");
  for (const token of ["deploy\\runtime\\", "deploy\\release\\", "Manage-McpCredential.ps1", "Run-McpHostComponent.mjs"]) {
    assert.equal(source.includes(token), false, `distribution still contains retired token: ${token}`);
  }
});

test("npm scripts do not invoke retired runtime or release paths", () => {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const scripts = JSON.stringify(packageJson.scripts);
  for (const token of ["operations/runtime/", "deploy/runtime/", "deploy/release/", "environment-policy:migrate", "release:state:init"]) {
    assert.equal(scripts.includes(token), false, `package scripts still contain retired token: ${token}`);
  }
});

test("workspace agent CLI does not retain the removed run-powershell alias", () => {
  const source = readFileSync(path.join(root, "services/workspace-agent/src/cli.ts"), "utf8");
  assert.equal(source.includes("run-powershell"), false);
});

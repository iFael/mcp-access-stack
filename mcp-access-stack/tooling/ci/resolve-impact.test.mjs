import assert from "node:assert/strict";
import test from "node:test";
import { classifyChangedPaths } from "./resolve-impact.mjs";

function pick(result) {
  return {
    shared: result.shared,
    edgeProtocol: result.edgeProtocol,
    workspaceAgent: result.workspaceAgent,
    mcpGateway: result.mcpGateway,
    edgeGateway: result.edgeGateway,
    browserWorker: result.browserWorker,
    windowsRuntime: result.windowsRuntime,
    dockerGateway: result.dockerGateway,
    dockerBrowser: result.dockerBrowser,
    dockerProxy: result.dockerProxy,
    operationsTooling: result.operationsTooling,
    rootBroad: result.rootBroad,
    docsOnly: result.docsOnly,
  };
}

test("docs-only changes do not fan out into runtime validation", () => {
  const result = classifyChangedPaths([
    "README.md",
    "mcp-access-stack/docs/operations/RUNBOOK.md",
  ]);
  assert.deepEqual(pick(result), {
    shared: false,
    edgeProtocol: false,
    workspaceAgent: false,
    mcpGateway: false,
    edgeGateway: false,
    browserWorker: false,
    windowsRuntime: false,
    dockerGateway: false,
    dockerBrowser: false,
    dockerProxy: false,
    operationsTooling: false,
    rootBroad: false,
    docsOnly: true,
  });
});

test("shared mcp-core changes fan out to known consumers", () => {
  const result = classifyChangedPaths(["mcp-access-stack/packages/mcp-core/src/contracts.ts"]);
  assert.equal(result.shared, true);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.browserWorker, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.dockerGateway, true);
  assert.equal(result.dockerBrowser, true);
  assert.equal(result.edgeGateway, false);
  assert.equal(result.rootBroad, false);
  assert.equal(result.docsOnly, false);
});

test("edge protocol changes fan out to both gateway consumers", () => {
  const result = classifyChangedPaths(["mcp-access-stack/packages/edge-protocol/src/index.ts"]);
  assert.equal(result.edgeProtocol, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.dockerGateway, true);
  assert.equal(result.browserWorker, false);
});

test("workspace-agent changes include the gateway that embeds it", () => {
  const result = classifyChangedPaths(["mcp-access-stack/services/workspace-agent/src/local-agent.ts"]);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.dockerGateway, true);
  assert.equal(result.browserWorker, false);
});

test("root dependency graph changes fail closed to broad coverage", () => {
  const result = classifyChangedPaths(["mcp-access-stack/package-lock.json"]);
  for (const [key, value] of Object.entries(result)) {
    if (key === "docsOnly" || key === "resolverFailed" || key === "changedPaths") continue;
    assert.equal(value, true, `${key} should be true for root broad changes`);
  }
  assert.equal(result.docsOnly, false);
});

test("unknown relevant source paths fail closed to broad coverage", () => {
  const result = classifyChangedPaths(["mcp-access-stack/experimental/new-runtime-hook.mjs"]);
  assert.equal(result.rootBroad, true);
  assert.equal(result.shared, true);
  assert.equal(result.edgeProtocol, true);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.browserWorker, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.dockerGateway, true);
  assert.equal(result.dockerBrowser, true);
  assert.equal(result.dockerProxy, true);
  assert.equal(result.operationsTooling, true);
});

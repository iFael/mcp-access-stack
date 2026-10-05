import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
    linuxRuntime: result.linuxRuntime,
    operationsTooling: result.operationsTooling,
    updateControl: result.updateControl,
    rootBroad: result.rootBroad,
    docsOnly: result.docsOnly,
  };
}

test("docs-only changes do not fan out into runtime validation", () => {
  const result = classifyChangedPaths([
    "README.md",
    "docs/architecture/EDGE_MCP_RUNTIME.md",
  ]);
  assert.deepEqual(pick(result), {
    shared: false,
    edgeProtocol: false,
    workspaceAgent: false,
    mcpGateway: false,
    edgeGateway: false,
    browserWorker: false,
    windowsRuntime: false,
    linuxRuntime: false,
    operationsTooling: false,
    updateControl: false,
    rootBroad: false,
    docsOnly: true,
  });
});

test("shared mcp-core changes fan out to known consumers", () => {
  const result = classifyChangedPaths(["packages/mcp-core/src/contracts.ts"]);
  assert.equal(result.shared, true);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.browserWorker, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.linuxRuntime, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.rootBroad, false);
  assert.equal(result.docsOnly, false);
});

test("mcp-gateway changes include the Edge parity consumer", () => {
  const result = classifyChangedPaths([
    "services/mcp-gateway/src/mcp/server.ts",
  ]);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.linuxRuntime, true);
});

test("edge protocol changes fan out to both gateway consumers", () => {
  const result = classifyChangedPaths(["packages/edge-protocol/src/index.ts"]);
  assert.equal(result.edgeProtocol, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.linuxRuntime, true);
  assert.equal(result.browserWorker, false);
});

test("workspace-agent changes include the gateway that embeds it", () => {
  const result = classifyChangedPaths(["services/workspace-agent/src/local-agent.ts"]);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.linuxRuntime, true);
  assert.equal(result.browserWorker, false);
});

test("Linux runtime changes stay targeted to the Linux assurance lane", () => {
  const result = classifyChangedPaths(["deploy/linux/Start-McpEdgeConnector.sh"]);
  assert.equal(result.linuxRuntime, true);
  assert.equal(result.windowsRuntime, false);
  assert.equal(result.operationsTooling, true);
  assert.equal(result.rootBroad, false);
});

test("resolver execution failures stay fail-closed to broad coverage", () => {
  const stdout = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./resolve-impact.mjs", import.meta.url))],
    { encoding: "utf8" },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.resolverFailed, true);
  assert.equal(result.rootBroad, true);
  for (const key of [
    "shared",
    "edgeProtocol",
    "workspaceAgent",
    "mcpGateway",
    "edgeGateway",
    "browserWorker",
    "windowsRuntime",
    "linuxRuntime",
    "operationsTooling",
    "updateControl",
  ]) {
    assert.equal(result[key], true, `${key} should remain true on resolver failure`);
  }
  assert.equal(result.docsOnly, false);
});

test("root dependency graph changes fail closed to broad coverage", () => {
  const result = classifyChangedPaths(["package-lock.json"]);
  for (const [key, value] of Object.entries(result)) {
    if (key === "docsOnly" || key === "resolverFailed" || key === "changedPaths") continue;
    assert.equal(value, true, `${key} should be true for root broad changes`);
  }
  assert.equal(result.docsOnly, false);
});

test("unknown relevant source paths fail closed to broad coverage", () => {
  const result = classifyChangedPaths(["experimental/new-runtime-hook.mjs"]);
  assert.equal(result.rootBroad, true);
  assert.equal(result.shared, true);
  assert.equal(result.edgeProtocol, true);
  assert.equal(result.workspaceAgent, true);
  assert.equal(result.mcpGateway, true);
  assert.equal(result.edgeGateway, true);
  assert.equal(result.browserWorker, true);
  assert.equal(result.windowsRuntime, true);
  assert.equal(result.linuxRuntime, true);
  assert.equal(result.operationsTooling, true);
});

test("Update Control changes run the independent API, contract and auth lanes only", () => {
  const worker = classifyChangedPaths(["services/update-control-worker/src/worker.ts"]);
  assert.equal(worker.updateControl, true);
  assert.equal(worker.edgeGateway, false);
  assert.equal(worker.windowsRuntime, false);
  assert.equal(worker.rootBroad, false);

  const sharedAuth = classifyChangedPaths(["packages/mcp-owner-auth/src/owner-oauth.ts"]);
  assert.equal(sharedAuth.updateControl, true);
  assert.equal(sharedAuth.edgeGateway, true);
  assert.equal(sharedAuth.rootBroad, false);

  const ledgerApi = classifyChangedPaths(["services/oracle-release-orchestrator/src/read-api.ts"]);
  assert.equal(ledgerApi.updateControl, true);
  assert.equal(ledgerApi.rootBroad, false);
});

test("Edge Gateway-only changes stay on the edge-specific lane", () => {
  const edge = classifyChangedPaths(["services/mcp-edge-gateway/src/worker.ts"]);
  assert.equal(edge.edgeGateway, true);
  assert.equal(edge.updateControl, false);
  assert.equal(edge.rootBroad, false);
  assert.equal(edge.shared, false);
  assert.equal(edge.edgeProtocol, false);
  assert.equal(edge.mcpGateway, false);
  assert.equal(edge.workspaceAgent, false);
  assert.equal(edge.browserWorker, false);
});

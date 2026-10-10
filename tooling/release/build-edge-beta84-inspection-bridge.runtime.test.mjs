import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BETA84_REVISION, MAIN_AT_GATE_REVISION } from "./build-edge-beta84-inspection-bridge.mjs";

// Exercise the exact Wrangler-produced JavaScript. The sole test-only substitution
// provides Cloudflare's DurableObject base class, which Node cannot import.
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const edge = join(root, "services/mcp-edge-gateway");
const output = join(edge, ".wrangler/inspection-bridge/bundle/index.js");
const testModule = join(edge, ".wrangler/inspection-bridge/node-runtime/index.mjs");
const active = "39889807df9cb6f09fdb51a1940fce4783de302c1fd161f0429061a9a27e264c";
const token = "isolated-local-fixture-token";
const key = "edge:mcp-contract-rollout:v1";
const socketRuntime = {
  version: 1, connectorInstanceId: "11111111-1111-4111-8111-111111111111",
  connectionGeneration: 7, processStartedAt: "2026-10-10T12:00:00.000Z",
  catalogContractRevision: BETA84_REVISION, toolSetRevision: "c".repeat(64),
  toolCount: 93, serverVersion: "1.1.0-beta.84", nodePid: 123, hostPid: 456,
};
globalThis.WebSocket ??= { OPEN: 1, CLOSED: 3 };

class Storage {
  values = new Map();
  writes = [];
  async get(k) { return this.values.get(k); }
  async put(k, v) { this.writes.push(k); this.values.set(k, v); }
  async list() { return new Map(this.values); }
  async transaction(fn) { return fn(this); }
  set(k, v) { this.values.set(k, v); }
}

function setup(McpSession, { snapshot = "valid", socketState, socketRevision = BETA84_REVISION } = {}) {
  const storage = new Storage();
  const state = {
    version: 1, activeContractRevision: active,
    candidateContractRevision: BETA84_REVISION, preparedAt: "2026-10-08T03:27:40.414Z",
  };
  storage.set(key, state);
  storage.set("edge:unrelated", { preserved: true });
  if (snapshot !== "missing") {
    storage.set("edge:mcp-catalog:v1:" + active + ":header", {
      version: 1, contractRevision: snapshot === "wrong-revision" ? BETA84_REVISION : active, chunkCount: 1, toolCount: 1,
      catalogMetadata: { contractRevision: active, toolCount: 1 },
      serverIdentity: { name: "mcp-edge-gateway", version: "1.1.0-beta.83" },
    });
    if (snapshot !== "incomplete") storage.set("edge:mcp-catalog:v1:" + active + ":chunk:0", [
      { name: "legacy_tool", description: "historical tool", inputSchema: { type: "object" } },
    ]);
  }
  const socket = socketState === undefined ? null : {
    readyState: socketState,
    deserializeAttachment: () => ({
      role: "connector", ready: true, protocolVersion: 3,
      contractCompatible: true, runtime: { ...socketRuntime, catalogContractRevision: socketRevision },
    }),
  };
  const completed = [];
  const ctx = {
    storage,
    blockConcurrencyWhile(fn) { const promise = fn(); completed.push(promise); return promise; },
    getWebSockets(role) { return role === "connector" && socket ? [socket] : []; },
  };
  const session = new McpSession(ctx, {});
  let resolved = 0;
  const namespace = {
    idFromName() { return "named-do"; },
    get() { resolved++; return session; },
  };
  const env = {
    MCP_EDGE_ENABLED: "true",
    MCP_CONTRACT_PREPARE_TOKEN: token,
    MCP_CONNECTOR_TOKEN: "separate-connector-token",
    MCP_OWNER_TOKEN: "separate-owner-token",
    MCP_SESSION: namespace,
  };
  return { env, ctx, storage, state, completed, get resolved() { return resolved; }, session };
}

const ready = (async () => {
  execFileSync(process.execPath, [
    join(root, "tooling/release/build-edge-beta84-inspection-bridge.mjs"), "--dry-run",
  ], { cwd: root, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const produced = await readFile(output, "utf8");
  assert.ok(produced.includes(BETA84_REVISION), "real bundle lacks beta.84 revision");
  assert.ok(!produced.includes(MAIN_AT_GATE_REVISION), "real bundle includes main revision");
  assert.ok(produced.includes("bridge_operation_unavailable"), "bundle lacks bridge-only mutation guard");
  await mkdir(dirname(testModule), { recursive: true });
  await build({
    entryPoints: [output], outfile: testModule, bundle: true, format: "esm",
    platform: "node", target: "node22", logLevel: "silent",
    plugins: [{
      name: "cloudflare-base-class-shim",
      setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
          path: "cloudflare-base-class-shim", namespace: "test-only",
        }));
        builder.onLoad({ filter: /.*/, namespace: "test-only" }, () => ({
          contents: "export class DurableObject { constructor(ctx) { this.ctx = ctx; } }",
          loader: "js",
        }));
      },
    }],
  });
  return import(pathToFileURL(testModule).href);
})();

test("Wrangler-frozen worker: rejects new mutation paths before DO resolution", async () => {
  const { default: worker, McpSession } = await ready;
  const fixture = setup(McpSession);
  await Promise.all(fixture.completed);
  for (const path of ["/_internal/contract-rollout/bootstrap", "/_internal/contract-rollout/prepare"]) {
    for (const method of ["GET", "POST"]) {
      const response = await worker.fetch(new Request("https://edge.example" + path, {
        method, headers: { authorization: "Bearer " + token },
      }), fixture.env, {});
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "bridge_operation_unavailable" });
    }
  }
  assert.equal(fixture.resolved, 0);
  assert.deepEqual(fixture.storage.writes, []);
  // Existing beta.84 management route remains delegated and authenticated.
  const existing = await worker.fetch(new Request("https://edge.example/_internal/contract-rollout/promote", {
    method: "POST",
  }), fixture.env, {});
  assert.equal(existing.status, 401);
});

test("Wrangler-frozen worker: isolated auth, historical active/candidate, zero writes", async () => {
  const { default: worker, McpSession } = await ready;
  const fixture = setup(McpSession);
  await Promise.all(fixture.completed);
  const endpoint = "https://edge.example/_internal/contract-rollout/status";
  const unauthorized = await worker.fetch(new Request(endpoint, {
    headers: { authorization: "Bearer wrong-token" },
  }), fixture.env, {});
  assert.equal(unauthorized.status, 401);
  assert.equal(fixture.resolved, 0);
  const missingToken = await worker.fetch(new Request(endpoint), {
    ...fixture.env, MCP_CONTRACT_PREPARE_TOKEN: undefined,
  }, {});
  assert.equal(missingToken.status, 503);
  assert.equal(fixture.resolved, 0);
  const valid = await worker.fetch(new Request(endpoint, {
    headers: { authorization: "Bearer " + token },
  }), fixture.env, {});
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), {
    activeContractRevision: active,
    candidateContractRevision: BETA84_REVISION,
    candidateConnectorReady: false,
    preparedAt: fixture.state.preparedAt,
  });
  assert.deepEqual(fixture.storage.writes, []);
  assert.deepEqual(await fixture.storage.get(key), fixture.state);
  assert.deepEqual(await fixture.storage.get("edge:unrelated"), { preserved: true });
});

test("Wrangler-frozen worker: missing/incomplete active beta.83 snapshot fails closed without writes", async () => {
  const { default: worker, McpSession } = await ready;
  for (const snapshot of ["missing", "incomplete", "wrong-revision"]) {
    const fixture = setup(McpSession, { snapshot });
    await Promise.all(fixture.completed);
    const response = await worker.fetch(new Request(
      "https://edge.example/_internal/contract-rollout/status",
      { headers: { authorization: "Bearer " + token } },
    ), fixture.env, {});
    assert.equal(response.status, 200);
    assert.equal((await response.json()).activeContractRevision, active);
    assert.equal((await fixture.session.getStatus()).controlPlaneReady, false);
    const health = await worker.fetch(new Request("https://edge.example/health"), fixture.env, {});
    assert.equal(health.status, 503);
    assert.equal((await health.json()).expectedContractRevision, BETA84_REVISION);
    assert.deepEqual(fixture.storage.writes, []);
    assert.deepEqual(await fixture.storage.get(key), fixture.state);
  }
});

test("Wrangler-frozen worker: rehydrated matching WebSocket OPEN/CLOSED readiness", async () => {
  const { default: worker, McpSession } = await ready;
  for (const [socketState, socketRevision, expected] of [
    [WebSocket.OPEN, BETA84_REVISION, true],
    [WebSocket.CLOSED, BETA84_REVISION, false],
    [WebSocket.OPEN, active, false],
  ]) {
    const fixture = setup(McpSession, { socketState, socketRevision });
    await Promise.all(fixture.completed);
    const response = await worker.fetch(new Request(
      "https://edge.example/_internal/contract-rollout/status",
      { headers: { authorization: "Bearer " + token } },
    ), fixture.env, {});
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.candidateConnectorReady, expected);
    assert.deepEqual(fixture.storage.writes, []);
  }
});

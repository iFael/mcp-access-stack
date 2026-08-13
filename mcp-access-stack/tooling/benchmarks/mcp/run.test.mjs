import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  createFetchTimingRecorder,
  createLoopbackHttpFetch,
} from "./mcp-client.mjs";
import { validateBenchmarkConfig } from "./run.mjs";

test("validates a safe MCP benchmark configuration", () => {
  const previous = process.env.MCP_TEST_TOKEN;
  process.env.MCP_TEST_TOKEN = "x".repeat(32);
  try {
    assert.deepEqual(
      validateBenchmarkConfig({
        warmups: 1,
        samples: 2,
        routes: [{
          name: "local",
          url: "http://127.0.0.1:3300/mcp",
          tokenEnv: "MCP_TEST_TOKEN",
        }],
        scenarios: [{ name: "list", tool: "tools/list" }],
      }),
      {
        warmups: 1,
        samples: 2,
        outputDirectory: "runtime/benchmarks/mcp",
        routes: [{
          name: "local",
          url: "http://127.0.0.1:3300/mcp",
          token: "x".repeat(32),
        }],
        scenarios: [{
          name: "list",
          tool: "tools/list",
          enabled: true,
          args: {},
        }],
      },
    );
  } finally {
    if (previous === undefined) delete process.env.MCP_TEST_TOKEN;
    else process.env.MCP_TEST_TOKEN = previous;
  }
});

test("never accepts a missing token environment variable", () => {
  delete process.env.MCP_MISSING_TOKEN;
  assert.throws(() => validateBenchmarkConfig({
    routes: [{
      name: "local",
      url: "http://127.0.0.1:3300/mcp",
      tokenEnv: "MCP_MISSING_TOKEN",
    }],
    scenarios: [{ name: "list", tool: "tools/list" }],
  }), /MCP_MISSING_TOKEN/u);
});

test("records POST response-header latency for the active benchmark call", async () => {
  let resolveFetch;
  const recorder = createFetchTimingRecorder(() => new Promise((resolve) => {
    resolveFetch = resolve;
  }));
  const generation = recorder.beginCall();
  const pending = recorder.fetch("http://127.0.0.1/mcp", { method: "POST" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  resolveFetch(new Response("{}", { headers: { "content-type": "application/json" } }));
  await pending;

  const timing = recorder.readCallTiming(generation);
  assert.equal(Number.isFinite(timing?.fetchHeadersMs), true);
  assert.equal(timing.fetchHeadersMs >= 5, true);
});

test("ignores non-POST transport activity and isolates call generations", async () => {
  const recorder = createFetchTimingRecorder(async () => new Response("{}"));
  await recorder.fetch("http://127.0.0.1/mcp", { method: "GET" });
  const first = recorder.beginCall();
  await recorder.fetch("http://127.0.0.1/mcp", { method: "POST" });
  const second = recorder.beginCall();

  assert.equal(Number.isFinite(recorder.readCallTiming(first)?.fetchHeadersMs), true);
  assert.equal(recorder.readCallTiming(second), undefined);
});

test("reuses one loopback POST connection and isolates GET traffic", async () => {
  const ports = { GET: [], POST: [] };
  const server = createServer((request, response) => {
    const method = request.method === "GET" ? "GET" : "POST";
    ports[method].push(request.socket.remotePort);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.equal(typeof address, "object");
  const resource = createLoopbackHttpFetch(
    `http://127.0.0.1:${address.port}/mcp`,
  );
  try {
    for (let index = 0; index < 3; index += 1) {
      const response = await resource.fetch(
        `http://127.0.0.1:${address.port}/mcp`,
        { method: "POST", body: "{}" },
      );
      await response.json();
    }
    const getResponse = await resource.fetch(
      `http://127.0.0.1:${address.port}/mcp`,
      { method: "GET" },
    );
    await getResponse.json();

    assert.equal(new Set(ports.POST).size, 1);
    assert.equal(ports.POST.length, 3);
    assert.equal(ports.GET.length, 1);
    assert.notEqual(ports.POST[0], ports.GET[0]);
  } finally {
    resource.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

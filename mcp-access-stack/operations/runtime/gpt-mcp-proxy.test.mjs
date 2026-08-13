import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const proxyScript = fileURLToPath(new URL("./gpt-mcp-proxy.mjs", import.meta.url));

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

async function reservePort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function startProxy(environment) {
  const child = spawn(process.execPath, [proxyScript], {
    env: { ...process.env, MCP_PATH_ALIASES: "", ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const baseUrl = `http://127.0.0.1:${environment.PROXY_PORT}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Proxy exited during startup. stdout=${stdout} stderr=${stderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health/live`);
      if (response.ok) return { child, baseUrl, output: () => ({ stdout, stderr }) };
    } catch {
      // Retry until the child starts listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error(`Proxy startup timed out. stdout=${stdout} stderr=${stderr}`);
}

async function stopProxy(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("routes MCP traffic to TARGET_HOST and preserves MCP headers", async (t) => {
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.writeHead(201, {
      "content-type": "application/json",
      "mcp-session-id": request.headers["mcp-session-id"] ?? "",
      "x-last-event-id": request.headers["last-event-id"] ?? "",
    });
    response.end(JSON.stringify({ body: Buffer.concat(chunks).toString("utf8") }));
  });
  const targetPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(() => resolve())));

  const proxyPort = await reservePort();
  const proxy = await startProxy({
    PROXY_HOST: "127.0.0.1",
    PROXY_PORT: String(proxyPort),
    TARGET_HOST: "localhost",
    TARGET_PORT: String(targetPort),
    MCP_PATH: "/mcp-test",
  });
  t.after(() => stopProxy(proxy.child));

  const health = await fetch(`${proxy.baseUrl}/health/live`);
  assert.equal(health.status, 200);
  assert.match((await health.json()).target, new RegExp(`localhost:${targetPort}$`));

  const response = await fetch(`${proxy.baseUrl}/mcp-test?mode=stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "session-test",
      "last-event-id": "event-test",
    },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("mcp-session-id"), "session-test");
  assert.equal(response.headers.get("x-last-event-id"), "event-test");
  assert.deepEqual(await response.json(), { body: JSON.stringify({ ok: true }) });
  assert.ok(response.headers.get("x-mcp-proxy-request-id"));
});

test("returns a sanitized 502 when the upstream is unavailable", async (t) => {
  const proxyPort = await reservePort();
  const unavailablePort = await reservePort();
  const proxy = await startProxy({
    PROXY_HOST: "127.0.0.1",
    PROXY_PORT: String(proxyPort),
    TARGET_HOST: "127.0.0.1",
    TARGET_PORT: String(unavailablePort),
    MCP_PATH: "/mcp-test",
  });
  t.after(() => stopProxy(proxy.child));

  const response = await fetch(`${proxy.baseUrl}/mcp-test`, {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "bad_gateway" });
});

test("returns a structured 504 when the upstream response deadline expires", async (t) => {
  const upstream = createServer((request, response) => {
    request.once("aborted", () => response.destroy());
  });
  const targetPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(() => resolve())));

  const proxyPort = await reservePort();
  const proxy = await startProxy({
    PROXY_HOST: "127.0.0.1",
    PROXY_PORT: String(proxyPort),
    TARGET_HOST: "127.0.0.1",
    TARGET_PORT: String(targetPort),
    MCP_PATH: "/mcp-test",
    PROXY_UPSTREAM_RESPONSE_TIMEOUT_MS: "25",
  });
  t.after(() => stopProxy(proxy.child));

  const response = await fetch(proxy.baseUrl + "/mcp-test", {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), {
    error: "upstream_timeout",
    reason: "upstream_timeout",
    terminatedBy: "proxy",
  });
});

test("keeps the native loopback defaults", async (t) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  upstream.listen(3410, "127.0.0.1");
  await once(upstream, "listening");
  t.after(() => new Promise((resolve) => upstream.close(() => resolve())));

  const proxyPort = await reservePort();
  const proxy = await startProxy({
    PROXY_PORT: String(proxyPort),
    MCP_PATH: "/mcp-default-test",
  });
  t.after(() => stopProxy(proxy.child));

  const response = await fetch(`${proxy.baseUrl}/mcp-default-test`, { method: "POST" });
  assert.equal(response.status, 204);
});
test("rewrites configured MCP path aliases to the canonical upstream route", async (t) => {
  let observedUrl = null;
  const upstream = createServer((request, response) => {
    observedUrl = request.url;
    response.writeHead(204);
    response.end();
  });
  const targetPort = await listen(upstream);
  t.after(() => new Promise((resolve) => upstream.close(() => resolve())));

  const proxyPort = await reservePort();
  const proxy = await startProxy({
    PROXY_HOST: "127.0.0.1",
    PROXY_PORT: String(proxyPort),
    TARGET_HOST: "127.0.0.1",
    TARGET_PORT: String(targetPort),
    MCP_PATH: "/mcp",
    MCP_PATH_ALIASES: "/mcp-legacy-test,/mcp-old-test",
  });
  t.after(() => stopProxy(proxy.child));

  const health = await fetch(`${proxy.baseUrl}/health/live`);
  assert.equal((await health.json()).aliasCount, 2);

  const response = await fetch(`${proxy.baseUrl}/mcp-legacy-test/tools?mode=stream`, {
    method: "POST",
  });
  assert.equal(response.status, 204);
  assert.equal(observedUrl, "/mcp/tools?mode=stream");

  const rejected = await fetch(`${proxy.baseUrl}/mcp-legacy-testing`, { method: "POST" });
  assert.equal(rejected.status, 404);
});

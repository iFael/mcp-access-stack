import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const orchestratorDist = path.join(repositoryRoot, "services/oracle-release-orchestrator/dist");
const serverEntry = path.join(orchestratorDist, "server.js");
const connectorEntry = path.join(orchestratorDist, "oracle-channel-connector-server.js");

function startNode(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const state = { finished: false, result: undefined };
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => {
    state.finished = true;
    state.result = { code, signal, stdout, stderr };
    resolve(state.result);
  }));
  return { child, state, exited, output: () => ({ stdout, stderr }) };
}

async function waitForChildValue(processState, predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processState.state.finished) {
      throw new Error(`${label} exited early: ${JSON.stringify(processState.state.result)}`);
    }
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} did not reach the expected state`);
}

async function stopChild(processState) {
  if (processState.state.finished) return processState.state.result;
  processState.child.kill("SIGTERM");
  const result = await settleWithin(processState.exited, 3_000);
  if (result) return result;
  processState.child.kill("SIGKILL");
  await processState.exited;
  throw new Error("entrypoint did not stop after SIGTERM");
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  const result = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  return result;
}

async function unusedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function createLinks(directory) {
  await symlink(serverEntry, path.join(directory, "server-via-link.js"));
  await symlink(connectorEntry, path.join(directory, "connector-via-link.js"));
  return {
    server: path.join(directory, "server-via-link.js"),
    connector: path.join(directory, "connector-via-link.js"),
  };
}

test("read API main starts and stays alive when invoked through a symlink", async () => {
  assert.ok(existsSync(serverEntry), "build the Oracle release orchestrator before this test");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oracle-entrypoint-server-"));
  const links = path.join(root, "links");
  await mkdir(links);
  const link = path.join(links, "server-via-link.js");
  await symlink(serverEntry, link);
  const port = await unusedLoopbackPort();
  const token = "synthetic-read-api-token-".padEnd(48, "x");
  const processState = startNode([link], {
    ORCHESTRATOR_LEDGER_PATH: path.join(root, "state", "orchestrator.sqlite"),
    ORCHESTRATOR_RELEASE_ROOT: path.join(root, "release-root"),
    ORCHESTRATOR_READ_API_PORT: String(port),
    UPDATE_CONTROL_ORCHESTRATOR_TOKEN: token,
  });

  try {
    const response = await waitForChildValue(processState, async () => {
      try {
        return await fetch(`http://127.0.0.1:${port}/internal/v1/runs?limit=1`, {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(500),
        });
      } catch {
        return null;
      }
    }, "read API");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { runs: [], nextCursor: null, hasMore: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processState.state.finished, false, "read API process should remain alive");
    const stopped = await stopChild(processState);
    assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 0, signal: null });
  } finally {
    if (!processState.state.finished) {
      processState.child.kill("SIGKILL");
      await processState.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("connector main starts and stays alive through a symlink with an in-memory fake socket", async () => {
  assert.ok(existsSync(connectorEntry), "build the Oracle release orchestrator before this test");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oracle-entrypoint-connector-"));
  const links = path.join(root, "links");
  await mkdir(links);
  const link = path.join(links, "connector-via-link.js");
  await symlink(connectorEntry, link);

  const channelTokenPath = path.join(root, "channel-token");
  const readApiTokenPath = path.join(root, "read-api-token");
  const markerPath = path.join(root, "fake-socket-opened");
  await writeFile(channelTokenPath, "c".repeat(48), { mode: 0o600 });
  await writeFile(readApiTokenPath, "r".repeat(48), { mode: 0o600 });
  await chmod(channelTokenPath, 0o600);
  await chmod(readApiTokenPath, 0o600);

  const fakeWsPath = path.join(root, "fake-ws.mjs");
  const loaderPath = path.join(root, "fake-ws-loader.mjs");
  await writeFile(fakeWsPath, `import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  keepAlive;
  constructor() {
    super();
    this.keepAlive = setInterval(() => {}, 60_000);
    writeFileSync(process.env.MCP_TEST_SOCKET_MARKER, "opened");
    setImmediate(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return;
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open");
    });
  }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    clearInterval(this.keepAlive);
    setImmediate(() => this.emit("close", 1000, Buffer.alloc(0), true));
  }
  terminate() {
    this.close();
  }
  send() {}
}
export default FakeWebSocket;
`);
  await writeFile(loaderPath, `export async function resolve(specifier, context, nextResolve) {
  if (specifier === "ws") {
    return { url: new URL("./fake-ws.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`);

  const processState = startNode([link], {
    NODE_OPTIONS: `--loader=${loaderPath}`,
    UPDATE_CONTROL_ORACLE_CHANNEL_URL:
      "wss://mcp-v3-update-control.mcp-v3-update-control.workers.dev/_internal/oracle-channel",
    UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: channelTokenPath,
    UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: readApiTokenPath,
    MCP_TEST_SOCKET_MARKER: markerPath,
  });

  try {
    await waitForChildValue(processState, async () => existsSync(markerPath), "connector fake socket");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(processState.state.finished, false, "connector process should remain alive");
    const { stdout, stderr } = processState.output();
    assert.doesNotMatch(stdout + stderr, /c{16}|r{16}/u, "synthetic credentials must not be logged");
    const stopped = await stopChild(processState);
    assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 0, signal: null });
  } finally {
    if (!processState.state.finished) {
      processState.child.kill("SIGKILL");
      await processState.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("importing either entrypoint through a symlink does not start it", async () => {
  assert.ok(existsSync(serverEntry) && existsSync(connectorEntry),
    "build the Oracle release orchestrator before this test");
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oracle-entrypoint-import-"));
  const links = path.join(root, "links");
  await mkdir(links);
  const entryLinks = await createLinks(links);
  const importer = path.join(root, "import-entrypoint.mjs");
  await writeFile(importer, 'await import(process.env.MCP_TEST_ENTRYPOINT_URL);\n');

  try {
    for (const [name, link] of Object.entries(entryLinks)) {
      const processState = startNode([importer], {
        MCP_TEST_ENTRYPOINT_URL: pathToFileURL(link).href,
      });
      const result = await settleWithin(processState.exited, 2_000);
      if (!result) {
        processState.child.kill("SIGKILL");
        await processState.exited;
        assert.fail(`${name} started while imported`);
      }
      assert.equal(result.code, 0, `${name} import should not start the service: ${result.stderr}`);
      assert.match(result.stdout, /^$/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connector main fails closed when invoked through a symlink without config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-oracle-entrypoint-connector-invalid-"));
  const link = path.join(root, "connector-via-link.js");
  await symlink(connectorEntry, link);
  const processState = startNode([link], {
    UPDATE_CONTROL_ORACLE_CHANNEL_URL: "",
    UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: "",
    UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: "",
  });
  try {
    const result = await settleWithin(processState.exited, 2_000);
    if (!result) {
      processState.child.kill("SIGKILL");
      await processState.exited;
      assert.fail("connector main did not fail closed within the expected time");
    }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /configuration is unavailable or invalid/u);
  } finally {
    if (!processState.state.finished) {
      processState.child.kill("SIGKILL");
      await processState.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

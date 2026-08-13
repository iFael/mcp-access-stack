import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  McpBenchmarkClient,
  readMcpBenchmarkClientTiming,
} from "../mcp/mcp-client.mjs";

const SOURCE_HASH_PATHS = [
  "package.json",
  "package-lock.json",
  "deploy/docker/gateway.Dockerfile",
  "packages/mcp-core",
  "services/browser-worker",
  "services/mcp-gateway",
  "tooling/benchmarks/browser",
];
const BUILD_HASH_PATHS = [
  "packages/mcp-core/dist",
  "services/browser-worker/dist",
  "services/mcp-gateway/dist",
];
const BENCHMARK_SOURCE_LABEL =
  "com.openai.mcp.flow-benchmark.source-sha256";

export class BrowserBenchmarkOperationError extends Error {
  constructor(operation, code, message, statusCode, benchmarkTransport = undefined) {
    super(`${operation} failed: ${code}: ${message}`);
    this.name = "BrowserBenchmarkOperationError";
    this.operation = operation;
    this.code = code;
    this.statusCode = statusCode;
    this.benchmarkTransport = benchmarkTransport;
  }
}

export async function startIsolatedBrowserWorker(options) {
  const root = path.resolve(options.root);
  const label = options.label;
  await assertBuilt(root, "services/browser-worker/dist/server.js", `${label} Browser Worker`);
  const port = await findAvailablePort();
  const token = randomBytes(32).toString("hex");
  const privateDirectory = path.join(options.scratchDirectory, label, "private");
  const runtimeDirectory = path.join(options.scratchDirectory, label, "runtime");
  const profileDirectory = path.join(privateDirectory, "profile");
  await Promise.all([
    mkdir(privateDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);
  await prepareIsolatedBenchmarkProfile({
    sourceDirectory: options.profileDirectory,
    destinationDirectory: profileDirectory,
  });
  const managed = spawnManagedProcess({
    label: `${label} Browser Worker`,
    command: process.execPath,
    args: [path.join(root, "services", "browser-worker", "dist", "server.js")],
    cwd: root,
    env: {
      ...process.env,
      BROWSER_WORKER_PORT: String(port),
      BROWSER_WORKER_TOKEN: token,
      BROWSER_WORKER_MODE: "interactive",
      BROWSER_WORKER_PROFILE_MODE: "persistent",
      ...(options.browserChannel
        ? { BROWSER_WORKER_BROWSER_CHANNEL: options.browserChannel }
        : {}),
      BROWSER_WORKER_USER_DATA_DIR: profileDirectory,
      BROWSER_WORKER_RUNTIME_DIR: runtimeDirectory,
      BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
      BROWSER_WORKER_CONNECT_TIMEOUT_MS: "120000",
      BROWSER_WORKER_OPERATION_TIMEOUT_MS: "120000",
      BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "120000",
    },
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health/live`, managed, 90_000);
  } catch (error) {
    await managed.close();
    throw error;
  }
  return {
    label,
    root,
    port,
    token,
    profileDirectory,
    call: createDetailedBrowserWorkerClient({ port, token }),
    close: managed.close,
  };
}

export async function prepareIsolatedBenchmarkProfile(options) {
  const destinationDirectory = path.resolve(options.destinationDirectory);
  await rm(destinationDirectory, { recursive: true, force: true });
  await mkdir(path.dirname(destinationDirectory), { recursive: true });
  if (!options.sourceDirectory) {
    await mkdir(destinationDirectory, { recursive: true });
    return {
      sourceDirectory: null,
      destinationDirectory,
      copied: false,
    };
  }

  const sourceDirectory = path.resolve(options.sourceDirectory);
  if (sourceDirectory === destinationDirectory) {
    throw new Error("Benchmark profile source and destination must be distinct.");
  }
  const sourceStatus = await stat(sourceDirectory).catch(() => undefined);
  if (!sourceStatus?.isDirectory()) {
    throw new Error(`Benchmark profile directory is unavailable: ${sourceDirectory}`);
  }

  await cp(sourceDirectory, destinationDirectory, {
    recursive: true,
    force: true,
    errorOnExist: false,
    filter: (sourcePath) => shouldCopyBenchmarkProfileEntry(sourceDirectory, sourcePath),
  });
  return {
    sourceDirectory,
    destinationDirectory,
    copied: true,
  };
}

function shouldCopyBenchmarkProfileEntry(sourceDirectory, sourcePath) {
  const relative = path.relative(sourceDirectory, sourcePath);
  if (relative.length === 0) return true;
  const topLevel = relative.split(path.sep)[0];
  return !new Set([
    "DevToolsActivePort",
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    "lockfile",
  ]).has(topLevel);
}

export async function startIsolatedGateway(options) {
  const mode = options.mode ?? "docker";
  if (mode === "process") return startIsolatedProcessGateway(options);
  if (mode !== "docker") throw new Error(`Unsupported benchmark gateway mode: ${mode}.`);
  return startIsolatedDockerGateway(options);
}

async function startIsolatedProcessGateway(options) {
  const root = path.resolve(options.root);
  await assertBuilt(root, "services/mcp-gateway/dist/server.js", "candidate MCP gateway");
  const port = await findAvailablePort();
  const mcpPath = "/mcp-benchmark";
  const managed = spawnManagedProcess({
    label: "candidate MCP gateway",
    command: process.execPath,
    args: [path.join(root, "services", "mcp-gateway", "dist", "server.js")],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      AUTH_MODE: "none",
      MCP_PATH: mcpPath,
      AGENT_ID: "benchmark-isolated",
      AGENT_TOKEN_SHA256: "0".repeat(64),
      AGENT_REQUEST_TIMEOUT_MS: "120000",
      AGENT_MAX_CONCURRENCY: "4",
      RATE_LIMIT_MAX: "100000",
      LOG_LEVEL: "error",
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: `http://127.0.0.1:${options.worker.port}`,
      BROWSER_WORKER_TOKEN: options.worker.token,
      BROWSER_WORKER_TIMEOUT_MS: "120000",
      BROWSER_WORKER_MAX_PAYLOAD_BYTES: String(16 * 1024 * 1024),
    },
  });
  try {
    await waitForHealth(`http://127.0.0.1:${port}/health/live`, managed, 30_000);
  } catch (error) {
    await managed.close();
    throw error;
  }
  return createGatewayClientHandle({
    port,
    mcpPath,
    provenance: {
      mode: "host-process",
      image: null,
      imageId: null,
      mcpServerLifecycle: "per-request-stateless-fallback",
      legacyBrowserFastPath: "json-rpc-v1",
      benchmarkTiming: "opt-in-header",
    },
    closeRuntime: managed.close,
  });
}

async function startIsolatedDockerGateway(options) {
  const root = path.resolve(options.root);
  const port = await findAvailablePort();
  const mcpPath = "/mcp-benchmark";
  const relay = await startDockerHostRelay(options.worker.port);
  const sourceHash = await hashSourceTree(root);
  const image = `mcp-access-stack/gateway:flow-benchmark-${sourceHash.slice(0, 16)}`;
  const containerName =
    `mcp-browser-flow-${process.pid}-${randomBytes(5).toString("hex")}`;
  const networkName =
    `mcp-browser-flow-net-${process.pid}-${randomBytes(5).toString("hex")}`;
  const privateDirectory = path.resolve(
    options.scratchDirectory ??
      path.join(options.worker.profileDirectory, "..", "gateway-private"),
  );
  const environmentPath = path.join(privateDirectory, "docker.env");
  let managed;
  let networkCreated = false;
  try {
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(environmentPath, [
      "NODE_ENV=test",
      "PORT=3310",
      "PUBLIC_BASE_URL=http://127.0.0.1:3310",
      "AUTH_MODE=none",
      `MCP_PATH=${mcpPath}`,
      "AGENT_ID=benchmark-isolated",
      `AGENT_TOKEN_SHA256=${"0".repeat(64)}`,
      "AGENT_REQUEST_TIMEOUT_MS=120000",
      "AGENT_MAX_CONCURRENCY=4",
      "RATE_LIMIT_MAX=100000",
      "LOG_LEVEL=error",
      "BROWSER_WORKER_ENABLED=true",
      "BROWSER_WORKER_ALLOW_DOCKER_HOST=true",
      `BROWSER_WORKER_URL=http://host.docker.internal:${relay.port}`,
      `BROWSER_WORKER_TOKEN=${options.worker.token}`,
      "BROWSER_WORKER_TIMEOUT_MS=120000",
      `BROWSER_WORKER_MAX_PAYLOAD_BYTES=${16 * 1024 * 1024}`,
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    let imageSummary = await inspectBenchmarkImage(image, root);
    const imageReused = imageSummary?.sourceHash === sourceHash;
    if (!imageReused) {
      await runProcess("docker", [
        "build",
        "--file",
        "deploy/docker/gateway.Dockerfile",
        "--label",
        `${BENCHMARK_SOURCE_LABEL}=${sourceHash}`,
        "--tag",
        image,
        ".",
      ], root);
      imageSummary = await inspectBenchmarkImage(image, root);
    }
    if (!imageSummary || imageSummary.sourceHash !== sourceHash) {
      throw new Error("Benchmark gateway image provenance does not match the source tree.");
    }
    const imageId = imageSummary.imageId;
    await runProcess(
      "docker",
      ["network", "create", "--driver", "bridge", networkName],
      root,
    );
    networkCreated = true;
    managed = spawnManagedProcess({
      label: "candidate Docker MCP gateway",
      command: "docker",
      args: [
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        networkName,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--publish",
        `127.0.0.1:${port}:3310`,
        "--env-file",
        environmentPath,
        image,
      ],
      cwd: root,
      env: process.env,
    });
    await waitForHealth(
      `http://127.0.0.1:${port}/health/live`,
      managed,
      60_000,
    );
    await rm(environmentPath, { force: true });
    return createGatewayClientHandle({
      port,
      mcpPath,
      provenance: {
        mode: "docker",
        image,
        imageId,
        sourceTreeSha256: sourceHash,
        imageReused,
        mcpServerLifecycle: "per-request-stateless-fallback",
        legacyBrowserFastPath: "json-rpc-v1",
        benchmarkTiming: "opt-in-header",
        containerName,
        networkName,
        workerRelayPort: relay.port,
      },
      closeRuntime: async () => {
        await stopBenchmarkContainer(containerName, root);
        await managed?.close();
        await stopBenchmarkNetwork(networkName, root);
        await relay.close();
      },
    });
  } catch (error) {
    await rm(environmentPath, { force: true });
    if (managed) await stopBenchmarkContainer(containerName, root);
    await managed?.close().catch(() => undefined);
    if (networkCreated) await stopBenchmarkNetwork(networkName, root);
    await relay.close();
    throw error;
  }
}

function createGatewayClientHandle({ port, mcpPath, provenance, closeRuntime }) {
  const client = new McpBenchmarkClient({
    name: "candidate-isolated-gateway",
    url: `http://127.0.0.1:${port}${mcpPath}`,
    timeoutMs: 125_000,
    headers: { "x-mcp-benchmark-timing": "1" },
  });
  return {
    port,
    url: `http://127.0.0.1:${port}${mcpPath}`,
    provenance,
    call: async (operation, input) => {
      const startedAt = performance.now();
      const result = await client.callTool(`browser_${camelToSnake(operation)}`, input);
      const elapsedMs = round(performance.now() - startedAt);
      const gatewayTiming = enrichGatewayTiming(
        result?._meta?.["com.openai.gateway/timing"],
        elapsedMs,
        readMcpBenchmarkClientTiming(result),
      );
      if (result?.isError) {
        const text = toolText(result);
        const match = /^([A-Z0-9_]+):\s*(.*)$/su.exec(text);
        throw new BrowserBenchmarkOperationError(
          operation,
          match?.[1] ?? "MCP_TOOL_ERROR",
          match?.[2] ?? text,
          200,
          {
            elapsedMs,
            responseBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
            route: result?._meta?.["com.openai.gateway/route"] ?? "generic-mcp-server",
            gatewayTiming,
          },
        );
      }
      if (!result?.structuredContent) {
        throw new BrowserBenchmarkOperationError(
          operation,
          "MCP_PROTOCOL_ERROR",
          "Gateway tool returned no structuredContent.",
          200,
        );
      }
      return Object.assign(result.structuredContent, {
        __benchmarkTransport: {
          elapsedMs,
          responseBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
          route: result?._meta?.["com.openai.gateway/route"] ?? "generic-mcp-server",
          gatewayTiming,
        },
      });
    },
    close: async () => {
      await client.close().catch(() => undefined);
      await closeRuntime();
    },
  };
}

export function enrichGatewayTiming(value, clientElapsedMs, clientTiming) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const serverBeforeWriteMs = Number(value.serverBeforeWriteMs ?? 0);
  const fetchHeadersMs = Number(clientTiming?.fetchHeadersMs);
  const hasServerTiming = Number.isFinite(serverBeforeWriteMs);
  const hasHeaderTiming = hasServerTiming && Number.isFinite(fetchHeadersMs);
  return {
    ...value,
    clientElapsedMs,
    clientResidualMs: hasServerTiming
      ? round(Math.max(0, clientElapsedMs - serverBeforeWriteMs))
      : null,
    clientHeadersElapsedMs: Number.isFinite(fetchHeadersMs)
      ? round(fetchHeadersMs)
      : null,
    clientHeadersResidualMs: hasHeaderTiming
      ? round(Math.max(0, fetchHeadersMs - serverBeforeWriteMs))
      : null,
    clientSdkResidualMs: Number.isFinite(fetchHeadersMs)
      ? round(Math.max(0, clientElapsedMs - fetchHeadersMs))
      : null,
  };
}

async function startDockerHostRelay(targetPort) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    const upstream = net.createConnection({
      host: "127.0.0.1",
      port: targetPort,
    });
    sockets.add(upstream);
    socket.pipe(upstream);
    upstream.pipe(socket);
    const closePair = () => {
      sockets.delete(socket);
      sockets.delete(upstream);
      socket.destroy();
      upstream.destroy();
    };
    socket.once("error", closePair);
    upstream.once("error", closePair);
    socket.once("close", closePair);
    upstream.once("close", closePair);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeNetServer(server);
    throw new Error("Docker Browser Worker relay did not bind to a TCP port.");
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await closeNetServer(server);
    },
  };
}

async function inspectBenchmarkImage(image, root) {
  try {
    const raw = await runProcess(
      "docker",
      ["image", "inspect", image],
      root,
    );
    const details = JSON.parse(raw)?.[0];
    const imageId = details?.Id;
    const sourceHash = details?.Config?.Labels?.[BENCHMARK_SOURCE_LABEL];
    if (typeof imageId !== "string") return undefined;
    return {
      imageId,
      sourceHash: typeof sourceHash === "string" ? sourceHash : undefined,
    };
  } catch {
    return undefined;
  }
}
async function stopBenchmarkContainer(containerName, root) {
  if (!/^mcp-browser-flow-\d+-[a-f0-9]{10}$/u.test(containerName)) {
    throw new Error("Refusing to stop a container outside the benchmark namespace.");
  }
  await runProcess("docker", ["stop", "--time", "20", containerName], root)
    .catch(() => undefined);
  await runProcess("docker", ["rm", "--force", containerName], root)
    .catch(() => undefined);
}

async function stopBenchmarkNetwork(networkName, root) {
  if (!/^mcp-browser-flow-net-\d+-[a-f0-9]{10}$/u.test(networkName)) {
    throw new Error("Refusing to remove a network outside the benchmark namespace.");
  }
  await runProcess("docker", ["network", "rm", networkName], root)
    .catch(() => undefined);
}

function closeNetServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function createDetailedBrowserWorkerClient({ port, token }) {
  return async (operation, input) => {
    const startedAt = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/operations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-mcp-call-id": `flow-${Date.now()}-${randomBytes(6).toString("hex")}`,
      },
      body: JSON.stringify({ operation, input }),
      signal: AbortSignal.timeout(120_000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let body;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new BrowserBenchmarkOperationError(
        operation,
        "INVALID_JSON",
        "Browser Worker returned invalid JSON.",
        response.status,
      );
    }
    if (!response.ok || body?.ok !== true) {
      throw new BrowserBenchmarkOperationError(
        operation,
        body?.error?.code ?? `HTTP_${response.status}`,
        body?.error?.message ?? "Browser Worker operation failed.",
        response.status,
      );
    }
    return Object.assign(body.result, {
      __benchmarkTransport: {
        elapsedMs: round(performance.now() - startedAt),
        responseBytes: bytes.byteLength,
      },
    });
  };
}

export async function sourceSummary(root) {
  const resolvedRoot = path.resolve(root);
  const browserPackage = JSON.parse(
    await readFile(path.join(resolvedRoot, "services", "browser-worker", "package.json"), "utf8"),
  );
  const [chromium, git, sourceTreeSha256, build] = await Promise.all([
    playwrightChromiumSummary(resolvedRoot),
    gitSummary(resolvedRoot),
    hashSourceTree(resolvedRoot),
    buildSummary(resolvedRoot),
  ]);
  return {
    root: resolvedRoot,
    browserWorkerVersion: browserPackage.version,
    playwrightVersion: browserPackage.dependencies?.playwright ?? null,
    chromiumRevision: chromium?.revision ?? null,
    chromiumVersion: chromium?.browserVersion ?? null,
    ...git,
    sourceTreeSha256,
    build,
  };
}

export async function assertOfficialSource(summary, label) {
  if (!summary.commit) throw new Error(`Official ${label} source must be a Git checkout.`);
  if (summary.dirty !== false) throw new Error(`Official ${label} source tree must be clean.`);
  if (!/^[a-f0-9]{40}$/u.test(summary.commit)) {
    throw new Error(`Official ${label} commit must be immutable.`);
  }
}

export async function prepareOfficialSource(root, label) {
  const resolvedRoot = path.resolve(root);
  const before = await sourceSummary(resolvedRoot);
  await assertOfficialSource(before, label);
  const startedAt = performance.now();
  await runNpmBuild(resolvedRoot);
  const after = await sourceSummary(resolvedRoot);
  await assertOfficialSource(after, label);
  if (after.commit !== before.commit) {
    throw new Error(`Official ${label} commit changed while rebuilding benchmark artifacts.`);
  }
  if (after.sourceTreeSha256 !== before.sourceTreeSha256) {
    throw new Error(`Official ${label} source tree changed while rebuilding benchmark artifacts.`);
  }
  if (after.build.status !== "present" || after.build.fileCount < 1 || !after.build.sha256) {
    throw new Error(`Official ${label} build did not produce the required dist artifacts.`);
  }
  return {
    ...after,
    build: {
      ...after.build,
      verification: "rebuilt-from-clean-source",
      command: "npm run build",
      verifiedAt: new Date().toISOString(),
      durationMs: round(performance.now() - startedAt),
    },
  };
}

export function machineSummary() {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  };
}

export async function vscodeSummary() {
  const cliPath = process.env.VSCODE_CLI_PATH ??
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Programs",
      "Microsoft VS Code",
      "bin",
      "code.cmd",
    );
  const cliSource = await readFile(cliPath, "utf8");
  const installMatch = /\\([^\\"]+)\\resources\\app\\out\\cli\.js/iu.exec(cliSource);
  if (!installMatch) throw new Error(`Unable to resolve VS Code build from ${cliPath}.`);
  const installDirectory = path.resolve(path.dirname(cliPath), "..", installMatch[1]);
  const [packageJson, productJson] = await Promise.all([
    "package.json",
    "product.json",
  ].map(async (file) =>
    JSON.parse(await readFile(path.join(installDirectory, "resources", "app", file), "utf8"))
  ));
  return {
    version: packageJson.version,
    commit: productJson.commit,
    architecture: process.arch,
  };
}

export async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Unable to allocate a benchmark port."));
      });
    });
  });
}

function spawnManagedProcess({ label, command, args, cwd, env }) {
  const stderr = [];
  const child = spawn(command, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
    env,
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 80) stderr.shift();
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let closed = false;
  return {
    label,
    child,
    stderr,
    close: async () => {
      if (closed) return;
      closed = true;
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([
        exited,
        new Promise((resolve) => setTimeout(resolve, 20_000)),
      ]);
      if (child.exitCode === null) child.kill();
    },
  };
}

async function waitForHealth(url, managed, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (managed.child.exitCode !== null) {
      throw new Error(
        `${managed.label} exited during startup: ${managed.stderr.join("").slice(-4_000)}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Continue until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `${managed.label} did not become healthy: ${managed.stderr.join("").slice(-4_000)}`,
  );
}

async function assertBuilt(root, relativePath, label) {
  try {
    await readFile(path.join(root, relativePath), "utf8");
  } catch {
    throw new Error(`${label} is not built at ${root}.`);
  }
}

async function gitSummary(root) {
  try {
    const topLevel = (await runProcess("git", ["rev-parse", "--show-toplevel"], root)).trim();
    if (!topLevel) return { commit: null, dirty: null };
    const commit = (await runProcess("git", ["rev-parse", "HEAD"], root)).trim();
    const status = await runProcess("git", ["status", "--porcelain", "--", "."], root);
    return { commit, dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

function runNpmBuild(cwd) {
  if (process.platform === "win32") {
    return runProcess(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", "npm.cmd run build"],
      cwd,
    );
  }
  return runProcess("npm", ["run", "build"], cwd);
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} failed (${code}): ${stderr}`));
    });
  });
}

async function buildSummary(root) {
  const files = [];
  const missingPaths = [];
  for (const relative of BUILD_HASH_PATHS) {
    const target = path.join(root, relative);
    const details = await stat(target).catch(() => undefined);
    if (!details) {
      missingPaths.push(relative);
      continue;
    }
    if (details.isDirectory()) await collectFiles(target, root, files);
    else if (details.isFile()) files.push(relative);
  }
  files.sort((left, right) => left.localeCompare(right));
  if (missingPaths.length > 0 || files.length === 0) {
    return {
      status: "missing",
      sha256: null,
      fileCount: files.length,
      missingPaths,
    };
  }
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return {
    status: "present",
    sha256: hash.digest("hex"),
    fileCount: files.length,
    missingPaths: [],
  };
}

async function hashSourceTree(root) {
  const files = [];
  for (const relative of SOURCE_HASH_PATHS) {
    await collectFiles(path.join(root, relative), root, files);
  }
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const relative of files) {
    hash.update(relative.replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(await readFile(path.join(root, relative)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function playwrightChromiumSummary(root) {
  try {
    const parsed = JSON.parse(await readFile(
      path.join(root, "node_modules", "playwright-core", "browsers.json"),
      "utf8",
    ));
    const chromium = parsed?.browsers?.find((browser) => browser?.name === "chromium");
    if (!chromium) return undefined;
    return {
      revision: String(chromium.revision),
      browserVersion: String(chromium.browserVersion),
    };
  } catch {
    return undefined;
  }
}

async function collectFiles(target, root, files) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    files.push(path.relative(root, target));
    return;
  }
  for (const entry of entries) {
    if (["node_modules", "dist", "coverage", "runtime"].includes(entry.name)) continue;
    const absolute = path.join(target, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, root, files);
    else if (entry.isFile()) files.push(path.relative(root, absolute));
  }
}

function camelToSnake(value) {
  return value.replace(/[A-Z]/gu, (match) => `_${match.toLocaleLowerCase("en-US")}`);
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

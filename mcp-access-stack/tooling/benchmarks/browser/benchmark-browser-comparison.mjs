import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpBenchmarkClient } from "../mcp/mcp-client.mjs";
import {
  createBrowserWorkerClient,
  startBenchmarkSite,
  summarizeOperationBenchmark,
} from "./benchmark-browser-fast-path.mjs";

const DEFAULT_ITERATIONS = 10;
const DEFAULT_WARMUPS = 3;
const OUTPUT_ROOT = path.join("runtime", "benchmarks", "browser");
const SOURCE_HASH_PATHS = [
  "package.json",
  "package-lock.json",
  "packages/mcp-core",
  "services/browser-worker",
  "tooling/benchmarks/browser",
];

export async function runBrowserComparison(options) {
  const candidateRoot = path.resolve(options.candidateRoot ?? process.cwd());
  const previousRoot = path.resolve(required(options.previousRoot, "previousRoot"));
  const iterations = positiveInteger(options.iterations ?? DEFAULT_ITERATIONS, "iterations", 1_000);
  const warmupIterations = positiveInteger(
    options.warmupIterations ?? DEFAULT_WARMUPS,
    "warmupIterations",
    200,
  );
  await assertBuiltWorker(candidateRoot, "candidate");
  await assertBuiltWorker(previousRoot, "previous");

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDirectory = path.resolve(candidateRoot, OUTPUT_ROOT, runId);
  const scratchDirectory = path.join(outputDirectory, "scratch");
  await mkdir(scratchDirectory, { recursive: true });
  const site = await startBenchmarkSite();
  const measurements = {};
  const executionOrder = ["previous", "candidate", "vscode"];
  try {
    measurements.previous = await withWorker({
      label: "previous",
      root: previousRoot,
      scratchDirectory,
      browserChannel: undefined,
      run: (call) => measurePreviousEngine({
        call,
        url: site.url,
        iterations,
        warmupIterations,
      }),
    });
    measurements.candidate = await withWorker({
      label: "candidate",
      root: candidateRoot,
      scratchDirectory,
      browserChannel: "chromium",
      run: (call) => measureCandidateEngine({
        call,
        url: site.url,
        iterations,
        warmupIterations,
      }),
    });
    measurements.vscode = await measureVsCode({
      url: site.url,
      iterations,
      warmupIterations,
      runtimePath: options.vscodeRuntimePath,
      requestedPageId: options.vscodePageId,
    });
  } finally {
    await site.close();
  }

  const candidateP95 = measurements.candidate.actionState.p95Ms;
  const previousP95 = measurements.previous.actionState.p95Ms;
  const vscodeP95 = measurements.vscode.actionState.p95Ms;
  const report = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    definition: "End-to-end local tool call: mutable click plus updated semantic page state.",
    executionOrder,
    fixture: {
      url: site.url,
      description: "Local deterministic button increments a text output synchronously.",
    },
    samples: {
      warmupIterations,
      measuredIterations: iterations,
    },
    machine: machineSummary(),
    sources: {
      candidate: await sourceSummary(candidateRoot),
      previous: await sourceSummary(previousRoot),
      vscode: await vscodeSummary(),
    },
    boundaries: {
      candidate: "Browser Worker loopback HTTP; click returns incremental state.",
      previous: "Browser Worker loopback HTTP; click followed by full snapshot.",
      vscode: "Authenticated loopback MCP bridge; vscode.lm.invokeTool(click_element) acts on a pre-existing visible shared tab and returns native updated state.",
    },
    measurements,
    comparison: {
      candidateVsPrevious: compare(candidateP95, previousP95, 35),
      candidateVsVsCode: compare(candidateP95, vscodeP95, 0),
      candidateVsVsCodeExtendedTarget: compare(candidateP95, vscodeP95, 20),
      toolCallReductionVsPreviousPercent: round(
        (1 - measurements.candidate.toolCallsPerSample / measurements.previous.toolCallsPerSample) * 100,
        3,
      ),
    },
    interpretation: [
      "The result compares the actual local tool boundaries available on this machine.",
      "It does not include public ngrok latency or ChatGPT model deliberation time.",
      "VS Code includes the local MCP bridge because vscode.lm.invokeTool is not exposed as a public process API.",
      "VS Code reuses a pre-existing visible shared tab because a page created only through the headless bridge has no actionable viewport; setup navigation and restoration are outside the measured samples.",
      "The previous engine retains its historical Chrome channel; the candidate uses its certified managed Chromium.",
    ],
  };

  const jsonPath = path.join(outputDirectory, "comparison.json");
  const markdownPath = path.join(outputDirectory, "comparison.md");
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(markdownPath, renderMarkdown(report), "utf8"),
  ]);
  return { report, jsonPath, markdownPath };
}

async function measureCandidateEngine({ call, url, iterations, warmupIterations }) {
  const opened = await call("open", {
    url,
    purpose: "browser-performance-candidate",
    reusable: false,
    protected: false,
    sticky: false,
  });
  const tabId = requireTabId(opened);
  const initial = await call("snapshot", { tabId, forceFull: true });
  const ref = requireIncrementRef(initial);
  let knownRevision = initial?.state?.revision;
  const runs = [];
  const bytes = [];
  try {
    for (let index = 0; index < warmupIterations; index += 1) {
      const result = await call("click", {
        tabId,
        ref,
        ...(Number.isInteger(knownRevision) ? { knownRevision } : {}),
      });
      knownRevision = result?.state?.revision ?? knownRevision;
    }
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const result = await call("click", {
        tabId,
        ref,
        ...(Number.isInteger(knownRevision) ? { knownRevision } : {}),
      });
      runs.push(elapsed(startedAt));
      bytes.push(Buffer.byteLength(JSON.stringify(result), "utf8"));
      if (!result?.state) {
        throw new Error("Candidate click did not return updated state.");
      }
      knownRevision = result.state.revision;
    }
  } finally {
    await call("finishTask", {}).catch(() => undefined);
  }
  return {
    actionState: summarizeOperationBenchmark(runs, bytes, warmupIterations),
    toolCallsPerSample: 1,
    browserChannel: "managed-chromium",
  };
}

async function measurePreviousEngine({ call, url, iterations, warmupIterations }) {
  const opened = await call("open", {
    url,
    purpose: "browser-performance-previous",
    reusable: false,
    protected: false,
    sticky: false,
  });
  const tabId = requireTabId(opened);
  let snapshot = await call("snapshot", { tabId });
  let ref = requireIncrementRef(snapshot);
  const runs = [];
  const bytes = [];
  try {
    for (let index = 0; index < warmupIterations; index += 1) {
      await call("click", { tabId, ref });
      snapshot = await call("snapshot", { tabId });
      ref = requireIncrementRef(snapshot);
    }
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const click = await call("click", { tabId, ref });
      snapshot = await call("snapshot", { tabId });
      runs.push(elapsed(startedAt));
      bytes.push(Buffer.byteLength(JSON.stringify({ click, snapshot }), "utf8"));
      ref = requireIncrementRef(snapshot);
    }
  } finally {
    await call("finishTask", {}).catch(() => undefined);
  }
  return {
    actionState: summarizeOperationBenchmark(runs, bytes, warmupIterations),
    toolCallsPerSample: 2,
    browserChannel: "historical-chrome-stable",
  };
}

async function measureVsCode({
  url,
  iterations,
  warmupIterations,
  runtimePath,
  requestedPageId,
}) {
  const resolvedRuntimePath = path.resolve(
    runtimePath ?? path.join(os.homedir(), ".codex", "vscode-browser-bridge", "runtime.json"),
  );
  const runtime = JSON.parse(await readFile(resolvedRuntimePath, "utf8"));
  if (
    runtime?.host !== "127.0.0.1" ||
    !Number.isInteger(runtime?.port) ||
    !/^[a-f0-9]{64}$/u.test(runtime?.token ?? "")
  ) {
    throw new Error("VS Code browser bridge runtime configuration is invalid.");
  }
  const client = new McpBenchmarkClient({
    name: "vscode-native-browser",
    url: `http://${runtime.host}:${runtime.port}/mcp`,
    token: runtime.token,
  });
  const runs = [];
  const bytes = [];
  let pageId;
  let originalUrl;
  try {
    const tools = await client.listTools();
    for (const name of ["list_browser_pages", "run_playwright_code", "click_element"]) {
      if (!tools.tools.some((tool) => tool.name === name)) {
        throw new Error(`VS Code native browser tool is unavailable: ${name}`);
      }
    }
    const listed = await requireMcpSuccess(
      "VS Code page discovery",
      client.callTool("list_browser_pages", {}),
    );
    const pages = parseVsCodePages(listed);
    const selectedPage = requestedPageId
      ? pages.find((page) => page.pageId === requestedPageId)
      : pages.find((page) => page.visible || page.active);
    if (!selectedPage) {
      throw new Error(
        requestedPageId
          ? `VS Code shared page is unavailable: ${requestedPageId}`
          : "VS Code benchmark requires a pre-existing visible shared browser tab. Pass --vscode-page-id.",
      );
    }
    pageId = selectedPage.pageId;
    originalUrl = selectedPage.url;
    const navigated = await requireMcpSuccess(
      "VS Code benchmark navigation",
      client.callTool("run_playwright_code", {
        pageId,
        code: `await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 5000 }); return page.url()`,
        timeoutMs: 5_000,
      }),
    );
    assertVsCodeSnapshotCounter(navigated, 0);
    const incrementRef = extractVsCodeIncrementRef(navigated);
    for (let index = 0; index < warmupIterations; index += 1) {
      const expectedCounter = index + 1;
      const result = await requireMcpSuccess(
        "VS Code warmup click",
        client.callTool("click_element", {
          pageId,
          element: "Increment button",
          ref: incrementRef,
        }),
      );
      assertVsCodeSnapshotCounter(result, expectedCounter);
    }
    for (let index = 0; index < iterations; index += 1) {
      const expectedCounter = warmupIterations + index + 1;
      const startedAt = performance.now();
      const result = await requireMcpSuccess(
        "VS Code measured click",
        client.callTool("click_element", {
          pageId,
          element: "Increment button",
          ref: incrementRef,
        }),
      );
      runs.push(elapsed(startedAt));
      bytes.push(Buffer.byteLength(JSON.stringify(result), "utf8"));
      assertVsCodeSnapshotCounter(result, expectedCounter);
    }
  } finally {
    if (pageId && originalUrl && originalUrl !== url) {
      await client.callTool("run_playwright_code", {
        pageId,
        code: `await page.goto(${JSON.stringify(originalUrl)}, { waitUntil: 'domcontentloaded', timeout: 5000 }); return page.url()`,
        timeoutMs: 5_000,
      }).catch(() => undefined);
    }
    await client.close();
  }
  return {
    actionState: summarizeOperationBenchmark(runs, bytes, warmupIterations),
    toolCallsPerSample: 1,
    bridge: "vscode.lm.invokeTool(click_element)",
    action: "locator.click()",
    pagePreparation: "pre-existing visible shared tab",
  };
}

async function withWorker({ label, root, scratchDirectory, browserChannel, run }) {
  const port = await findAvailablePort();
  const token = randomBytes(32).toString("hex");
  const workerDirectory = path.join(scratchDirectory, label);
  const privateDirectory = path.join(workerDirectory, "private");
  const runtimeDirectory = path.join(workerDirectory, "runtime");
  const userDataDirectory = path.join(privateDirectory, "profile");
  await Promise.all([
    mkdir(privateDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);
  const stderr = [];
  const child = spawn(
    process.execPath,
    [path.join(root, "services", "browser-worker", "dist", "server.js")],
    {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        BROWSER_WORKER_PORT: String(port),
        BROWSER_WORKER_TOKEN: token,
        BROWSER_WORKER_MODE: "interactive",
        BROWSER_WORKER_PROFILE_MODE: "persistent",
        ...(browserChannel ? { BROWSER_WORKER_BROWSER_CHANNEL: browserChannel } : {}),
        BROWSER_WORKER_USER_DATA_DIR: userDataDirectory,
        BROWSER_WORKER_RUNTIME_DIR: runtimeDirectory,
        BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
        BROWSER_WORKER_CONNECT_TIMEOUT_MS: "120000",
        BROWSER_WORKER_OPERATION_TIMEOUT_MS: "120000",
        BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "120000",
      },
    },
  );
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    if (stderr.length > 40) stderr.shift();
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    await waitForHealth(port, child, stderr);
    return await run(createBrowserWorkerClient({ port, token }));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 20_000)),
    ]);
    if (child.exitCode === null) child.kill();
  }
}

async function waitForHealth(port, child, stderr) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Browser Worker exited during startup: ${stderr.join("").slice(-4_000)}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Retry until the bounded startup deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser Worker did not become live: ${stderr.join("").slice(-4_000)}`);
}

async function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) reject(error);
        else if (port) resolve(port);
        else reject(new Error("Unable to allocate benchmark port."));
      });
    });
  });
}

async function assertBuiltWorker(root, label) {
  const packagePath = path.join(root, "services", "browser-worker", "package.json");
  const serverPath = path.join(root, "services", "browser-worker", "dist", "server.js");
  try {
    await Promise.all([readFile(packagePath, "utf8"), readFile(serverPath, "utf8")]);
  } catch {
    throw new Error(`${label} Browser Worker is not built at ${root}.`);
  }
}

function requireTabId(opened) {
  const tabId = opened?.tab?.tabId;
  if (typeof tabId !== "string") {
    throw new Error("Browser Worker returned no benchmark tabId.");
  }
  return tabId;
}

function requireIncrementRef(snapshot) {
  const ref = snapshot?.refs?.find((entry) => entry.name === "Increment")?.ref;
  if (typeof ref !== "string") {
    throw new Error(
      `Browser Worker returned no Increment reference. refs=${JSON.stringify(snapshot?.refs ?? [])} content=${JSON.stringify(String(snapshot?.content ?? "").slice(0, 1_000))}`,
    );
  }
  return ref;
}

async function requireMcpSuccess(name, promise) {
  const result = await promise;
  if (result?.isError) {
    throw new Error(`${name} failed: ${toolText(result)}`);
  }
  return result;
}

function toolText(result) {
  return (result?.content ?? [])
    .filter((entry) => entry.type === "text")
    .map((entry) => entry.text ?? "")
    .join("\n");
}

function parseVsCodePages(result) {
  try {
    const parsed = JSON.parse(toolText(result));
    if (!Array.isArray(parsed?.pages)) throw new Error("missing pages");
    return parsed.pages;
  } catch (error) {
    throw new Error(
      `VS Code page discovery returned invalid JSON: ${toolText(result).slice(0, 1_000)}`,
      { cause: error },
    );
  }
}

function extractVsCodeIncrementRef(result) {
  const match = /button\s+"Increment"[^\r\n]*\[ref=([^\]]+)\]/iu.exec(toolText(result));
  if (!match) {
    throw new Error(
      `VS Code benchmark page returned no Increment reference: ${toolText(result).slice(0, 1_000)}`,
    );
  }
  return match[1];
}

function assertVsCodeSnapshotCounter(result, expectedCounter) {
  const text = toolText(result);
  const statusPattern = new RegExp(
    `^\\s*-\\s+(?:<changed>\\s+)?status(?:\\s+\\[[^\\]]+\\])?:\\s+"${expectedCounter}"$`,
    "mu",
  );
  if (!statusPattern.test(text)) {
    throw new Error(
      `VS Code action returned no updated snapshot for counter ${expectedCounter}: ${text.slice(0, 1_000)}`,
    );
  }
}

async function sourceSummary(root) {
  const packageJson = JSON.parse(
    await readFile(path.join(root, "services", "browser-worker", "package.json"), "utf8"),
  );
  const git = await gitSummary(root);
  return {
    root,
    browserWorkerVersion: packageJson.version,
    playwrightVersion: packageJson.dependencies?.playwright,
    ...git,
    sourceTreeSha256: await hashSourceTree(root),
  };
}

async function gitSummary(root) {
  const topLevel = await runProcess("git", ["rev-parse", "--show-toplevel"], root).catch(() => "");
  if (!topLevel) return { commit: null, dirty: null };
  const commit = await runProcess("git", ["rev-parse", "HEAD"], root);
  const status = await runProcess("git", ["status", "--porcelain", "--", "."], root);
  return { commit: commit.trim(), dirty: status.trim().length > 0 };
}

async function vscodeSummary() {
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
  if (!installMatch) {
    throw new Error(`Unable to resolve the active VS Code build from ${cliPath}.`);
  }
  const installDirectory = path.resolve(path.dirname(cliPath), "..", installMatch[1]);
  const [packageJson, productJson] = await Promise.all(
    [
      path.join(installDirectory, "resources", "app", "package.json"),
      path.join(installDirectory, "resources", "app", "product.json"),
    ].map(async (file) => JSON.parse(await readFile(file, "utf8"))),
  );
  return {
    version: packageJson.version,
    commit: productJson.commit,
    architecture: process.arch,
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

function machineSummary() {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    node: process.version,
  };
}

function compare(candidateP95, referenceP95, requiredImprovementPercent) {
  const improvementPercent = round((1 - candidateP95 / referenceP95) * 100, 3);
  return {
    candidateP95Ms: candidateP95,
    referenceP95Ms: referenceP95,
    improvementPercent,
    requiredImprovementPercent,
    passed: improvementPercent >= requiredImprovementPercent,
  };
}

function renderMarkdown(report) {
  const rows = [
    ["VS Code 1.130.0", report.measurements.vscode],
    ["Engine anterior", report.measurements.previous],
    ["Candidate", report.measurements.candidate],
  ].map(([name, value]) => [
    name,
    value.actionState.p50Ms,
    value.actionState.p95Ms,
    value.actionState.p99Ms,
    value.toolCallsPerSample,
    value.actionState.responseBytes.p95,
  ]);
  return [
    "# Browser engine comparison",
    "",
    `Captured: ${report.capturedAt}`,
    "",
    "| Target | p50 ms | p95 ms | p99 ms | Calls/sample | Response p95 bytes |",
    "|---|---:|---:|---:|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    `- Candidate vs previous: ${report.comparison.candidateVsPrevious.improvementPercent}%`,
    `- Candidate vs VS Code: ${report.comparison.candidateVsVsCode.improvementPercent}%`,
    `- Candidate vs VS Code extended target: ${report.comparison.candidateVsVsCodeExtendedTarget.passed ? "passed" : "failed"}`,
    `- Tool call reduction vs previous: ${report.comparison.toolCallReductionVsPreviousPercent}%`,
    "",
    "## Boundaries",
    "",
    ...Object.entries(report.boundaries).map(([name, value]) => `- ${name}: ${value}`),
    "",
  ].join("\n");
}

function elapsed(startedAt) {
  return round(performance.now() - startedAt, 3);
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function positiveInteger(value, name, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--([^=]+)=(.*)$/u.exec(argument);
    const key = match?.[1] ?? argument.replace(/^--/u, "");
    const value = match?.[2] ?? argv[index + 1];
    if (!match) index += 1;
    switch (key) {
      case "previous-root": values.previousRoot = value; break;
      case "candidate-root": values.candidateRoot = value; break;
      case "iterations": values.iterations = value; break;
      case "warmups": values.warmupIterations = value; break;
      case "vscode-runtime": values.vscodeRuntimePath = value; break;
      case "vscode-page-id": values.vscodePageId = value; break;
      default: throw new Error(`Unknown argument: --${key}`);
    }
  }
  return values;
}

async function main() {
  const result = await runBrowserComparison(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    comparison: result.report.comparison,
  }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

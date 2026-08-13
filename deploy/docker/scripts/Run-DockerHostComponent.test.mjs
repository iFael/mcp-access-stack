import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runnerPath = fileURLToPath(
  new URL("./Run-DockerHostComponent.mjs", import.meta.url),
);

async function createAgentFixture(prefix = "mcp-docker-host-runner-") {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  const projectRoot = path.join(temporaryRoot, "project root");
  const releaseRoot = path.join(temporaryRoot, "release root");
  const configurationDirectory = path.join(
    projectRoot,
    ".runtime-private",
    "docker",
    "production",
  );
  const targetDirectory = path.join(
    releaseRoot,
    "services",
    "workspace-agent",
    "dist",
  );
  const targetPath = path.join(targetDirectory, "cli.js");
  const gitleaksRelativePath = path.join(
    ".runtime-tools",
    "gitleaks",
    "8.30.1",
    "gitleaks.exe",
  );
  const gitleaksPath = path.join(projectRoot, gitleaksRelativePath);

  await Promise.all([
    mkdir(configurationDirectory, { recursive: true }),
    mkdir(targetDirectory, { recursive: true }),
    mkdir(path.dirname(gitleaksPath), { recursive: true }),
  ]);
  await writeFile(gitleaksPath, "test-gitleaks", "utf8");
  await writeFile(
    path.join(configurationDirectory, "agent.json"),
    JSON.stringify({
      gatewayUrl: "ws://127.0.0.1:65534/agent",
      agentId: "host-runner-test",
      token: "test-token",
      policyPath: path.join(temporaryRoot, "policy.json"),
      dataDirectory: path.join(temporaryRoot, "data"),
      maxPayloadBytes: 1024,
      maxConcurrentSynchronousShells: 2,
      gitleaksPath: gitleaksRelativePath,
    }),
    "utf8",
  );

  return {
    temporaryRoot,
    projectRoot,
    releaseRoot,
    targetPath,
    gitleaksPath,
  };
}

function taskOwnedRunnerArguments({
  component,
  releaseRoot,
  projectRoot,
  environment = "production",
  restartCount = 0,
  restartIntervalSeconds = 1,
}) {
  return [
    runnerPath,
    "--component",
    component,
    "--environment",
    environment,
    "--release-root",
    releaseRoot,
    "--project-root",
    projectRoot,
    "--task-owned",
    "true",
    "--restart-count",
    String(restartCount),
    "--restart-interval-seconds",
    String(restartIntervalSeconds),
  ];
}

test("runs a host component with append-only log descriptors", async () => {
  const fixture = await createAgentFixture();
  try {
    await writeFile(
      fixture.targetPath,
      [
        `const expectedGitleaksPath = ${JSON.stringify(fixture.gitleaksPath)};`,
        'process.stderr.write(`${JSON.stringify({ event: "fake_agent_started", gitleaksConfigured: Boolean(process.env.GITLEAKS_PATH), gitleaksPathIsExpected: process.env.GITLEAKS_PATH === expectedGitleaksPath, maxConcurrentSynchronousShells: process.env.VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS })}\\n`);',
      ].join("\n"),
      "utf8",
    );
    const result = await runProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "agent",
        releaseRoot: fixture.releaseRoot,
        projectRoot: fixture.projectRoot,
      }),
    );

    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const log = await readFile(
      path.join(
        fixture.projectRoot,
        "runtime",
        "windows-services",
        "production",
        "agent",
        "stderr.log",
      ),
      "utf8",
    );
    assert.match(log, /"event":"host_runner_started"/);
    assert.match(log, /"event":"fake_agent_started"/);
    assert.match(log, /"gitleaksConfigured":true/);
    assert.match(log, /"maxConcurrentSynchronousShells":"2"/);
    assert.match(log, /"gitleaksPathIsExpected":true/);
    assert.match(log, /"event":"host_runner_child_exited"/);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("forces legacy browser configuration onto the direct engine", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "mcp-docker-browser-runner-"),
  );
  const projectRoot = path.join(temporaryRoot, "project root");
  const releaseRoot = path.join(temporaryRoot, "release root");
  const configurationDirectory = path.join(
    projectRoot,
    ".runtime-private",
    "docker",
    "production",
  );
  const targetDirectory = path.join(
    releaseRoot,
    "services",
    "browser-worker",
    "dist",
  );

  try {
    await Promise.all([
      mkdir(configurationDirectory, { recursive: true }),
      mkdir(targetDirectory, { recursive: true }),
    ]);

    await writeFile(
      path.join(configurationDirectory, "browser.json"),
      JSON.stringify({
        port: 3350,
        token: "browser-worker-token",
        mode: "interactive",
        profileMode: "extension",
        browserChannel: "chromium",
        userDataDirectory: path.join(projectRoot, "browser-profile"),
        cliSessionName: "test-session",
        runtimeDirectory: path.join(projectRoot, "runtime"),
        privateDirectory: path.join(projectRoot, ".runtime-private", "browser"),
        maxPayloadBytes: 1024,
        maxOwnedTabs: 8,
        maxConcurrentTabs: 6,
        idempotencyTtlMs: 60000,
        idempotencyMaxEntries: 256,
        connectTimeoutMs: 1000,
        operationTimeoutMs: 1000,
        actionTimeoutMs: 1000,
        navigationTimeoutMs: 1000,
        outputMaxBytes: 1024,
        diagnosticTimeoutMs: 1000,
        extensionTokenFile: "legacy-extension-token.txt",
      }),
      "utf8",
    );
    await writeFile(
      path.join(targetDirectory, "server.js"),
      [
        "const payload = {",
        '  event: "fake_browser_started",',
        "  engine: process.env.BROWSER_WORKER_ENGINE,",
        "  profileMode: process.env.BROWSER_WORKER_PROFILE_MODE,",
        "  browserChannel: process.env.BROWSER_WORKER_BROWSER_CHANNEL,",
        "  maxConcurrentTabs: process.env.BROWSER_WORKER_MAX_CONCURRENT_TABS,",
        "  idempotencyTtlMs: process.env.BROWSER_WORKER_IDEMPOTENCY_TTL_MS,",
        "  idempotencyMaxEntries: process.env.BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES,",
        "  extensionTokenConfigured: Boolean(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN),",
        "  cliSessionConfigured: Boolean(process.env.BROWSER_WORKER_CLI_SESSION_NAME),",
        "};",
        "process.stderr.write(`${JSON.stringify(payload)}\\n`);",
      ].join("\n"),
      "utf8",
    );
    const result = await runProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "browser-worker",
        releaseRoot,
        projectRoot,
      }),
      { cwd: releaseRoot },
    );

    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const log = await readFile(
      path.join(
        projectRoot,
        "runtime",
        "windows-services",
        "production",
        "browser-worker",
        "stderr.log",
      ),
      "utf8",
    );
    assert.match(log, /"event":"host_runner_started"/);
    assert.match(log, /"event":"fake_browser_started"/);
    assert.match(log, /"engine":"playwright-direct"/);
    assert.match(log, /"profileMode":"persistent"/);
    assert.match(log, /"browserChannel":"chromium"/);
    assert.match(log, /"maxConcurrentTabs":"6"/);
    assert.match(log, /"idempotencyTtlMs":"60000"/);
    assert.match(log, /"idempotencyMaxEntries":"256"/);
    assert.match(log, /"extensionTokenConfigured":false/);
    assert.match(log, /"cliSessionConfigured":false/);
    assert.match(log, /"event":"host_runner_child_exited"/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("defaults browser workers to the isolated persistent profile", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "mcp-docker-browser-persistent-default-"),
  );
  const projectRoot = path.join(temporaryRoot, "project root");
  const releaseRoot = path.join(temporaryRoot, "release root");
  const configurationDirectory = path.join(
    projectRoot,
    ".runtime-private",
    "docker",
    "production",
  );
  const privateDirectory = path.join(projectRoot, ".runtime-private", "browser");
  const targetDirectory = path.join(
    releaseRoot,
    "services",
    "browser-worker",
    "dist",
  );

  try {
    await Promise.all([
      mkdir(configurationDirectory, { recursive: true }),
      mkdir(targetDirectory, { recursive: true }),
    ]);

    await writeFile(
      path.join(configurationDirectory, "browser.json"),
      JSON.stringify({
        port: 3350,
        token: "browser-worker-token",
        mode: "interactive",
        userDataDirectory: path.join(privateDirectory, "chrome-profile"),
        runtimeDirectory: path.join(projectRoot, "runtime"),
        privateDirectory,
        maxPayloadBytes: 1024,
        maxOwnedTabs: 8,
        connectTimeoutMs: 1000,
        operationTimeoutMs: 1000,
        actionTimeoutMs: 1000,
        navigationTimeoutMs: 1000,
        outputMaxBytes: 1024,
        diagnosticTimeoutMs: 1000,
      }),
      "utf8",
    );
    await writeFile(
      path.join(targetDirectory, "server.js"),
      [
        "const payload = {",
        '  event: "fake_browser_started",',
        "  engine: process.env.BROWSER_WORKER_ENGINE,",
        "  profileMode: process.env.BROWSER_WORKER_PROFILE_MODE,",
        "  browserChannel: process.env.BROWSER_WORKER_BROWSER_CHANNEL,",
        "  maxConcurrentTabs: process.env.BROWSER_WORKER_MAX_CONCURRENT_TABS,",
        "  idempotencyTtlMs: process.env.BROWSER_WORKER_IDEMPOTENCY_TTL_MS,",
        "  idempotencyMaxEntries: process.env.BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES,",
        "  extensionTokenConfigured: Boolean(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN),",
        "};",
        "process.stderr.write(`${JSON.stringify(payload)}\\n`);",
      ].join("\n"),
      "utf8",
    );

    const result = await runProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "browser-worker",
        releaseRoot,
        projectRoot,
      }),
      { cwd: releaseRoot },
    );

    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const log = await readFile(
      path.join(
        projectRoot,
        "runtime",
        "windows-services",
        "production",
        "browser-worker",
        "stderr.log",
      ),
      "utf8",
    );
    assert.match(log, /"engine":"playwright-direct"/);
    assert.match(log, /"profileMode":"persistent"/);
    assert.match(log, /"browserChannel":"chromium"/);
    assert.match(log, /"maxConcurrentTabs":"4"/);
    assert.match(log, /"idempotencyTtlMs":"300000"/);
    assert.match(log, /"idempotencyMaxEntries":"4096"/);
    assert.match(log, /"extensionTokenConfigured":false/);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runs as a task-owned runner behind the native launcher", async () => {
  const fixture = await createAgentFixture("mcp-task-owned-runner-");
  try {
    await writeFile(
      fixture.targetPath,
      'process.stderr.write(`${JSON.stringify({ event: "task_owned_child_started" })}\n`);\n',
      "utf8",
    );

    const result = await runProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "agent",
        releaseRoot: fixture.releaseRoot,
        projectRoot: fixture.projectRoot,
      }),
    );

    assert.equal(result.exitCode, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");

    const runtimeDirectory = path.join(
      fixture.projectRoot,
      "runtime",
      "windows-services",
      "production",
      "agent",
    );
    const log = await readFile(path.join(runtimeDirectory, "stderr.log"), "utf8");
    assert.match(log, /"event":"host_runner_started"/);
    assert.match(log, /"ownership":"scheduled-task"/);
    assert.match(log, /"event":"host_runner_child_started"/);
    assert.match(log, /"event":"task_owned_child_started"/);
    assert.match(log, /"event":"host_runner_restart_exhausted"/);
    await assert.rejects(readFile(path.join(runtimeDirectory, "runner-lease.json"), "utf8"));
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("maintains a task-owned runner lease heartbeat while the component is active", async () => {
  const fixture = await createAgentFixture("mcp-task-owned-heartbeat-");
  const readyPath = path.join(fixture.projectRoot, "component-ready.json");
  const stopPath = path.join(fixture.projectRoot, "component-stop.signal");
  const leasePath = path.join(
    fixture.projectRoot,
    "runtime",
    "windows-services",
    "production",
    "agent",
    "runner-lease.json",
  );
  try {
    await writeFile(
      fixture.targetPath,
      [
        'import { existsSync, writeFileSync } from "node:fs";',
        'import process from "node:process";',
        'writeFileSync(process.env.MCP_HOST_LIFECYCLE_READY_PATH, JSON.stringify({ pid: process.pid }), "utf8");',
        'while (!existsSync(process.env.MCP_HOST_LIFECYCLE_STOP_PATH)) {',
        '  await new Promise((resolve) => setTimeout(resolve, 50));',
        '}',
      ].join("\n"),
      "utf8",
    );

    const execution = spawnProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "agent",
        releaseRoot: fixture.releaseRoot,
        projectRoot: fixture.projectRoot,
      }),
      {
        env: {
          ...process.env,
          MCP_HOST_LIFECYCLE_READY_PATH: readyPath,
          MCP_HOST_LIFECYCLE_STOP_PATH: stopPath,
        },
      },
    );

    await waitForFile(readyPath, 10_000);
    await waitForFile(leasePath, 10_000);
    const firstLease = JSON.parse(await readFile(leasePath, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const secondLease = JSON.parse(await readFile(leasePath, "utf8"));

    assert.equal(firstLease.version, 2);
    assert.equal(firstLease.runnerPid, execution.child.pid);
    assert.equal(
      firstLease.childPid,
      Number(JSON.parse(await readFile(readyPath, "utf8")).pid),
    );
    assert.equal(firstLease.component, "agent");
    assert.equal(firstLease.environment, "production");
    assert.equal(firstLease.releaseRoot, fixture.releaseRoot);
    assert.match(firstLease.leaseId, /^[a-f0-9]{32}$/u);
    assert.ok(Date.parse(secondLease.updatedAtUtc) > Date.parse(firstLease.updatedAtUtc));

    await writeFile(stopPath, "stop", "utf8");
    const result = await withTimeout(
      execution.result,
      10_000,
      "task-owned runner did not exit after the component stopped",
    );
    assert.equal(result.exitCode, 1, result.stderr);
    await assert.rejects(readFile(leasePath, "utf8"));
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("restarts a failed component inside the task-owned runner", async () => {
  const fixture = await createAgentFixture("mcp-task-owned-restart-");
  const countPath = path.join(fixture.projectRoot, "run-count.txt");
  try {
    await writeFile(
      fixture.targetPath,
      [
        'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
        `const countPath = ${JSON.stringify(countPath)};`,
        'const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;',
        'writeFileSync(countPath, String(count), "utf8");',
        'process.exit(count === 1 ? 23 : 42);',
      ].join("\n"),
      "utf8",
    );

    const result = await runProcess(
      process.execPath,
      taskOwnedRunnerArguments({
        component: "agent",
        releaseRoot: fixture.releaseRoot,
        projectRoot: fixture.projectRoot,
        restartCount: 1,
        restartIntervalSeconds: 1,
      }),
    );

    assert.equal(result.exitCode, 42, result.stderr);
    assert.equal(Number(await readFile(countPath, "utf8")), 2);
    const log = await readFile(
      path.join(
        fixture.projectRoot,
        "runtime",
        "windows-services",
        "production",
        "agent",
        "stderr.log",
      ),
      "utf8",
    );
    assert.match(log, /"event":"host_runner_restart_scheduled"/);
    assert.match(log, /"restartAttempt":1/);
    assert.match(log, /"event":"host_runner_restart_exhausted"/);
  } finally {
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

function spawnProcess(executable, argumentsList, options = {}) {
  const child = spawn(executable, argumentsList, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const result = new Promise((resolve, reject) => {
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
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        exitCode: typeof code === "number" ? code : signal ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
  return { child, result };
}

function runProcess(executable, argumentsList, options = {}) {
  return spawnProcess(executable, argumentsList, options).result;
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      timeout.unref();
    }),
  ]);
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for file: ${path.basename(filePath)}`);
}

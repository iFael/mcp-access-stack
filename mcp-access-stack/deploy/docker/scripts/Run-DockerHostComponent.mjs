import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";

const RUNNER_HEARTBEAT_INTERVAL_MS = 1_000;
const RUNNER_HEARTBEAT_TIMEOUT_MS = 15_000;
const CHILD_TERMINATION_TIMEOUT_MS = 5_000;
const DEFAULT_RESTART_COUNT = 5;
const DEFAULT_RESTART_INTERVAL_SECONDS = 5;
const LEASE_WRITE_RETRY_COUNT = 20;
const LEASE_WRITE_RETRY_DELAY_MS = 25;
const TRANSIENT_LEASE_FILE_ERROR_CODES = new Set([
  "EEXIST",
  "EPERM",
  "EBUSY",
  "ENOTEMPTY",
]);
const LEASE_RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument sequence near: ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function requiredArgument(argumentsMap, name) {
  const value = argumentsMap.get(name);
  if (!value) {
    throw new Error(`Missing required argument: --${name}`);
  }
  return value;
}

function optionalIntegerArgument(
  argumentsMap,
  name,
  fallback,
  minimum,
  maximum,
) {
  const value = argumentsMap.get(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid integer argument: --${name}`);
  }
  return parsed;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function optionalString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value);
}

function resolveProjectPath(projectRoot, configuredPath) {
  const value = String(configuredPath);
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function createComponentEnvironment(
  component,
  configuration,
  projectRoot,
  credentialBrokerPath,
) {
  const environment = { ...process.env };

  if (component === "agent") {
    Object.assign(environment, {
      VS_CODE_GPT_GATEWAY_URL: String(configuration.gatewayUrl),
      VS_CODE_GPT_AGENT_ID: String(configuration.agentId),
      VS_CODE_GPT_AGENT_TOKEN: String(configuration.token),
      VS_CODE_GPT_POLICY_PATH: String(configuration.policyPath),
      VS_CODE_GPT_DATA_DIR: String(configuration.dataDirectory),
      VS_CODE_GPT_MAX_PAYLOAD_BYTES: String(configuration.maxPayloadBytes),
      VS_CODE_GPT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS: String(
        configuration.maxConcurrentSynchronousShells ?? 4,
      ),
      VS_CODE_GPT_QUALIFIED_EXECUTION_ENABLED: String(
        configuration.qualifiedCommand?.qualifiedExecution === true,
      ),
      VS_CODE_GPT_SAFE_AUTOCORRECTION_ENABLED: String(
        configuration.qualifiedCommand?.safeAutoCorrection === true,
      ),
      VS_CODE_GPT_QUALIFIED_SHADOW_MODE_ENABLED: String(
        configuration.qualifiedCommand?.shadowMode === true,
      ),
      VS_CODE_GPT_COMMAND_PROVIDER_ENABLED: String(
        configuration.qualifiedCommand?.providerEnabled === true,
      ),
      VS_CODE_GPT_QUALIFIED_WORKSPACE_ALLOWLIST: Array.isArray(
        configuration.qualifiedCommand?.workspaceAllowlist,
      )
        ? configuration.qualifiedCommand.workspaceAllowlist.join(",")
        : "",
      VS_CODE_GPT_COMMAND_PROVIDER_MODEL: optionalString(
        configuration.qualifiedCommand?.providerModel,
      ),
      VS_CODE_GPT_COMMAND_PROVIDER_BROKER_PATH: optionalString(
        configuration.qualifiedCommand?.providerBrokerPath,
      ),
      VS_CODE_GPT_COMMAND_PROVIDER_TIMEOUT_MS: String(
        configuration.qualifiedCommand?.providerTimeoutMs ?? 20000,
      ),
    });
    if (configuration.gitleaksPath) {
      const gitleaksPath = resolveProjectPath(
        projectRoot,
        configuration.gitleaksPath,
      );
      if (!existsSync(gitleaksPath)) {
        throw new Error("Configured Gitleaks binary is missing.");
      }
      environment.GITLEAKS_PATH = gitleaksPath;
    }
    return environment;
  }

  Object.assign(environment, {
    BROWSER_WORKER_ENGINE: "playwright-direct",
    BROWSER_WORKER_PORT: String(configuration.port),
    BROWSER_WORKER_TOKEN: String(configuration.token),
    BROWSER_WORKER_MODE: optionalString(configuration.mode, "diagnostic"),
    BROWSER_WORKER_PROFILE_MODE: "persistent",
    BROWSER_WORKER_BROWSER_CHANNEL: optionalString(
      configuration.browserChannel,
      "chromium",
    ),
    BROWSER_WORKER_USER_DATA_DIR: String(configuration.userDataDirectory),
    BROWSER_WORKER_RUNTIME_DIR: String(configuration.runtimeDirectory),
    BROWSER_WORKER_PRIVATE_DIR: String(configuration.privateDirectory),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: String(configuration.maxPayloadBytes),
    BROWSER_WORKER_MAX_OWNED_TABS: String(configuration.maxOwnedTabs ?? 8),
    BROWSER_WORKER_MAX_CONCURRENT_TABS: String(
      configuration.maxConcurrentTabs ?? 4,
    ),
    BROWSER_WORKER_IDEMPOTENCY_TTL_MS: String(
      configuration.idempotencyTtlMs ?? 5 * 60 * 1000,
    ),
    BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES: String(
      configuration.idempotencyMaxEntries ?? 4_096,
    ),
    BROWSER_WORKER_CONNECT_TIMEOUT_MS: String(configuration.connectTimeoutMs),
    BROWSER_WORKER_OPERATION_TIMEOUT_MS: String(
      configuration.operationTimeoutMs,
    ),
    BROWSER_WORKER_ACTION_TIMEOUT_MS: String(configuration.actionTimeoutMs),
    BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: String(
      configuration.navigationTimeoutMs,
    ),
    BROWSER_WORKER_OUTPUT_MAX_BYTES: String(configuration.outputMaxBytes),
    BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS: String(
      configuration.diagnosticTimeoutMs,
    ),
    ...(credentialBrokerPath
      ? { BROWSER_WORKER_CREDENTIAL_BROKER_PATH: credentialBrokerPath }
      : {}),
  });

  return environment;
}

function writeRunnerEvent(stderrFd, payload) {
  try {
    writeSync(stderrFd, `${JSON.stringify(payload)}\n`);
  } catch {
  }
}

function closeLogDescriptors(stdoutFd, stderrFd) {
  for (const descriptor of [stdoutFd, stderrFd]) {
    try {
      closeSync(descriptor);
    } catch {
    }
  }
}

function isTransientLeaseFileError(error) {
  return TRANSIENT_LEASE_FILE_ERROR_CODES.has(error?.code);
}

function waitForLeaseWriteRetry() {
  Atomics.wait(LEASE_RETRY_BUFFER, 0, 0, LEASE_WRITE_RETRY_DELAY_MS);
}

function writeJsonAtomically(targetPath, temporaryPath, value) {
  const contents = `${JSON.stringify(value)}\n`;
  let lastError;

  for (let attempt = 0; attempt <= LEASE_WRITE_RETRY_COUNT; attempt += 1) {
    writeFileSync(temporaryPath, contents, "utf8");
    try {
      renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientLeaseFileError(error)) throw error;
      lastError = error;
    }

    try {
      rmSync(targetPath, { force: true });
    } catch (error) {
      if (!isTransientLeaseFileError(error)) throw error;
      lastError = error;
    }

    try {
      renameSync(temporaryPath, targetPath);
      return;
    } catch (error) {
      if (!isTransientLeaseFileError(error)) throw error;
      lastError = error;
    }

    if (attempt < LEASE_WRITE_RETRY_COUNT) {
      waitForLeaseWriteRetry();
    }
  }

  rmSync(temporaryPath, { force: true });
  throw lastError ?? new Error("Runner lease update failed after retries.");
}

function registerSignal(signal, handler) {
  try {
    process.on(signal, handler);
  } catch {
  }
}

const argumentsMap = parseArguments(process.argv.slice(2));
const component = requiredArgument(argumentsMap, "component");
const environmentName = requiredArgument(argumentsMap, "environment");
const releaseRoot = path.resolve(requiredArgument(argumentsMap, "release-root"));
const projectRoot = path.resolve(requiredArgument(argumentsMap, "project-root"));
const credentialBrokerValue = argumentsMap.get("credential-broker-path");
const credentialBrokerPath = credentialBrokerValue
  ? path.resolve(credentialBrokerValue)
  : "";
if (requiredArgument(argumentsMap, "task-owned") !== "true") {
  throw new Error("Host runner requires --task-owned true.");
}
const restartCount = optionalIntegerArgument(
  argumentsMap,
  "restart-count",
  DEFAULT_RESTART_COUNT,
  0,
  100,
);
const restartIntervalSeconds = optionalIntegerArgument(
  argumentsMap,
  "restart-interval-seconds",
  DEFAULT_RESTART_INTERVAL_SECONDS,
  1,
  3_600,
);

if (!new Set(["agent", "browser-worker"]).has(component)) {
  throw new Error(`Unsupported component: ${component}`);
}
if (!new Set(["development", "production"]).has(environmentName)) {
  throw new Error(`Unsupported environment: ${environmentName}`);
}
if (
  component === "browser-worker" &&
  credentialBrokerPath &&
  !existsSync(credentialBrokerPath)
) {
  throw new Error("Credential broker executable is missing.");
}

const configurationFile = component === "agent" ? "agent.json" : "browser.json";
const configurationPath = path.join(
  projectRoot,
  ".runtime-private",
  "docker",
  environmentName,
  configurationFile,
);
const configuration = readJson(configurationPath);
const targetPath =
  component === "agent"
    ? path.join(releaseRoot, "services", "workspace-agent", "dist", "cli.js")
    : path.join(releaseRoot, "services", "browser-worker", "dist", "server.js");

if (!existsSync(targetPath)) {
  throw new Error(`Built host component entrypoint not found: ${targetPath}`);
}

const logDirectory = path.join(
  projectRoot,
  "runtime",
  "windows-services",
  environmentName,
  component,
);
mkdirSync(logDirectory, { recursive: true });

const stdoutFd = openSync(path.join(logDirectory, "stdout.log"), "a");
const stderrFd = openSync(path.join(logDirectory, "stderr.log"), "a");
const runnerLeaseId = randomUUID().replaceAll("-", "");
const runnerLeasePath = path.join(logDirectory, "runner-lease.json");
const runnerLeaseTempPath = path.join(
  logDirectory,
  `runner-lease.${process.pid}.tmp`,
);

let activeChild;
let forceKillTimer;
let runnerHeartbeat;
let interruptRestartWait;
let stopping = false;
let logsClosed = false;
let restartAttempt = 0;
let leaseWriteFailureCount = 0;

function assertNoActiveTaskRunner() {
  if (!existsSync(runnerLeasePath)) return;

  let lease;
  try {
    lease = readJson(runnerLeasePath);
  } catch {
    rmSync(runnerLeasePath, { force: true });
    return;
  }

  const updatedAt = Date.parse(String(lease.updatedAtUtc));
  const heartbeatAge = Date.now() - updatedAt;
  const runnerPid = Number(lease.runnerPid);
  const active =
    lease?.version === 2 &&
    String(lease.component) === component &&
    String(lease.environment) === environmentName &&
    Number.isSafeInteger(runnerPid) &&
    runnerPid > 0 &&
    Number.isFinite(updatedAt) &&
    heartbeatAge >= -60_000 &&
    heartbeatAge <= RUNNER_HEARTBEAT_TIMEOUT_MS &&
    processExists(runnerPid);

  if (active) {
    throw new Error(`Another task-owned runner is active for ${environmentName}/${component}.`);
  }
  rmSync(runnerLeasePath, { force: true });
}

function writeTaskRunnerLease() {
  writeJsonAtomically(runnerLeasePath, runnerLeaseTempPath, {
    version: 2,
    leaseId: runnerLeaseId,
    runnerPid: process.pid,
    childPid: activeChild?.pid ?? 0,
    component,
    environment: environmentName,
    releaseRoot,
    restartAttempt,
    updatedAtUtc: new Date().toISOString(),
  });
}

function writeTaskRunnerLeaseSafely(source) {
  try {
    writeTaskRunnerLease();
    leaseWriteFailureCount = 0;
    return true;
  } catch (error) {
    leaseWriteFailureCount += 1;
    writeRunnerEvent(stderrFd, {
      timestamp: new Date().toISOString(),
      component,
      environment: environmentName,
      event: "host_runner_lease_write_failed",
      source,
      code: error?.code ?? "UNKNOWN",
      consecutiveFailures: leaseWriteFailureCount,
    });
    return false;
  }
}

function removeTaskRunnerLease() {
  try {
    if (existsSync(runnerLeasePath)) {
      const lease = readJson(runnerLeasePath);
      if (String(lease.leaseId) === runnerLeaseId) {
        rmSync(runnerLeasePath, { force: true });
      }
    }
  } catch {
  }
  rmSync(runnerLeaseTempPath, { force: true });
}

function terminateChild(signal = "SIGTERM") {
  if (!activeChild || activeChild.exitCode !== null || activeChild.signalCode !== null) {
    return;
  }
  try {
    activeChild.kill(signal);
  } catch {
  }
}

function closeResources() {
  if (runnerHeartbeat) clearInterval(runnerHeartbeat);
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (interruptRestartWait) interruptRestartWait();
  removeTaskRunnerLease();
  if (!logsClosed) {
    logsClosed = true;
    closeLogDescriptors(stdoutFd, stderrFd);
  }
}

function requestShutdown(reason, signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  writeRunnerEvent(stderrFd, {
    timestamp: new Date().toISOString(),
    component,
    environment: environmentName,
    event: "host_runner_stopping",
    reason,
  });
  terminateChild(signal);
  forceKillTimer = setTimeout(() => terminateChild("SIGKILL"), CHILD_TERMINATION_TIMEOUT_MS);
  if (interruptRestartWait) interruptRestartWait();
}

function ignoreConsoleSignal(signal) {
  writeRunnerEvent(stderrFd, {
    timestamp: new Date().toISOString(),
    component,
    environment: environmentName,
    event:
      signal === "SIGINT"
        ? "host_runner_ignored_sigint"
        : "host_runner_ignored_console_signal",
    signal,
  });
}

registerSignal("SIGINT", () => ignoreConsoleSignal("SIGINT"));
registerSignal("SIGBREAK", () => ignoreConsoleSignal("SIGBREAK"));
registerSignal("SIGTERM", () => requestShutdown("signal-SIGTERM", "SIGTERM"));
registerSignal("SIGHUP", () => requestShutdown("signal-SIGHUP", "SIGTERM"));

process.on("exit", () => {
  terminateChild("SIGKILL");
  closeResources();
});

function childArguments() {
  return component === "agent"
    ? [targetPath, "connect", "--policy", String(configuration.policyPath)]
    : [targetPath];
}

function startComponentChild() {
  const child = spawn(process.execPath, childArguments(), {
    cwd: releaseRoot,
    env: createComponentEnvironment(
      component,
      configuration,
      projectRoot,
      credentialBrokerPath,
    ),
    stdio: ["ignore", stdoutFd, stderrFd],
    windowsHide: true,
  });
  activeChild = child;
  writeTaskRunnerLeaseSafely("child-start");
  writeRunnerEvent(stderrFd, {
    timestamp: new Date().toISOString(),
    component,
    environment: environmentName,
    event: "host_runner_child_started",
    childPid: child.pid,
    restartAttempt,
  });
  return child;
}

function waitForChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      writeRunnerEvent(stderrFd, {
        timestamp: new Date().toISOString(),
        component,
        environment: environmentName,
        event: "host_runner_child_error",
        code: error?.code ?? "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      });
      settle({ exitCode: 1, signal: null });
    });
    child.once("exit", (code, signal) => {
      settle({
        exitCode: typeof code === "number" ? code : signal ? 1 : 0,
        signal: signal ?? null,
      });
    });
  });
}

function waitForRestartDelay(milliseconds) {
  return new Promise((resolve) => {
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      interruptRestartWait = undefined;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    interruptRestartWait = () => {
      clearTimeout(timer);
      finish();
    };
  });
}

async function runTaskOwned() {
  assertNoActiveTaskRunner();
  writeTaskRunnerLease();
  runnerHeartbeat = setInterval(
    () => writeTaskRunnerLeaseSafely("heartbeat"),
    RUNNER_HEARTBEAT_INTERVAL_MS,
  );

  while (!stopping) {
    const child = startComponentChild();
    const result = await waitForChild(child);
    activeChild = undefined;
    writeTaskRunnerLeaseSafely("child-exit");

    writeRunnerEvent(stderrFd, {
      timestamp: new Date().toISOString(),
      component,
      environment: environmentName,
      event: "host_runner_child_exited",
      exitCode: result.exitCode,
      signal: result.signal,
      restartAttempt,
    });

    if (stopping) return 0;
    if (restartAttempt >= restartCount) {
      const finalExitCode = result.exitCode === 0 ? 1 : result.exitCode;
      writeRunnerEvent(stderrFd, {
        timestamp: new Date().toISOString(),
        component,
        environment: environmentName,
        event: "host_runner_restart_exhausted",
        exitCode: finalExitCode,
        restartAttempt,
      });
      return finalExitCode;
    }

    restartAttempt += 1;
    writeTaskRunnerLeaseSafely("restart-scheduled");
    writeRunnerEvent(stderrFd, {
      timestamp: new Date().toISOString(),
      component,
      environment: environmentName,
      event: "host_runner_restart_scheduled",
      restartAttempt,
      delaySeconds: restartIntervalSeconds,
    });
    await waitForRestartDelay(restartIntervalSeconds * 1_000);
  }

  return 0;
}

writeRunnerEvent(stderrFd, {
  timestamp: new Date().toISOString(),
  component,
  environment: environmentName,
  event: "host_runner_started",
  ownership: "scheduled-task",
  runnerPid: process.pid,
});

let exitCode = 1;
try {
  exitCode = await runTaskOwned();
} catch (error) {
  writeRunnerEvent(stderrFd, {
    timestamp: new Date().toISOString(),
    component,
    environment: environmentName,
    event: "host_runner_failed",
    code: error?.code ?? "UNKNOWN",
    message: error instanceof Error ? error.message : String(error),
  });
  exitCode = 1;
} finally {
  closeResources();
}

process.exitCode = exitCode;

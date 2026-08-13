import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError, type OperationContext } from "@vs-code-gpt/shared";
import { loadBrowserWorkerConfig } from "../../../services/browser-worker/config/browser-worker-config.js";
import { BrowserRuntime } from "../../../services/browser-worker/services/browser-runtime.js";
import {
  WindowsCredentialBrokerClient,
  type BrowserCredentialBroker,
  type CredentialBrokerReadRequest,
  type CredentialBrokerReadResult,
} from "../../../services/browser-worker/services/windows-credential-broker-client.js";

interface PrivateBrowserConfiguration {
  privateDirectory?: string;
}

type AuthStatus =
  | "not-required"
  | "session-reused"
  | "performed"
  | "interaction-required"
  | "failed";

interface AuthenticationAttempt {
  phase: "cold-login" | "same-context-reuse";
  authenticationStatus?: AuthStatus;
  authenticationReason?: string;
  durationMs: number;
  errorCode?: string;
}

class SingleReadCredentialBroker implements BrowserCredentialBroker {
  readCount = 0;
  secondReadAttempted = false;

  constructor(private readonly inner: BrowserCredentialBroker) {}

  async read(
    request: CredentialBrokerReadRequest,
  ): Promise<CredentialBrokerReadResult> {
    this.readCount += 1;
    if (this.readCount > 1) {
      this.secondReadAttempted = true;
      return { status: "broker-unavailable" };
    }
    return this.inner.read(request);
  }
}

const root = process.cwd();
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = new Date().toISOString();
const privateConfigPath = path.resolve(
  process.env.MCP_QUALIFICATION_PRIVATE_CONFIG ??
    path.join(root, ".runtime-private", "docker", "production", "browser.json"),
);
const brokerPath = process.env.MCP_QUALIFICATION_BROKER_PATH;
if (!brokerPath || !path.isAbsolute(brokerPath)) {
  throw new Error("Qualification broker path is unavailable.");
}
const privateConfig = JSON.parse(
  await readFile(privateConfigPath, "utf8"),
) as PrivateBrowserConfiguration;
if (!privateConfig.privateDirectory) {
  throw new Error("Private Browser Worker directory is unavailable.");
}

const privateDirectory = path.resolve(privateConfig.privateDirectory);
const qualificationRoot = path.join(
  root,
  "runtime",
  "qualification",
  "browser-auth",
  runId,
);
const privateQualificationRoot = path.join(
  privateDirectory,
  "qualification",
  runId,
);
const profileDirectory = path.join(privateQualificationRoot, "chrome-profile");
const runtimeDirectory = path.join(qualificationRoot, "runtime");
const reportDirectory = path.join(
  root,
  "runtime",
  "qualification",
  "browser-auth",
  "reports",
  runId,
);
const reportPath = path.join(reportDirectory, "report.json");
const context: OperationContext = { ownerScope: `qualification-${runId}` };
const attempts: AuthenticationAttempt[] = [];
const broker = new SingleReadCredentialBroker(
  new WindowsCredentialBrokerClient({
    executablePath: brokerPath,
    privateDirectory,
    timeoutMs: 10_000,
  }),
);
let runtime: BrowserRuntime | undefined;
let taskId: string | undefined;
let taskFinished = false;
let runtimeShutdown = false;
let profileRemoved = false;
let runtimeRemoved = false;

await mkdir(reportDirectory, { recursive: true });
try {
  runtime = await BrowserRuntime.create(
    createConfig(runtimeDirectory, profileDirectory, brokerPath),
    undefined,
    { credentialBroker: broker },
  );

  const cold = await executeAuthorizedOpen(
    runtime,
    context,
    undefined,
    "cold-login",
    "real-dev-auth-qualification",
  );
  attempts.push(cold.attempt);
  taskId = cold.taskId;

  if (cold.attempt.authenticationStatus === "performed") {
    const warm = await executeAuthorizedOpen(
      runtime,
      context,
      taskId,
      "same-context-reuse",
      "real-dev-auth-qualification",
    );
    attempts.push(warm.attempt);
    taskId = warm.taskId ?? taskId;
  }
} finally {
  if (runtime && taskId) {
    await runtime.finishTask({ taskId }, context)
      .then(() => {
        taskFinished = true;
      })
      .catch(() => undefined);
  }
  if (runtime) {
    await runtime.shutdown()
      .then(() => {
        runtimeShutdown = true;
      })
      .catch(() => undefined);
  }
  profileRemoved = await removeWithRetry(privateQualificationRoot);
  runtimeRemoved = await removeWithRetry(qualificationRoot);
}

const cold = attempts.find((attempt) => attempt.phase === "cold-login");
const warm = attempts.find((attempt) => attempt.phase === "same-context-reuse");
const report = {
  schemaVersion: 2,
  runId,
  siteId: "private-site",
  startedAt,
  completedAt: new Date().toISOString(),
  passed: Boolean(
    cold?.authenticationStatus === "performed" &&
    warm?.authenticationStatus === "session-reused" &&
    broker.readCount === 1 &&
    !broker.secondReadAttempted &&
    taskFinished &&
    runtimeShutdown &&
    profileRemoved &&
    runtimeRemoved,
  ),
  isolation: {
    productionProcessesChanged: false,
    productionRuntimeUsed: false,
    productionProfileUsed: false,
    isolatedProfile: true,
    isolatedRegistry: true,
  },
  credentialSafety: {
    realCredentialProvisionedExternally: true,
    credentialValuesObservedByQualifier: false,
    credentialValuesPersistedByQualifier: false,
    requestBodiesCaptured: false,
    cookiesCaptured: false,
    tokensCaptured: false,
    traceEnabled: false,
    videoEnabled: false,
  },
  attempts,
  brokerEvidence: {
    readCount: broker.readCount,
    secondReadAttempted: broker.secondReadAttempted,
    maximumAllowedReads: 1,
  },
  cleanup: {
    taskFinished,
    runtimeShutdown,
    profileRemoved,
    runtimeRemoved,
  },
  scope: {
    sameContextSessionReuseRequired: true,
    crossProcessSessionPersistenceRequired: false,
  },
};
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(JSON.stringify({
  passed: report.passed,
  reportPath: path.relative(root, reportPath).replaceAll("\\", "/"),
  attempts,
  brokerEvidence: report.brokerEvidence,
  cleanup: report.cleanup,
}, null, 2) + "\n");
process.exit(report.passed ? 0 : 1);

async function executeAuthorizedOpen(
  activeRuntime: BrowserRuntime,
  activeContext: OperationContext,
  existingTaskId: string | undefined,
  phase: AuthenticationAttempt["phase"],
  purpose: string,
): Promise<{ attempt: AuthenticationAttempt; taskId?: string }> {
  const started = performance.now();
  const attempt: AuthenticationAttempt = {
    phase,
    durationMs: 0,
  };
  let resolvedTaskId = existingTaskId;
  try {
    const pending = await activeRuntime.openAuthorizedSite({
      ...(existingTaskId === undefined ? {} : { taskId: existingTaskId }),
      siteId: "private-site",
      purpose,
    }, activeContext);
    if (pending.status !== "confirmation_required") {
      throw new AppError(
        "SITE_ACCESS_AUTHORIZATION_REQUIRED",
        "Qualification did not receive a private-site confirmation.",
      );
    }
    resolvedTaskId = pending.taskId;
    const opened = await activeRuntime.openAuthorizedSite({
      taskId: pending.taskId,
      siteId: "private-site",
      purpose,
      confirmationId: pending.confirmationId,
    }, activeContext);
    if (opened.status !== "opened") {
      throw new AppError("SITE_NAVIGATION_BLOCKED", "Qualification site did not open.");
    }
    attempt.authenticationStatus = opened.authentication.status;
    if ("reason" in opened.authentication) {
      attempt.authenticationReason = opened.authentication.reason;
    }
  } catch (error) {
    attempt.errorCode = error instanceof AppError
      ? error.code
      : "UNEXPECTED_QUALIFICATION_ERROR";
  } finally {
    attempt.durationMs = Math.round((performance.now() - started) * 1_000) / 1_000;
  }
  return { attempt, ...(resolvedTaskId === undefined ? {} : { taskId: resolvedTaskId }) };
}

function createConfig(
  browserRuntimeDirectory: string,
  userDataDirectory: string,
  credentialBrokerPath: string,
) {
  return {
    ...loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: randomBytes(32).toString("base64url"),
      BROWSER_WORKER_PORT: "39351",
      BROWSER_WORKER_MODE: "efficient",
      BROWSER_WORKER_PROFILE_MODE: "persistent",
      BROWSER_WORKER_BROWSER_CHANNEL: "chromium",
      BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
      BROWSER_WORKER_USER_DATA_DIR: userDataDirectory,
      BROWSER_WORKER_RUNTIME_DIR: browserRuntimeDirectory,
      BROWSER_WORKER_CREDENTIAL_BROKER_PATH: credentialBrokerPath,
      BROWSER_WORKER_CONNECT_TIMEOUT_MS: "90000",
      BROWSER_WORKER_OPERATION_TIMEOUT_MS: "120000",
      BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "90000",
      BROWSER_WORKER_LOGIN_TIMEOUT_MS: "30000",
      BROWSER_CONTEXT_IDLE_SHUTDOWN_MS: "0",
    }),
    headless: true,
  };
}

async function removeWithRetry(target: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return false;
}

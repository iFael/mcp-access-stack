import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError, type OperationContext } from "@vs-code-gpt/shared";
import { loadBrowserWorkerConfig } from "../../../services/browser-worker/config/browser-worker-config.js";
import { BrowserRuntime } from "../../../services/browser-worker/services/browser-runtime.js";

const root = process.cwd();
const sourceRunId = process.env.MCP_QUALIFICATION_SOURCE_RUN_ID;
if (!sourceRunId || !/^[0-9TZ-]+$/.test(sourceRunId)) {
  throw new Error("Qualification source run id is invalid.");
}
const privateConfigPath = path.resolve(
  process.env.MCP_QUALIFICATION_PRIVATE_CONFIG ??
    path.join(root, ".runtime-private", "docker", "production", "browser.json"),
);
const privateConfig = JSON.parse(await readFile(privateConfigPath, "utf8")) as {
  privateDirectory?: string;
};
if (!privateConfig.privateDirectory) {
  throw new Error("Private Browser Worker directory is unavailable.");
}
const privateDirectory = path.resolve(privateConfig.privateDirectory);
const profileRoot = path.join(privateDirectory, "qualification", sourceRunId);
const profileDirectory = path.join(profileRoot, "chrome-profile");
const recoveryId = new Date().toISOString().replace(/[:.]/g, "-");
const runtimeRoot = path.join(
  root,
  "runtime",
  "qualification",
  "browser-auth",
  "warm-recovery",
  recoveryId,
);
const reportDirectory = path.join(
  root,
  "runtime",
  "qualification",
  "browser-auth",
  "reports",
  sourceRunId,
);
const reportPath = path.join(reportDirectory, "warm-recovery.json");
const context: OperationContext = { ownerScope: `warm-recovery-${recoveryId}` };
let taskId: string | undefined;
let taskFinished = false;
let authenticationStatus: string | undefined;
let authenticationReason: string | undefined;
let errorCode: string | undefined;
const startedAt = new Date().toISOString();
const started = performance.now();

await mkdir(reportDirectory, { recursive: true });
try {
  const runtime = await BrowserRuntime.create({
    ...loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: randomBytes(32).toString("base64url"),
      BROWSER_WORKER_PORT: "39352",
      BROWSER_WORKER_MODE: "efficient",
      BROWSER_WORKER_PROFILE_MODE: "persistent",
      BROWSER_WORKER_BROWSER_CHANNEL: "chromium",
      BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
      BROWSER_WORKER_USER_DATA_DIR: profileDirectory,
      BROWSER_WORKER_RUNTIME_DIR: runtimeRoot,
      BROWSER_WORKER_CONNECT_TIMEOUT_MS: "90000",
      BROWSER_WORKER_OPERATION_TIMEOUT_MS: "120000",
      BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "90000",
      BROWSER_WORKER_LOGIN_TIMEOUT_MS: "30000",
      BROWSER_CONTEXT_IDLE_SHUTDOWN_MS: "100",
    }),
    headless: true,
  });
  try {
    const pending = await runtime.openAuthorizedSite({
      siteId: "private-site",
      purpose: "real-dev-warm-recovery-qualification",
    }, context);
    if (pending.status !== "confirmation_required") {
      throw new AppError(
        "SITE_ACCESS_AUTHORIZATION_REQUIRED",
        "Warm recovery did not receive a private-site confirmation.",
      );
    }
    taskId = pending.taskId;
    const opened = await runtime.openAuthorizedSite({
      taskId,
      siteId: "private-site",
      purpose: "real-dev-warm-recovery-qualification",
      confirmationId: pending.confirmationId,
    }, context);
    if (opened.status !== "opened") {
      throw new AppError("SITE_NAVIGATION_BLOCKED", "Warm recovery site did not open.");
    }
    authenticationStatus = opened.authentication.status;
    if ("reason" in opened.authentication) {
      authenticationReason = opened.authentication.reason;
    }
  } catch (error) {
    errorCode = error instanceof AppError
      ? error.code
      : "UNEXPECTED_QUALIFICATION_ERROR";
  } finally {
    if (taskId) {
      await runtime.finishTask({ taskId }, context)
        .then(() => {
          taskFinished = true;
        })
        .catch(() => undefined);
    }
  }
} catch (error) {
  errorCode = error instanceof AppError
    ? error.code
    : "UNEXPECTED_QUALIFICATION_ERROR";
}

await new Promise((resolve) => setTimeout(resolve, 1_500));
const profileRemoved = await removeWithRetry(profileRoot);
const runtimeRemoved = await removeWithRetry(runtimeRoot);
const report = {
  schemaVersion: 1,
  sourceRunId,
  recoveryId,
  siteId: "private-site",
  startedAt,
  completedAt: new Date().toISOString(),
  durationMs: Math.round((performance.now() - started) * 1_000) / 1_000,
  passed: authenticationStatus === "session-reused" && profileRemoved && runtimeRemoved,
  authenticationStatus,
  authenticationReason,
  errorCode,
  taskFinished,
  brokerConfigured: false,
  credentialReadPossible: false,
  credentialValuesObserved: false,
  requestBodiesCaptured: false,
  cookiesCaptured: false,
  tokensCaptured: false,
  traceEnabled: false,
  videoEnabled: false,
  profileRemoved,
  runtimeRemoved,
};
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
process.stdout.write(JSON.stringify({
  passed: report.passed,
  reportPath: path.relative(root, reportPath).replaceAll("\\", "/"),
  authenticationStatus,
  authenticationReason,
  errorCode,
  taskFinished,
  profileRemoved,
  runtimeRemoved,
}, null, 2) + "\n");
process.exit(report.passed ? 0 : 1);

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

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AppError,
  asAppError,
  policyFileSchema,
  type PolicyFile,
} from "@vs-code-gpt/shared";
import { createGatewayApplication } from "./app.js";
import { loadGatewayConfig } from "./config.js";
import { ScopedBrowserWorkerPool } from "./browser/scoped-browser-worker-pool.js";
import { LocalRepositoryManager } from "./companion/local-repository-manager.js";
import { ReloadableLocalAgent } from "./companion/reloadable-local-agent.js";
import { EdgeConnector } from "./edge/connector.js";
import { assertLoopbackMcpCompatibility } from "./edge/loopback-health.js";
import { closeLoopbackGateway, startLoopbackGateway } from "./edge/loopback-server.js";
import { createMcpServer, getMcpServerCatalogMetadata } from "./mcp/server.js";

const execFileAsync = promisify(execFile);

interface ConnectorRuntimeConfig {
  edgeBaseUrl: URL;
  connectorUrl: URL;
  tokenFile: string;
  policyPath: string;
  releaseRoot: string;
  runtimeRoot: string;
  repositoryStateDirectory: string;
  managedRepositoryRoot: string;
  maxConcurrentRequests?: number;
}

async function main(): Promise<void> {
  const connectorInstanceId = randomUUID();
  const processStartedAt = new Date().toISOString();
  const runtime = loadConnectorRuntimeConfig(process.env);
  const connectorToken = await readConnectorToken(runtime.tokenFile);
  const gatewayConfig = {
    ...loadGatewayConfig({
      ...process.env,
      NODE_ENV: "production",
      PORT: "0",
      PUBLIC_BASE_URL: runtime.edgeBaseUrl.href,
      MCP_PATH: "/mcp",
      TRUST_PROXY: "0",
      WORKSPACE_BACKEND: "in-process",
      AUTH_MODE: "none",
    }),
    authMode: "edge-trusted" as const,
  };
  const internalAssertion = randomBytes(32).toString("base64url");

  const basePolicy = await readPrimaryPolicy(runtime.policyPath);
  const reloadable = new ReloadableLocalAgent();
  let repositories!: LocalRepositoryManager;
  const reloadPrimaryRuntime = async (): Promise<void> => {
    const managedPolicy = await repositories.buildPolicy();
    await reloadable.reload(mergePrimaryPolicies(basePolicy, managedPolicy));
  };
  repositories = await LocalRepositoryManager.create({
    stateDirectory: runtime.repositoryStateDirectory,
    managedRoot: runtime.managedRepositoryRoot,
    onChanged: reloadPrimaryRuntime,
  });
  await reloadPrimaryRuntime();

  let browserPool: ScopedBrowserWorkerPool | undefined;
  try {
    await assertLinuxBrowserRuntimeDependencies(runtime.releaseRoot);
    browserPool = await ScopedBrowserWorkerPool.create({
      releaseRoot: runtime.releaseRoot,
      stateRoot: path.join(runtime.runtimeRoot, "remote-browser"),
      nodePath: process.execPath,
      headless: true,
      log: writeLog,
    });
  } catch (error) {
    writeLog({
      event: "mcp_v3_remote_browser_unavailable",
      error: asAppError(error).toJSON(),
    });
  }
  const browserEpoch = browserPool === undefined ? undefined : randomUUID();

  const workspaceExecutor = reloadable.workspaceExecutor;
  const sourceControlExecutor = reloadable.sourceControlExecutor;
  const identityServer = createMcpServer({
    workspaceExecutor,
    sourceControlExecutor,
    companionRepositoryBinder: repositories,
  });
  const catalogMetadata = getMcpServerCatalogMetadata(identityServer);
  const gateway = createGatewayApplication(gatewayConfig, {
    workspaceExecutor,
    sourceControlExecutor,
    companionRepositoryBinder: repositories,
    ...(browserPool === undefined
      ? {}
      : {
          browser: browserPool,
          browserLiveFrame: (
            input: {
              taskId: string;
              tabId: string;
              afterSeq: number;
              signal?: AbortSignal;
            },
            context: { ownerScope: string },
          ) => browserPool.readLiveFrame(input, context),
        }),
    workspaceReady: () => reloadable.ready,
    edgeTrust: { internalAssertion },
  });
  const loopback = await startLoopbackGateway(gateway.app);
  const localBaseUrl = loopback.baseUrl;
  const connector = new EdgeConnector({
    edgeUrl: runtime.connectorUrl,
    token: connectorToken,
    internalAssertion,
    localBaseUrl,
    runtimeIdentity: {
      version: 1,
      connectorInstanceId,
      ...(browserEpoch === undefined ? {} : { browserEpoch }),
      processStartedAt,
      catalogContractRevision: catalogMetadata.contractRevision,
      toolSetRevision: catalogMetadata.toolSetRevision,
      toolCount: catalogMetadata.toolCount,
      serverVersion: catalogMetadata.serverVersion,
      nodePid: process.pid,
      hostPid: process.ppid,
    },
    ...(runtime.maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests: runtime.maxConcurrentRequests }),
    log: writeLog,
  });

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    writeLog({ event: "edge_connector_process_signal", signal });
    controller.abort();
    connector.stop();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  writeLog({
    event: "edge_connector_process_started",
    connectorInstanceId,
    processStartedAt,
    catalogContractRevision: catalogMetadata.contractRevision,
    toolSetRevision: catalogMetadata.toolSetRevision,
    toolCount: catalogMetadata.toolCount,
    serverVersion: catalogMetadata.serverVersion,
    edgeOrigin: runtime.edgeBaseUrl.origin,
    authMode: gatewayConfig.authMode,
    browserAvailable: browserPool !== undefined,
    ...(browserEpoch === undefined ? {} : { browserEpoch }),
  });

  try {
    await assertLoopbackMcpCompatibility(localBaseUrl, internalAssertion);
    writeLog({ event: "edge_connector_loopback_health_passed" });
    await connector.run(controller.signal);
  } finally {
    connector.stop();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await gateway.close();
    await closeLoopbackGateway(loopback.server);
    await browserPool?.close();
    writeLog({ event: "edge_connector_process_stopped" });
  }
}

function loadConnectorRuntimeConfig(environment: NodeJS.ProcessEnv): ConnectorRuntimeConfig {
  const edgeBaseUrl = new URL(requireValue(environment.MCP_EDGE_BASE_URL, "MCP_EDGE_BASE_URL"));
  if (
    edgeBaseUrl.protocol !== "https:" ||
    edgeBaseUrl.pathname !== "/" ||
    edgeBaseUrl.username ||
    edgeBaseUrl.password ||
    edgeBaseUrl.search ||
    edgeBaseUrl.hash
  ) {
    throw new AppError("INVALID_ARGUMENT", "MCP_EDGE_BASE_URL must be a credential-free HTTPS origin.");
  }
  const connectorUrl = new URL("/connector", edgeBaseUrl);
  connectorUrl.protocol = "wss:";

  const runtimeRoot = path.resolve(requireValue(
    environment.MCP_ACCESS_STACK_RUNTIME_ROOT,
    "MCP_ACCESS_STACK_RUNTIME_ROOT",
  ));
  const releaseRoot = path.resolve(requireValue(
    environment.MCP_RELEASE_ROOT,
    "MCP_RELEASE_ROOT",
  ));
  return {
    edgeBaseUrl,
    connectorUrl,
    tokenFile: path.resolve(requireValue(environment.MCP_CONNECTOR_TOKEN_FILE, "MCP_CONNECTOR_TOKEN_FILE")),
    policyPath: path.resolve(requireValue(environment.VS_CODE_GPT_POLICY_PATH, "VS_CODE_GPT_POLICY_PATH")),
    releaseRoot,
    runtimeRoot,
    repositoryStateDirectory: path.join(runtimeRoot, "repository-state"),
    managedRepositoryRoot: path.join(runtimeRoot, "repositories"),
    ...readOptionalPositiveInteger(environment.MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS, "MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS", "maxConcurrentRequests"),
  };
}

async function assertLinuxBrowserRuntimeDependencies(
  releaseRoot: string,
): Promise<void> {
  if (process.platform === "win32") return;
  const browsersRoot = path.join(
    releaseRoot,
    "node_modules",
    "playwright-core",
    ".local-browsers",
  );
  let revisions: string[];
  try {
    revisions = (await readdir(browsersRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Remote Browser binaries are missing from the MCP V3 Linux release.",
      { cause: error },
    );
  }
  const revision = revisions[0];
  if (!revision) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Remote Browser headless Chromium is missing from the MCP V3 Linux release.",
    );
  }
  const executable = path.join(
    browsersRoot,
    revision,
    "chrome-headless-shell-linux64",
    "chrome-headless-shell",
  );
  try {
    const info = await stat(executable);
    if (!info.isFile() || info.size <= 0) throw new Error("browser executable is not a regular file");
  } catch (error) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Remote Browser headless Chromium executable is missing from the MCP V3 Linux release.",
      { cause: error },
    );
  }

  let output: string;
  try {
    const result = await execFileAsync("ldd", [executable], {
      encoding: "utf8",
      maxBuffer: 512 * 1024,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (error) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Remote Browser Linux dependency probe could not execute ldd.",
      { cause: error },
    );
  }
  const missing = [...output.matchAll(/^\s*([^\s]+)\s+=>\s+not found\s*$/gmu)]
    .map((match) => match[1]!)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (missing.length > 0) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      `Remote Browser requires Linux shared libraries: ${missing.join(", ")}.`,
    );
  }
}

async function readPrimaryPolicy(filePath: string): Promise<PolicyFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new AppError("POLICY_INVALID", "Primary workspace policy could not be read.", { cause: error });
  }
  const result = policyFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new AppError("POLICY_INVALID", "Primary workspace policy is invalid.");
  }
  return result.data;
}

function mergePrimaryPolicies(base: PolicyFile, managed: PolicyFile | null): PolicyFile {
  if (!managed) return base;
  const ids = new Set(base.workspaces.map((workspace) => workspace.id));
  for (const workspace of managed.workspaces) {
    if (ids.has(workspace.id)) {
      throw new AppError(
        "POLICY_INVALID",
        `Managed remote workspace id conflicts with the primary policy: ${workspace.id}.`,
      );
    }
    ids.add(workspace.id);
  }
  return policyFileSchema.parse({
    version: 1,
    workspaces: [...base.workspaces, ...managed.workspaces],
  });
}

async function readConnectorToken(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0 || info.size > 4096) {
    throw new AppError("POLICY_INVALID", "Connector token file must be a non-empty regular file smaller than 4 KiB.");
  }
  const token = (await readFile(filePath, "utf8")).trim();
  if (token.length < 32 || token.length > 2048 || /[\r\n\0]/u.test(token)) {
    throw new AppError("POLICY_INVALID", "Connector token file contains an invalid token.");
  }
  return token;
}

function requireValue(value: string | undefined, name: string): string {
  const resolved = value?.trim();
  if (!resolved) throw new AppError("INVALID_ARGUMENT", `${name} is required.`);
  return resolved;
}

function readOptionalPositiveInteger(
  value: string | undefined,
  name: string,
  outputName: string,
): Record<string, number> {
  if (value === undefined || value.trim() === "") return {};
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 64) {
    throw new AppError("INVALID_ARGUMENT", `${name} must be a positive integer no greater than 64.`);
  }
  return { [outputName]: parsed };
}

function writeLog(entry: object): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

void main().catch((error) => {
  const appError = asAppError(error);
  process.stderr.write(`${JSON.stringify({ event: "edge_connector_process_failed", error: appError.toJSON() })}\n`);
  process.exitCode = 1;
});

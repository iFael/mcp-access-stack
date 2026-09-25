#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, asAppError } from "@vs-code-gpt/shared";
import { WindowsElevationBroker } from "@vs-code-gpt/local-agent";
import { createGatewayApplication } from "./app.js";
import { CompanionConnector, DEFAULT_COMPANION_CAPABILITIES } from "./companion/connector.js";
import { LocalBrowserWorker } from "./companion/local-browser-worker.js";
import { DesktopOAuthClient } from "./companion/desktop-oauth.js";
import { LocalRepositoryManager } from "./companion/local-repository-manager.js";
import { ReloadableLocalAgent } from "./companion/reloadable-local-agent.js";
import { createPlatformOAuthCredentialStore } from "./companion/platform-oauth-credential-store.js";
import { loadGatewayConfig } from "./config.js";
import { assertLoopbackMcpCompatibility } from "./edge/loopback-health.js";
import { closeLoopbackGateway, startLoopbackGateway } from "./edge/loopback-server.js";

type CompanionConfigFile = {
  version: 1;
  edgeBaseUrl: string;
  displayName?: string;
};

type CompanionRuntimeConfig = {
  edgeBaseUrl: URL;
  displayName?: string;
  releaseRoot: string;
  stateRoot: string;
  privateDirectory: string;
  managedRoot: string;
  credentialBrokerPath: string;
  elevationBrokerPath: string;
};

async function main(): Promise<void> {
  const runtime = await loadCompanionRuntimeConfig(process.env);
  configureBundledRuntimeTools(runtime.releaseRoot, process.env);
  const internalAssertion = randomBytes(32).toString("base64url");
  const elevationBroker =
    process.platform === "win32" &&
    await regularFileExists(runtime.elevationBrokerPath)
      ? new WindowsElevationBroker({
          brokerExecutablePath: runtime.elevationBrokerPath,
          privateDirectory: runtime.privateDirectory,
        })
      : undefined;
  if (!elevationBroker) {
    writeLog({
      event: "mcp_v3_local_elevation_unavailable",
      brokerPath: runtime.elevationBrokerPath,
    });
  }
  const reloadable = new ReloadableLocalAgent({
    ...(elevationBroker === undefined ? {} : { elevationBroker }),
  });
  let connector: CompanionConnector | undefined;
  let repositories!: LocalRepositoryManager;

  const reloadLocalRuntime = async (): Promise<void> => {
    await reloadable.reload(await repositories.buildPolicy());
    await connector?.announceState();
  };

  repositories = await LocalRepositoryManager.create({
    stateDirectory: path.join(runtime.stateRoot, "state"),
    managedRoot: runtime.managedRoot,
    homeDirectory: os.homedir(),
    onChanged: reloadLocalRuntime,
  });
  await reloadable.reload(await repositories.buildPolicy());

  let browserWorker: LocalBrowserWorker | undefined;
  if (process.platform === "win32") {
    try {
      browserWorker = await LocalBrowserWorker.start({
        releaseRoot: runtime.releaseRoot,
        stateRoot: runtime.stateRoot,
        credentialBrokerPath: runtime.credentialBrokerPath,
        log: writeLog,
      });
    } catch (error) {
      const browserError = asAppError(error);
      writeLog({
        event: "mcp_v3_local_browser_unavailable",
        error: browserError.toJSON(),
      });
    }
  }

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

  const gateway = createGatewayApplication(gatewayConfig, {
    workspaceExecutor: reloadable.workspaceExecutor,
    sourceControlExecutor: reloadable.sourceControlExecutor,
    repositoryExecutor: repositories,
    companionRepositoryBinder: repositories,
    ...(browserWorker === undefined ? {} : { browser: browserWorker.client }),
    workspaceReady: () => true,
    edgeTrust: { internalAssertion },
  });
  const loopback = await startLoopbackGateway(gateway.app);

  const credentialStore = createPlatformOAuthCredentialStore({
    platform: process.platform,
    credentialBrokerPath: runtime.credentialBrokerPath,
    privateDirectory: runtime.privateDirectory,
    edgeBaseUrl: runtime.edgeBaseUrl,
  });
  const oauth = new DesktopOAuthClient({
    edgeBaseUrl: runtime.edgeBaseUrl,
    credentialStore,
  });
  const capabilities: string[] = [...DEFAULT_COMPANION_CAPABILITIES];
  if (browserWorker) capabilities.push("browser");
  if (elevationBroker) capabilities.push("elevation");

  connector = new CompanionConnector({
    edgeBaseUrl: runtime.edgeBaseUrl,
    oauth,
    internalAssertion,
    localBaseUrl: loopback.baseUrl,
    repositories,
    capabilities,
    ...(runtime.displayName === undefined ? {} : { displayName: runtime.displayName }),
    log: writeLog,
  });

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    writeLog({ event: "mcp_v3_local_signal", signal });
    controller.abort();
    connector?.stop();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  writeLog({
    event: "mcp_v3_local_started",
    platform: process.platform,
    edgeOrigin: runtime.edgeBaseUrl.origin,
    stateRoot: runtime.stateRoot,
    managedRoot: runtime.managedRoot,
    workspaceCount: (await repositories.listWorkspaceSummaries()).length,
  });

  try {
    await assertLoopbackMcpCompatibility(loopback.baseUrl, internalAssertion);
    writeLog({ event: "mcp_v3_local_loopback_ready" });
    await connector.run(controller.signal);
  } finally {
    connector.stop();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    await gateway.close();
    await closeLoopbackGateway(loopback.server);
    await browserWorker?.close();
    writeLog({ event: "mcp_v3_local_stopped" });
  }
}

async function loadCompanionRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): Promise<CompanionRuntimeConfig> {
  const defaultStateRoot = process.platform === "win32"
    ? path.join(
        environment.LOCALAPPDATA?.trim() ||
          path.join(os.homedir(), "AppData", "Local"),
        "MCP V3",
      )
    : process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Application Support", "MCP V3")
      : path.join(
          environment.XDG_STATE_HOME?.trim() ||
            path.join(os.homedir(), ".local", "state"),
          "mcp-v3",
        );
  const stateRoot = path.resolve(
    environment.MCP_V3_STATE_ROOT?.trim() || defaultStateRoot,
  );
  const configPath = path.resolve(environment.MCP_V3_CONFIG_PATH?.trim() || path.join(stateRoot, "config.json"));
  const fileConfig = await readOptionalConfig(configPath);
  const edgeBaseUrl = new URL(
    environment.MCP_EDGE_BASE_URL?.trim() ||
    fileConfig?.edgeBaseUrl ||
    "",
  );
  assertEdgeOrigin(edgeBaseUrl);

  const releaseRoot = environment.MCP_V3_RELEASE_ROOT?.trim()
    ? path.resolve(environment.MCP_V3_RELEASE_ROOT)
    : path.resolve(path.dirname(process.execPath), "..", "..");
  const credentialBrokerPath = path.resolve(
    environment.MCP_V3_CREDENTIAL_BROKER_PATH?.trim() ||
    path.join(releaseRoot, "compat", "McpCredentialBroker.exe"),
  );

  return {
    edgeBaseUrl,
    releaseRoot,
    ...(environment.MCP_V3_DEVICE_NAME?.trim()
      ? { displayName: environment.MCP_V3_DEVICE_NAME.trim() }
      : fileConfig?.displayName
        ? { displayName: fileConfig.displayName }
        : {}),
    stateRoot,
    privateDirectory: path.resolve(
      environment.MCP_V3_PRIVATE_DIRECTORY?.trim() ||
      path.join(stateRoot, "private"),
    ),
    managedRoot: path.resolve(
      environment.MCP_V3_REPOSITORIES_ROOT?.trim() ||
      path.join(os.homedir(), "MCP V3", "Repositórios"),
    ),
    credentialBrokerPath,
    elevationBrokerPath: path.resolve(
      environment.MCP_V3_ELEVATION_BROKER_PATH?.trim() ||
      path.join(releaseRoot, "native", "McpElevationBroker.exe"),
    ),
  };
}

async function readOptionalConfig(filePath: string): Promise<CompanionConfigFile | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new AppError("POLICY_INVALID", "MCP V3 local configuration could not be read.", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError("POLICY_INVALID", "MCP V3 local configuration contains invalid JSON.", { cause: error });
  }
  if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.edgeBaseUrl !== "string" ||
      (parsed.displayName !== undefined && typeof parsed.displayName !== "string")) {
    throw new AppError("POLICY_INVALID", "MCP V3 local configuration is invalid.");
  }
  return {
    version: 1,
    edgeBaseUrl: parsed.edgeBaseUrl,
    ...(parsed.displayName === undefined ? {} : { displayName: parsed.displayName }),
  };
}

function assertEdgeOrigin(url: URL): void {
  if (url.protocol !== "https:" || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "MCP V3 edge URL must be a credential-free HTTPS origin.",
    );
  }
}

function configureBundledRuntimeTools(
  releaseRoot: string,
  environment: NodeJS.ProcessEnv,
): void {
  if (process.platform !== "win32") return;
  const bundledGit = path.join(releaseRoot, "runtime", "git", "cmd");
  const pathKey = Object.keys(environment)
    .find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = environment[pathKey]?.trim() ?? "";
  environment[pathKey] = current
    ? `${bundledGit}${path.delimiter}${current}`
    : bundledGit;
}

async function regularFileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function writeLog(entry: object): void {
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void main().catch((error) => {
  const appError = asAppError(error);
  process.stderr.write(`${JSON.stringify({ event: "mcp_v3_local_failed", error: appError.toJSON() })}\n`);
  process.exitCode = 1;
});

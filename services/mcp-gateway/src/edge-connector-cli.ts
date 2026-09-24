#!/usr/bin/env node
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import type { Express } from "express";
import {
  CompositeWorkspaceExecutor,
  InProcessWorkspaceExecutor,
  LocalAgent,
  SshWorkspaceExecutor,
  type RoutedWorkspaceExecutor,
} from "@vs-code-gpt/local-agent";
import { AppError, asAppError } from "@vs-code-gpt/shared";
import { createGatewayApplication } from "./app.js";
import { loadGatewayConfig } from "./config.js";
import { EdgeConnector } from "./edge/connector.js";
import { assertLoopbackMcpCompatibility } from "./edge/loopback-health.js";
import { createMcpServer, getMcpServerCatalogMetadata } from "./mcp/server.js";

interface WindowsCompanionRuntimeConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  knownHostsPath: string;
  policyPath: string;
  connectTimeoutMs: number;
  backgroundStateDirectory: string;
}

interface ConnectorRuntimeConfig {
  edgeBaseUrl: URL;
  connectorUrl: URL;
  tokenFile: string;
  policyPath: string;
  maxConcurrentRequests?: number;
  windowsCompanion?: WindowsCompanionRuntimeConfig;
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

  const agent = await LocalAgent.create(runtime.policyPath);
  const localExecutor = new InProcessWorkspaceExecutor(agent);
  let workspaceExecutor: RoutedWorkspaceExecutor = localExecutor;
  if (runtime.windowsCompanion) {
    const companionExecutor = await SshWorkspaceExecutor.create({
      policyPath: runtime.windowsCompanion.policyPath,
      backgroundStateDirectory: runtime.windowsCompanion.backgroundStateDirectory,
      probeOnCreate: false,
      transportConfig: {
        host: runtime.windowsCompanion.host,
        port: runtime.windowsCompanion.port,
        username: runtime.windowsCompanion.username,
        privateKeyPath: runtime.windowsCompanion.privateKeyPath,
        knownHostsPath: runtime.windowsCompanion.knownHostsPath,
        connectTimeoutMs: runtime.windowsCompanion.connectTimeoutMs,
      },
    });
    workspaceExecutor = await CompositeWorkspaceExecutor.create([
      localExecutor,
      companionExecutor,
    ]);
  }
  const identityServer = createMcpServer({
    workspaceExecutor,
    sourceControlExecutor: workspaceExecutor,
  });
  const catalogMetadata = getMcpServerCatalogMetadata(identityServer);
  const gateway = createGatewayApplication(gatewayConfig, {
    workspaceExecutor,
    sourceControlExecutor: workspaceExecutor,
    workspaceReady: () => true,
    edgeTrust: { internalAssertion },
  });
  const localServer = await startLoopbackGateway(gateway.app);
  const localAddress = localServer.address();
  if (!localAddress || typeof localAddress === "string") {
    throw new AppError("AGENT_UNAVAILABLE", "Loopback Gateway did not expose a TCP address.");
  }
  const localBaseUrl = new URL(`http://127.0.0.1:${localAddress.port}/`);
  const connector = new EdgeConnector({
    edgeUrl: runtime.connectorUrl,
    token: connectorToken,
    internalAssertion,
    localBaseUrl,
    runtimeIdentity: {
      version: 1,
      connectorInstanceId,
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
    windowsCompanionEnabled: runtime.windowsCompanion !== undefined,
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
    await closeServer(localServer);
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

  return {
    edgeBaseUrl,
    connectorUrl,
    tokenFile: path.resolve(requireValue(environment.MCP_CONNECTOR_TOKEN_FILE, "MCP_CONNECTOR_TOKEN_FILE")),
    policyPath: path.resolve(requireValue(environment.VS_CODE_GPT_POLICY_PATH, "VS_CODE_GPT_POLICY_PATH")),
    ...readOptionalPositiveInteger(environment.MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS, "MCP_CONNECTOR_MAX_CONCURRENT_REQUESTS", "maxConcurrentRequests"),
    ...loadWindowsCompanionRuntimeConfig(environment),
  };
}

function loadWindowsCompanionRuntimeConfig(
  environment: NodeJS.ProcessEnv,
): { windowsCompanion?: WindowsCompanionRuntimeConfig } {
  const enabled = readOptionalBoolean(
    environment.MCP_WINDOWS_COMPANION_ENABLED,
    "MCP_WINDOWS_COMPANION_ENABLED",
  );
  if (!enabled) return {};

  const port = readInteger(
    environment.MCP_WINDOWS_COMPANION_PORT ?? "22",
    "MCP_WINDOWS_COMPANION_PORT",
    1,
    65_535,
  );
  const connectTimeoutMs = readInteger(
    environment.MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS ?? "15000",
    "MCP_WINDOWS_COMPANION_CONNECT_TIMEOUT_MS",
    1,
    120_000,
  );
  return {
    windowsCompanion: {
      host: requireValue(environment.MCP_WINDOWS_COMPANION_HOST, "MCP_WINDOWS_COMPANION_HOST"),
      port,
      username: requireValue(environment.MCP_WINDOWS_COMPANION_USERNAME, "MCP_WINDOWS_COMPANION_USERNAME"),
      privateKeyPath: path.resolve(requireValue(environment.MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH, "MCP_WINDOWS_COMPANION_PRIVATE_KEY_PATH")),
      knownHostsPath: path.resolve(requireValue(environment.MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH, "MCP_WINDOWS_COMPANION_KNOWN_HOSTS_PATH")),
      policyPath: path.resolve(requireValue(environment.MCP_WINDOWS_COMPANION_POLICY_PATH, "MCP_WINDOWS_COMPANION_POLICY_PATH")),
      backgroundStateDirectory: path.resolve(
        environment.MCP_WINDOWS_COMPANION_BACKGROUND_STATE_DIR?.trim() ||
          "/var/lib/mcp-access-stack/windows-companion",
      ),
      connectTimeoutMs,
    },
  };
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

async function startLoopbackGateway(app: Express): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  return server;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
}

function requireValue(value: string | undefined, name: string): string {
  const resolved = value?.trim();
  if (!resolved) throw new AppError("INVALID_ARGUMENT", `${name} is required.`);
  return resolved;
}

function readOptionalBoolean(value: string | undefined, name: string): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "" || normalized === "false" || normalized === "0") {
    return false;
  }
  if (normalized === "true" || normalized === "1") return true;
  throw new AppError("INVALID_ARGUMENT", `${name} must be true or false.`);
}

function readInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `${name} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
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

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import pino, { type Logger } from "pino";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import type { GatewayConfig } from "../../src/config.js";
import {
  EDGE_INTERNAL_ASSERTION_HEADER,
  EDGE_INTERNAL_PRINCIPAL_HEADER,
  encodeEdgeAuthenticatedPrincipal,
} from "../../src/edge/internal-trust.js";
import type { GatewayApplicationDependencies } from "../../src/app.js";
import { createTestExecutor } from "./executors.js";

export const TEST_EDGE_ASSERTION = "a".repeat(43);
export const TEST_EDGE_PRINCIPAL: AuthenticatedEdgePrincipal = {
  subject: "user:test",
  scopes: ["workspaces:read"],
  ownerScope: "owner",
  userId: "usr_11111111-1111-4111-8111-111111111111",
};

export function makeGatewayConfig(
  overrides: Partial<GatewayConfig> & Record<string, unknown> = {},
): GatewayConfig {
  const base: GatewayConfig = {
    nodeEnv: "test",
    port: 0,
    publicBaseUrl: new URL("http://127.0.0.1"),
    mcpPath: "/mcp",
    trustProxy: 0,
    allowedOrigins: new Set(["https://chatgpt.com"]),
    maxPayloadBytes: 512 * 1024 * 1024,
    rateLimit: { windowMs: 60_000, max: 100 },
    logLevel: "silent",
  };
  return {
    ...base,
    ...overrides,
    rateLimit: { ...base.rateLimit, ...overrides.rateLimit },
  };
}

export function edgeHeaders(
  principal: AuthenticatedEdgePrincipal = TEST_EDGE_PRINCIPAL,
): Record<string, string> {
  return {
    [EDGE_INTERNAL_ASSERTION_HEADER]: TEST_EDGE_ASSERTION,
    [EDGE_INTERNAL_PRINCIPAL_HEADER]: encodeEdgeAuthenticatedPrincipal(principal),
  };
}

export function makeEdgeGatewayDependencies(
  overrides: Partial<GatewayApplicationDependencies> = {},
): GatewayApplicationDependencies {
  const executor = createTestExecutor();
  return {
    logger: silentLogger(),
    workspaceExecutor: executor,
    sourceControlExecutor: executor,
    workspaceReady: () => true,
    edgeTrust: { internalAssertion: TEST_EDGE_ASSERTION },
    ...overrides,
  };
}

export function silentLogger(): Logger {
  return pino({ enabled: false });
}

export async function listen(app?: Express): Promise<{
  server: Server;
  url: URL;
  close(): Promise<void>;
}> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: new URL(`http://127.0.0.1:${address.port}`),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met before timeout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

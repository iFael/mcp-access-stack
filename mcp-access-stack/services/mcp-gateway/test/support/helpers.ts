import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import pino, { type Logger } from "pino";
import type { GatewayConfig } from "../../src/config.js";

export function makeGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const base: GatewayConfig = {
    nodeEnv: "test",
    port: 0,
    publicBaseUrl: new URL("http://127.0.0.1"),
    authMode: "oauth",
    mcpPath: "/mcp",
    trustProxy: 0,
    oauth: {
      issuer: "https://issuer.example/",
      audience: "https://mcp.example",
      jwksUrl: new URL("https://issuer.example/.well-known/jwks.json"),
      allowedSubjects: new Set(["allowed-user"]),
      requiredScope: "workspaces:read",
    },
    allowedOrigins: new Set(["https://chatgpt.com"]),
    agent: {
      id: "test-agent",
      tokenSha256:
        "4f6e1f65055263866dedb3c5f66153ed5f9ea1e187d4dd67d821c9f89c71c7f4",
      requestTimeoutMs: 500,
      heartbeatMs: 1_000,
      maxConcurrency: 4,
      maxPayloadBytes: 2 * 1024 * 1024,
    },
    rateLimit: { windowMs: 60_000, max: 100 },
    logLevel: "silent",
  };
  const merged: GatewayConfig = {
    ...base,
    ...overrides,
    oauth:
      "oauth" in overrides
        ? overrides.oauth && { ...base.oauth!, ...overrides.oauth }
        : base.oauth,
    agent: { ...base.agent, ...overrides.agent },
    rateLimit: { ...base.rateLimit, ...overrides.rateLimit },
  };
  if (merged.authMode === "none") {
    merged.oauth = undefined;
  }
  return merged;
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

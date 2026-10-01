import { describe, expect, it } from "@jest/globals";
import { loadGatewayConfig } from "../../../src/config.js";

const requiredEnv = {
  PORT: "3000",
  PUBLIC_BASE_URL: "https://mcp.example.com",
};

describe("gateway internal configuration loader", () => {
  it("loads the canonical embedded gateway defaults", () => {
    const config = loadGatewayConfig({
      ...process.env,
      ...requiredEnv,
      NODE_ENV: "test",
    });

    expect(config.port).toBe(3000);
    expect(config.mcpPath).toBe("/mcp");
    expect(config.trustProxy).toBe(0);
    expect(config.maxPayloadBytes).toBe(512 * 1024 * 1024);
    expect(config.browserWorker).toBeUndefined();
    expect(config.rateLimit).toEqual({ windowMs: 60_000, max: 60 });
  });

  it("ignores retired standalone gateway variables", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      AUTH_MODE: "owner",
      OWNER_TOKEN: "x".repeat(32),
      OAUTH_ISSUER: "https://issuer.example/",
      WORKSPACE_BACKEND: "relay",
      AGENT_ID: "legacy-agent",
      AGENT_TOKEN_SHA256: "a".repeat(64),
      MCP_SESSION_MODE: "stateful-experiment",
    });

    for (const key of [
      "authMode",
      "oauth",
      "ownerOAuth",
      "workspaceBackend",
      "agent",
      "mcpSessionMode",
    ]) {
      expect(config).not.toHaveProperty(key);
    }
  });

  it.each([["/health"], ["mcp"], ["/mcp/sub"], ["/.well-known"]])(
    "rejects the MCP path %s",
    (mcpPath) => {
      expect(() =>
        loadGatewayConfig({
          ...requiredEnv,
          NODE_ENV: "test",
          MCP_PATH: mcpPath,
        }),
      ).toThrow();
    },
  );

  it("allows /agent because the relay endpoint no longer exists", () => {
    expect(loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      MCP_PATH: "/agent",
    }).mcpPath).toBe("/agent");
  });

  it("parses explicit proxy trust hops", () => {
    expect(loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      TRUST_PROXY: "1",
    }).trustProxy).toBe(1);
    expect(() =>
      loadGatewayConfig({
        ...requiredEnv,
        NODE_ENV: "test",
        TRUST_PROXY: "-1",
      }),
    ).toThrow();
  });

  it("keeps requiring https for the public base url in production", () => {
    expect(() =>
      loadGatewayConfig({
        ...requiredEnv,
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "http://mcp.example.com",
      }),
    ).toThrow(/HTTPS/u);
  });

  it("loads a configured loopback Browser Worker", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: "http://127.0.0.1:3350",
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    });
    expect(config.browserWorker?.url.href).toBe("http://127.0.0.1:3350/");
  });

  it("requires an explicit allowlist for a non-loopback Browser Worker", () => {
    expect(() => loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: "http://browser-worker:3350",
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    })).toThrow(/allowed loopback/u);

    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: "http://browser-worker:3350",
      BROWSER_WORKER_ALLOWED_HOSTS: "browser-worker",
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    });
    expect(config.browserWorker?.url.href).toBe("http://browser-worker:3350/");
  });
});

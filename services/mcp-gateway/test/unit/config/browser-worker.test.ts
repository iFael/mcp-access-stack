import { describe, expect, it } from "@jest/globals";
import { loadGatewayConfig } from "../../../src/config.js";

const baseEnvironment = {
  NODE_ENV: "test",
  PORT: "0",
  PUBLIC_BASE_URL: "https://example.test",
  MCP_PATH: "/mcp-test",
};

describe("browser worker gateway configuration", () => {
  it("keeps browser tools disabled by default", () => {
    expect(loadGatewayConfig(baseEnvironment).browserWorker).toBeUndefined();
  });

  it("loads an authenticated loopback worker when enabled", () => {
    const config = loadGatewayConfig({
      ...baseEnvironment,
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: "http://127.0.0.1:3350",
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    });

    expect(config.browserWorker).toMatchObject({
      timeoutMs: 120_000,
      maxPayloadBytes: 4 * 1024 * 1024,
    });
    expect(config.browserWorker?.url.href).toBe("http://127.0.0.1:3350/");
  });

  it("rejects non-loopback endpoints", () => {
    expect(() =>
      loadGatewayConfig({
        ...baseEnvironment,
        BROWSER_WORKER_ENABLED: "true",
        BROWSER_WORKER_URL: "https://browser.example.test",
        BROWSER_WORKER_TOKEN: "x".repeat(32),
      }),
    ).toThrow(/loopback/i);
  });
});

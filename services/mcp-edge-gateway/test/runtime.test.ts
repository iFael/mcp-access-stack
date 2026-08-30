import { describe, expect, it } from "@jest/globals";
import {
  EdgeControlPlaneConfigurationError,
  createEdgeControlPlaneRuntime,
} from "../src/control-plane/runtime.js";

const offlineExecution = {
  isReady: () => false,
  getGeneration: () => null,
  execute: async () => { throw new Error("offline execution must not run"); },
};

const storage = {
  get: async <T>(_key: string): Promise<T | undefined> => undefined,
  put: async <T>(_key: string, _value: T): Promise<void> => undefined,
  delete: async (_key: string): Promise<boolean> => false,
};

describe("Edge control-plane runtime configuration", () => {
  it("fails closed when auth mode or required auth configuration is missing", () => {
    expect(() => createEdgeControlPlaneRuntime({}, storage, offlineExecution)).toThrow(EdgeControlPlaneConfigurationError);
    expect(() => createEdgeControlPlaneRuntime({
      MCP_EDGE_AUTH_MODE: "owner",
      MCP_PUBLIC_BASE_URL: "https://edge.example/",
    }, storage, offlineExecution)).toThrow(/MCP_OWNER_/u);
    expect(() => createEdgeControlPlaneRuntime({
      MCP_EDGE_AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "https://edge.example/",
      MCP_OAUTH_ISSUER: "https://issuer.example/",
    }, storage, offlineExecution)).toThrow(/MCP_OAUTH_/u);
  });

  it("creates an Owner runtime whose discovery path stays local while execution is offline", async () => {
    const runtime = createEdgeControlPlaneRuntime({
      MCP_EDGE_AUTH_MODE: "owner",
      MCP_PUBLIC_BASE_URL: "https://edge.example/",
      MCP_OWNER_TOKEN: "x".repeat(32),
      MCP_OWNER_OAUTH_SCOPES: "mcp:tools",
      MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS: "3600",
      MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS: "2592000",
      MCP_OWNER_RESOURCE_NAME: "MCP Access Stack",
    }, storage, offlineExecution);

    const metadata = await runtime.router.route(new Request("https://edge.example/.well-known/oauth-protected-resource/mcp"));
    expect(metadata?.status).toBe(200);
    expect(await metadata!.json()).toMatchObject({
      resource: "https://edge.example/mcp",
      scopes_supported: ["mcp:tools"],
    });
  });
});
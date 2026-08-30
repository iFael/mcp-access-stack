import { describe, expect, it } from "@jest/globals";
import { loadGatewayConfig } from "../../../src/config.js";

const requiredEnv = {
  PORT: "3000",
  PUBLIC_BASE_URL: "https://mcp.example.com",
  OAUTH_ISSUER: "https://issuer.example/",
  OAUTH_AUDIENCE: "https://mcp.example.com",
  OAUTH_JWKS_URL: "https://issuer.example/.well-known/jwks.json",
  OAUTH_ALLOWED_SUBJECTS: "user-1,user-2",
  AGENT_ID: "local-agent",
  AGENT_TOKEN_SHA256: "a".repeat(64),
};

describe("gateway configuration loader", () => {
  it("loads from a realistic process environment with unknown variables", () => {
    const config = loadGatewayConfig({
      ...process.env,
      ...requiredEnv,
      NODE_ENV: "test",
    });

    expect(config.port).toBe(3000);
    expect(config.authMode).toBe("oauth");
    expect(config.mcpPath).toBe("/mcp");
    expect(config.trustProxy).toBe(0);
    expect(config.oauth?.allowedSubjects).toEqual(new Set(["user-1", "user-2"]));
    expect(config.agent.maxConcurrency).toBe(4);
    expect(config.agent.requestTimeoutMs).toBe(60_000);
    expect(config.agent.maxPayloadBytes).toBe(512 * 1024 * 1024);
  });

  it.each([
    ["AGENT_MAX_CONCURRENCY", "5"],
    ["AGENT_REQUEST_TIMEOUT_MS", "300001"],
    ["AGENT_MAX_PAYLOAD_BYTES", String(512 * 1024 * 1024 + 1)],
  ])("rejects %s above the plan maximum", (variable, value) => {
    expect(() =>
      loadGatewayConfig({ ...requiredEnv, NODE_ENV: "test", [variable]: value }),
    ).toThrow();
  });

  it("does not allow edge-trusted authentication to be selected from public environment", () => {
    expect(() => loadGatewayConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://mcp.example.com",
      AUTH_MODE: "edge-trusted",
      WORKSPACE_BACKEND: "in-process",
    })).toThrow();
  });
  it("supports auth mode none without oauth variables", () => {
    const config = loadGatewayConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://mcp.example.com",
      AUTH_MODE: "none",
      MCP_PATH: "/mcp-a8f3k2x9",
      AGENT_ID: "local-agent",
      AGENT_TOKEN_SHA256: "b".repeat(64),
    });

    expect(config.authMode).toBe("none");
    expect(config.oauth).toBeUndefined();
    expect(config.mcpPath).toBe("/mcp-a8f3k2x9");
  });

  it("supports auth mode owner with owner token", () => {
    const config = loadGatewayConfig({
      NODE_ENV: "test",
      PUBLIC_BASE_URL: "https://mcp.example.com",
      AUTH_MODE: "owner",
      OWNER_TOKEN: "c".repeat(24),
      OWNER_OAUTH_STATE_PATH: "C:\\private\\owner-oauth-state.json",
      MCP_PATH: "/mcp-owner",
      AGENT_ID: "local-agent",
      AGENT_TOKEN_SHA256: "b".repeat(64),
    });

    expect(config.authMode).toBe("owner");
    expect(config.ownerOAuth?.scopes).toEqual(["workspaces:read"]);
    expect(config.ownerOAuth?.statePath).toBe("C:\\private\\owner-oauth-state.json");
    expect(config.oauth).toBeUndefined();
  });

  it("requires oauth variables when auth mode is oauth", () => {
    const environment: Record<string, string> = {
      ...requiredEnv,
      NODE_ENV: "test",
    };
    delete environment.OAUTH_ISSUER;

    expect(() => loadGatewayConfig(environment)).toThrow(/AUTH_MODE=oauth requires/u);
  });

  it.each([["/agent"], ["/health"], ["mcp"], ["/mcp/sub"], ["/.well-known"]])(
    "rejects the MCP path %s",
    (mcpPath) => {
      expect(() =>
        loadGatewayConfig({ ...requiredEnv, NODE_ENV: "test", MCP_PATH: mcpPath }),
      ).toThrow();
    },
  );

  it("parses explicit proxy trust hops", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      TRUST_PROXY: "1",
    });

    expect(config.trustProxy).toBe(1);
    expect(() =>
      loadGatewayConfig({ ...requiredEnv, NODE_ENV: "test", TRUST_PROXY: "-1" }),
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
  it("loads an explicitly configured GPT Actions workspace allowlist", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      GPT_ACTIONS_ENABLED: "true",
      GPT_ACTIONS_TOKEN_SHA256: "c".repeat(64),
      GPT_ACTIONS_WORKSPACE_IDS: "workspace-a,workspace-b",
      GPT_ACTIONS_ALLOW_WRITE: "true",
      GPT_ACTIONS_ALLOW_SHELL: "true",
    });

    expect(config.actions).toEqual({
      tokenSha256: "c".repeat(64),
      workspaceIds: ["workspace-a", "workspace-b"],
      allowWrite: true,
      allowShell: true,
    });
  });

  it("accepts arbitrary syntactically valid workspace IDs from local configuration", () => {
    const config = loadGatewayConfig({
      ...requiredEnv,
      NODE_ENV: "test",
      GPT_ACTIONS_ENABLED: "true",
      GPT_ACTIONS_TOKEN_SHA256: "c".repeat(64),
      GPT_ACTIONS_WORKSPACE_IDS: "workspace-a,development",
    });
    expect(config.actions?.workspaceIds).toEqual(["workspace-a", "development"]);
  });

  it("loads the SSH workspace backend without a legacy Agent identity", () => {
    const environment: Record<string, string> = {
      ...requiredEnv,
      NODE_ENV: "test",
      WORKSPACE_BACKEND: "ssh",
      SSH_WORKSPACE_HOST: "workspace.example.internal",
      SSH_WORKSPACE_PORT: "2222",
      SSH_WORKSPACE_USERNAME: "developer",
      SSH_WORKSPACE_PRIVATE_KEY_PATH: "/run/secrets/workspace-key",
      SSH_WORKSPACE_KNOWN_HOSTS_PATH: "/run/secrets/known-hosts",
      SSH_WORKSPACE_POLICY_PATH: "/run/secrets/workspace-policy",
      BROWSER_WORKER_ENABLED: "true",
      BROWSER_WORKER_URL: "http://browser-worker:3350",
      BROWSER_WORKER_ALLOWED_HOSTS: "browser-worker",
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    };
    delete environment.AGENT_ID;
    delete environment.AGENT_TOKEN_SHA256;
    const config = loadGatewayConfig(environment);

    expect(config.workspaceBackend).toMatchObject({
      kind: "ssh",
      host: "workspace.example.internal",
      port: 2222,
      username: "developer",
    });
    expect(config.browserWorker?.url.href).toBe("http://browser-worker:3350/");
  });

  it("loads the in-process workspace backend without a legacy Agent identity", () => {
    const environment: Record<string, string> = {
      ...requiredEnv,
      NODE_ENV: "test",
      WORKSPACE_BACKEND: "in-process",
    };
    delete environment.AGENT_ID;
    delete environment.AGENT_TOKEN_SHA256;

    const config = loadGatewayConfig(environment);

    expect(config.workspaceBackend).toEqual({ kind: "in-process" });
    expect(config.agent.id).toBeUndefined();
    expect(config.agent.tokenSha256).toBeUndefined();
  });
  it("fails closed when the SSH backend is missing trust material", () => {
    expect(() =>
      loadGatewayConfig({
        ...requiredEnv,
        NODE_ENV: "test",
        WORKSPACE_BACKEND: "ssh",
        SSH_WORKSPACE_HOST: "workspace.example.internal",
      }),
    ).toThrow(/SSH_WORKSPACE_USERNAME/u);
  });
  it("requires a token hash when GPT Actions are enabled", () => {
    expect(() =>
      loadGatewayConfig({
        ...requiredEnv,
        NODE_ENV: "test",
        GPT_ACTIONS_ENABLED: "true",
        GPT_ACTIONS_WORKSPACE_IDS: "workspace-a,workspace-b",
      }),
    ).toThrow(/GPT_ACTIONS_TOKEN_SHA256/u);
  });
});

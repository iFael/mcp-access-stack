import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "@jest/globals";
import { AuthenticationError, type AccessTokenVerifier } from "../../../src/auth/jwt-verifier.js";
import { createGatewayApplication } from "../../../src/app.js";
import type { GatewayConfig } from "../../../src/config.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const validAuth: AuthInfo = {
  token: "valid",
  clientId: "test-client",
  scopes: ["workspaces:read"],
  expiresAt: Math.floor(Date.now() / 1_000) + 300,
  extra: { subject: "allowed-user" },
};

describe("gateway HTTP surface", () => {
  it("publishes protected resource metadata", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(
        new URL("/.well-known/oauth-protected-resource/mcp", fixture.url),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        resource: "http://127.0.0.1/mcp",
        authorization_servers: ["https://issuer.example/"],
        scopes_supported: ["workspaces:read"],
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects an untrusted Origin", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await fetch(new URL("/health/live", fixture.url), {
        headers: { origin: "https://evil.example" },
      });

      expect(response.status).toBe(403);
    } finally {
      await fixture.close();
    }
  });

  it("returns HTTP OAuth challenges for invalid access tokens", async () => {
    const fixture = await createHttpFixture({
      verify: async () => {
        throw new AuthenticationError(401, "invalid_token");
      },
    });
    try {
      const response = await postMcp(fixture.url, toolsListRequest(), "invalid");

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "oauth-protected-resource/mcp",
      );
      await expect(response.json()).resolves.toEqual({ error: "invalid_token" });
    } finally {
      await fixture.close();
    }
  });

  it("describes workspace tools with stable schemas", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await postMcp(fixture.url, toolsListRequest(), "valid");
      const body = await response.json() as {
        result: { tools: Array<Record<string, unknown>> };
      };

      expect(response.status).toBe(200);
      expect(body.result.tools.map((tool) => tool.name)).toEqual([
        "list_workspaces",
        "list_workspace_roots",
        "list_files",
        "read_file",
        "write_file",
        "run_workspace_validation",
        "run_command",
        "run_powershell",
        "start_background_task",
        "get_background_task",
        "list_background_tasks",
        "cancel_background_task",
        "read_background_task_logs",
        "search_files",
        "inspect_workspace_git",
        "get_workspace_context",
      ]);
      const writeTool = body.result.tools.find((tool) => tool.name === "write_file");
      expect(writeTool?.annotations).toEqual({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: true,
      });
      for (const tool of body.result.tools.filter(
        (entry) =>
          ![
            "write_file",
            "run_command",
            "run_powershell",
            "start_background_task",
            "cancel_background_task",
          ].includes(entry.name as string),
      )) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        });
        expect(typeof tool.inputSchema).toBe("object");
        expect(typeof tool.outputSchema).toBe("object");
        expect(tool.securitySchemes).toEqual([
          { type: "oauth2", scopes: ["workspaces:read"] },
        ]);
        expect(tool._meta).toEqual({
          securitySchemes: [{ type: "oauth2", scopes: ["workspaces:read"] }],
        });
      }
    } finally {
      await fixture.close();
    }
  });

  it("returns an MCP OAuth challenge when a tool is called without a token", async () => {
    const fixture = await createHttpFixture();
    try {
      const response = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_workspaces", arguments: {} },
      });
      const body = await response.json() as {
        result: { isError: boolean; _meta: Record<string, unknown> };
      };

      expect(response.headers.get("www-authenticate")).toContain("workspaces:read");
      expect(body.result.isError).toBe(true);
      const challenges = body.result._meta["mcp/www_authenticate"] as string[];
      expect(challenges).toBeDefined();
      expect(challenges[0]).toContain('error="insufficient_scope"');
      expect(challenges[0]).toContain("error_description=");
    } finally {
      await fixture.close();
    }
  });

  it("limits repeated requests per ip", async () => {
    const fixture = await createHttpFixture(undefined, {
      rateLimit: { windowMs: 60_000, max: 2 },
    });
    try {
      await postMcp(fixture.url, toolsListRequest());
      await postMcp(fixture.url, toolsListRequest());
      const limited = await postMcp(fixture.url, toolsListRequest());

      expect(limited.status).toBe(429);
      await expect(limited.json()).resolves.toEqual({ error: "rate_limit_exceeded" });
    } finally {
      await fixture.close();
    }
  });
});

describe("gateway personal mode without oauth", () => {
  const personalOverrides: Partial<GatewayConfig> = {
    authMode: "none",
    mcpPath: "/mcp-a8f3k2x9",
  };

  it("serves tools on the secret path without authentication", async () => {
    const fixture = await createHttpFixture(undefined, personalOverrides);
    try {
      const response = await postMcp(fixture.url, toolsListRequest(), undefined, "/mcp-a8f3k2x9");
      const body = await response.json() as {
        result: { tools: Array<Record<string, unknown>> };
      };

      expect(response.status).toBe(200);
      expect(body.result.tools).toHaveLength(16);
      for (const tool of body.result.tools) {
        expect(tool.securitySchemes).toEqual([{ type: "noauth" }]);
        expect(tool._meta).toEqual({ securitySchemes: [{ type: "noauth" }] });
      }
    } finally {
      await fixture.close();
    }
  });

  it("executes tool calls without a token and without oauth challenges", async () => {
    const fixture = await createHttpFixture(undefined, personalOverrides);
    try {
      const response = await postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "list_workspaces", arguments: {} },
        },
        undefined,
        "/mcp-a8f3k2x9",
      );
      const body = await response.json() as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          _meta?: Record<string, unknown>;
        };
      };

      expect(response.status).toBe(200);
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("AGENT_UNAVAILABLE");
      expect(body.result._meta?.["mcp/www_authenticate"]).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("accepts requests from the ChatGPT origin without an allowlist", async () => {
    const fixture = await createHttpFixture(undefined, {
      ...personalOverrides,
      allowedOrigins: new Set(),
    });
    try {
      const response = await fetch(new URL("/mcp-a8f3k2x9", fixture.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          origin: "https://chatgpt.com",
        },
        body: JSON.stringify(toolsListRequest()),
      });

      expect(response.status).toBe(200);
    } finally {
      await fixture.close();
    }
  });

  it("hides the default path and oauth metadata", async () => {
    const fixture = await createHttpFixture(undefined, personalOverrides);
    try {
      const defaultPath = await postMcp(fixture.url, toolsListRequest());
      const metadata = await fetch(
        new URL("/.well-known/oauth-protected-resource", fixture.url),
      );

      expect(defaultPath.status).toBe(404);
      expect(metadata.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });
});

async function createHttpFixture(
  verifier?: AccessTokenVerifier,
  overrides: Partial<GatewayConfig> = {},
) {
  const gateway = createGatewayApplication(makeGatewayConfig(overrides), {
    logger: silentLogger(),
    tokenVerifier: verifier ?? { verify: async () => validAuth },
  });
  const http = await listen(gateway.app);
  return {
    ...http,
    close: async () => {
      gateway.relay!.close();
      await http.close();
    },
  };
}

function toolsListRequest() {
  return { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
}

function postMcp(
  url: URL,
  body: unknown,
  token?: string,
  path = "/mcp",
): Promise<Response> {
  return fetch(new URL(path, url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

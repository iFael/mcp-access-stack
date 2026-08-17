import { createHash } from "node:crypto";
import express from "express";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { describe, expect, it, jest } from "@jest/globals";
import { AgentConnection } from "../../../workspace-agent/src/connection/service.js";
import { LocalAgent } from "../../../workspace-agent/src/local-agent.js";
import {
  createFixture,
  writeWorkspaceFile,
} from "../../../workspace-agent/test/support/helpers.js";
import { createGatewayApplication } from "../../src/app.js";
import { listen, makeGatewayConfig, silentLogger, waitFor } from "../support/helpers.js";

jest.setTimeout(30_000);

describe("gateway to local agent integration", () => {
  it("reads a workspace file through MCP using a local JWKS", async () => {
    const keyPair = await generateKeyPair("RS256", { extractable: true });
    const publicJwk = await exportJWK(keyPair.publicKey);
    publicJwk.kid = "e2e-key";
    publicJwk.alg = "RS256";
    const jwksApp = express();
    jwksApp.get("/.well-known/jwks.json", (_request, response) => {
      response.json({ keys: [publicJwk] });
    });
    const jwks = await listen(jwksApp);
    const issuer = jwks.url.href;
    const agentToken = "e2e-agent-token";
    const config = makeGatewayConfig({
      oauth: {
        issuer,
        audience: "https://mcp.e2e.example",
        jwksUrl: new URL("/.well-known/jwks.json", jwks.url),
        allowedSubjects: new Set(["allowed-user"]),
        requiredScope: "workspaces:read",
      },
      agent: {
        id: "test-agent",
        tokenSha256: createHash("sha256").update(agentToken).digest("hex"),
        requestTimeoutMs: 2_000,
        heartbeatMs: 1_000,
        maxConcurrency: 4,
        maxPayloadBytes: 2 * 1024 * 1024,
      },
    });
    const gateway = createGatewayApplication(config, { logger: silentLogger() });
    const http = await listen(gateway.app);
    http.server.on("upgrade", (request, socket, head) => {
      gateway.relay!.handleUpgrade(request, socket, head);
    });
    const workspace = await createFixture();
    const abortController = new AbortController();

    try {
      await writeWorkspaceFile(workspace.workspacePath, "src/example.txt", "phase two content\n");
      const localAgent = await LocalAgent.create(workspace.policyPath);
      const connection = new AgentConnection(localAgent, {
        gatewayUrl: new URL("/agent", http.url).href.replace("http:", "ws:"),
        agentId: "test-agent",
        token: agentToken,
        heartbeatIntervalMs: 1_000,
        reconnectMinMs: 10,
        reconnectMaxMs: 50,
      });
      const connectionRun = connection.run(abortController.signal);
      await waitFor(() => gateway.relay!.isConnected);
      const accessToken = await new SignJWT({
        scope: "workspaces:read",
        azp: "e2e-client",
      })
        .setProtectedHeader({ alg: "RS256", kid: "e2e-key" })
        .setIssuer(issuer)
        .setAudience("https://mcp.e2e.example")
        .setSubject("allowed-user")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keyPair.privateKey);

      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "read_file",
            arguments: { workspaceId: "test", path: "src/example.txt" },
          },
        }),
      });
      const body = await response.json() as {
        result: { structuredContent: { content: string; path: string } };
      };

      expect(response.status).toBe(200);
      expect(body.result.structuredContent).toMatchObject({
        path: "src/example.txt",
        content: "phase two content\n",
      });

      abortController.abort();
      await connectionRun;
    } finally {
      abortController.abort();
      gateway.relay!.close();
      await http.close();
      await jwks.close();
      await workspace.cleanup();
    }
  });

  it("routes aggregate workspace discovery from catalog to bounded file read", async () => {
    const agentToken = "routing-agent-token";
    const config = makeGatewayConfig({
      authMode: "none",
      agent: {
        id: "test-agent",
        tokenSha256: createHash("sha256").update(agentToken).digest("hex"),
        requestTimeoutMs: 2_000,
        heartbeatMs: 1_000,
        maxConcurrency: 4,
        maxPayloadBytes: 2 * 1024 * 1024,
      },
    });
    const gateway = createGatewayApplication(config, { logger: silentLogger() });
    const http = await listen(gateway.app);
    http.server.on("upgrade", (request, socket, head) => {
      gateway.relay!.handleUpgrade(request, socket, head);
    });
    const workspace = await createFixture({ workspaceKind: "aggregate" });
    const abortController = new AbortController();

    try {
      await writeWorkspaceFile(
        workspace.workspacePath,
        "sample-repository/package.json",
        "{\"name\":\"sample-repository\"}\n",
      );
      const localAgent = await LocalAgent.create(workspace.policyPath);
      const connection = new AgentConnection(localAgent, {
        gatewayUrl: new URL("/agent", http.url).href.replace("http:", "ws:"),
        agentId: "test-agent",
        token: agentToken,
        heartbeatIntervalMs: 1_000,
        reconnectMinMs: 10,
        reconnectMaxMs: 50,
      });
      const connectionRun = connection.run(abortController.signal);
      await waitFor(() => gateway.relay!.isConnected);

      const post = async (payload: Record<string, unknown>) => {
        const response = await fetch(new URL("/mcp", http.url), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        return await response.json() as Record<string, unknown>;
      };
      const callTool = async (id: number, name: string, args: Record<string, unknown>) =>
        await post({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        });

      const listed = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      });
      const listedResult = listed.result as { tools: Array<{ name: string }> };
      expect(listedResult.tools.map((tool) => tool.name)).toContain("list_workspace_roots");

      const workspaces = await callTool(2, "list_workspaces", {});
      const workspacesResult = workspaces.result as {
        structuredContent: { workspaces: Array<{ id: string; workspaceKind?: string }> };
      };
      expect(workspacesResult.structuredContent.workspaces).toContainEqual(
        expect.objectContaining({ id: "test", workspaceKind: "aggregate" }),
      );

      const broad = await callTool(3, "list_files", { workspaceId: "test" });
      const broadResult = broad.result as { isError?: boolean; content?: Array<{ text?: string }> };
      const broadText = JSON.stringify(broadResult.content ?? []);
      expect(broadResult.isError).toBe(true);
      expect(broadText).toContain("INVALID_ARGUMENT");
      expect(broadText).toContain("list_workspace_roots");
      expect(broadText).not.toContain("AGENT_TIMEOUT");

      const roots = await callTool(4, "list_workspace_roots", { workspaceId: "test" });
      const rootsResult = roots.result as {
        structuredContent: { roots: string[]; truncated: boolean };
      };
      expect(rootsResult.structuredContent).toEqual({
        roots: ["sample-repository"],
        truncated: false,
      });

      const context = await callTool(5, "get_workspace_context", {
        workspaceId: "test",
        root: "sample-repository",
      });
      const contextResult = context.result as { structuredContent: { rootPath: string } };
      expect(contextResult.structuredContent.rootPath).toBe("sample-repository");

      const files = await callTool(6, "list_files", {
        workspaceId: "test",
        root: "sample-repository",
      });
      const filesResult = files.result as { structuredContent: { files: string[] } };
      expect(filesResult.structuredContent.files).toContain(
        "sample-repository/package.json",
      );

      const read = await callTool(7, "read_file", {
        workspaceId: "test",
        path: "sample-repository/package.json",
      });
      const readResult = read.result as { structuredContent: { content: string } };
      expect(readResult.structuredContent.content).toContain("sample-repository");

      abortController.abort();
      await connectionRun;
    } finally {
      abortController.abort();
      gateway.relay!.close();
      await http.close();
      await workspace.cleanup();
    }
  });

  it("reconnects the local agent after an initial upgrade failure", async () => {
    const agentToken = "reconnect-agent-token";
    const config = makeGatewayConfig({
      agent: {
        id: "test-agent",
        tokenSha256: createHash("sha256").update(agentToken).digest("hex"),
        requestTimeoutMs: 1_000,
        heartbeatMs: 1_000,
        maxConcurrency: 4,
        maxPayloadBytes: 64_000,
      },
    });
    const gateway = createGatewayApplication(config, { logger: silentLogger() });
    const http = await listen(gateway.app);
    let upgrades = 0;
    http.server.on("upgrade", (request, socket, head) => {
      upgrades += 1;
      if (upgrades === 1) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
        return;
      }
      gateway.relay!.handleUpgrade(request, socket, head);
    });
    const abortController = new AbortController();
    const localAgent = {
      listWorkspaces: async () => [],
      listFiles: async () => ({ files: [], truncated: false }),
      readFile: async () => {
        throw new Error("not used");
      },
      searchFiles: async () => ({ matches: [], truncated: false, skippedFiles: 0 }),
      inspectGit: async () => ({ status: [], staged: "", unstaged: "", truncated: false }),
    } as unknown as LocalAgent;
    const connection = new AgentConnection(localAgent, {
      gatewayUrl: new URL("/agent", http.url).href.replace("http:", "ws:"),
      agentId: "test-agent",
      token: agentToken,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    const running = connection.run(abortController.signal);

    try {
      await waitFor(() => gateway.relay!.isConnected);
      expect(upgrades).toBeGreaterThanOrEqual(2);
    } finally {
      abortController.abort();
      await running;
      gateway.relay!.close();
      await http.close();
    }
  });
});

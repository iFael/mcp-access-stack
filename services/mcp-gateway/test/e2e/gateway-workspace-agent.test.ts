import { describe, expect, it, jest } from "@jest/globals";
import { LocalAgent } from "../../../workspace-agent/src/local-agent.js";
import {
  createFixture,
  writeWorkspaceFile,
} from "../../../workspace-agent/test/support/helpers.js";
import { createGatewayApplication } from "../../src/app.js";
import {
  edgeHeaders,
  listen,
  makeEdgeGatewayDependencies,
  makeGatewayConfig,
} from "../support/helpers.js";

jest.setTimeout(30_000);

describe("gateway to embedded local agent integration", () => {
  it("reads a workspace file through MCP using the embedded LocalAgent", async () => {
    const workspace = await createFixture();
    let gateway: ReturnType<typeof createGatewayApplication> | undefined;
    let http: Awaited<ReturnType<typeof listen>> | undefined;

    try {
      await writeWorkspaceFile(
        workspace.workspacePath,
        "src/example.txt",
        "phase two content\n",
      );
      const localAgent = await LocalAgent.create(workspace.policyPath);
      gateway = createGatewayApplication(
        makeGatewayConfig(),
        makeEdgeGatewayDependencies({
          workspaceExecutor: localAgent,
        }),
      );
      http = await listen(gateway.app);

      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...edgeHeaders(),
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
    } finally {
      await gateway?.close();
      await http?.close();
      await workspace.cleanup();
    }
  });

  it("routes aggregate workspace discovery from catalog to bounded file read", async () => {
    const workspace = await createFixture({ workspaceKind: "aggregate" });
    let gateway: ReturnType<typeof createGatewayApplication> | undefined;
    let http: Awaited<ReturnType<typeof listen>> | undefined;

    try {
      await writeWorkspaceFile(
        workspace.workspacePath,
        "sample-repository/package.json",
        "{\"name\":\"sample-repository\"}\n",
      );
      const localAgent = await LocalAgent.create(workspace.policyPath);
      gateway = createGatewayApplication(
        makeGatewayConfig(),
        makeEdgeGatewayDependencies({
          workspaceExecutor: localAgent,
        }),
      );
      http = await listen(gateway.app);

      const post = async (payload: Record<string, unknown>) => {
        const response = await fetch(new URL("/mcp", http!.url), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...edgeHeaders(),
          },
          body: JSON.stringify(payload),
        });
        expect(response.status).toBe(200);
        return await response.json() as Record<string, unknown>;
      };
      const callTool = async (
        id: number,
        name: string,
        args: Record<string, unknown>,
      ) => await post({
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
      expect(listedResult.tools.map((tool) => tool.name)).toContain(
        "list_workspace_roots",
      );

      const workspaces = await callTool(2, "list_workspaces", {});
      const workspacesResult = workspaces.result as {
        structuredContent: {
          workspaces: Array<{ id: string; workspaceKind?: string }>;
        };
      };
      expect(workspacesResult.structuredContent.workspaces).toContainEqual(
        expect.objectContaining({ id: "test", workspaceKind: "aggregate" }),
      );

      const broad = await callTool(3, "list_files", { workspaceId: "test" });
      const broadResult = broad.result as {
        isError?: boolean;
        content?: Array<{ text?: string }>;
      };
      const broadText = JSON.stringify(broadResult.content ?? []);
      expect(broadResult.isError).toBe(true);
      expect(broadText).toContain("INVALID_ARGUMENT");
      expect(broadText).toContain("list_workspace_roots");
      expect(broadText).not.toContain("AGENT_TIMEOUT");

      const roots = await callTool(4, "list_workspace_roots", {
        workspaceId: "test",
      });
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
      const contextResult = context.result as {
        structuredContent: { rootPath: string };
      };
      expect(contextResult.structuredContent.rootPath).toBe(
        "sample-repository",
      );

      const files = await callTool(6, "list_files", {
        workspaceId: "test",
        root: "sample-repository",
      });
      const filesResult = files.result as {
        structuredContent: { files: string[] };
      };
      expect(filesResult.structuredContent.files).toContain(
        "sample-repository/package.json",
      );

      const read = await callTool(7, "read_file", {
        workspaceId: "test",
        path: "sample-repository/package.json",
      });
      const readResult = read.result as {
        structuredContent: { content: string };
      };
      expect(readResult.structuredContent.content).toContain(
        "sample-repository",
      );
    } finally {
      await gateway?.close();
      await http?.close();
      await workspace.cleanup();
    }
  });
});

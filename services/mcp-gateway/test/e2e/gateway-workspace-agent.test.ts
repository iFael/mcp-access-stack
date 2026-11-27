import { describe, expect, it, jest } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { InProcessWorkspaceExecutor } from "../../../workspace-agent/src/in-process-workspace-executor.js";
import { createMcpServer } from "../../src/mcp/server.js";
import { LocalAgent } from "../../../workspace-agent/src/local-agent.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  makeWorkspacePolicy,
  writePolicy,
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
  it("stages and commits once through real persistent mutation receipts and replays the same composite identity", async () => {
    const workspace = await createFixture({ profile: "full-repo-write", confirmationMode: "trusted-workspace" });
    const root = workspace.workspacePath;
    let server: ReturnType<typeof createMcpServer> | undefined;
    let client: Client | undefined;
    try {
      initializeGitRepository(root);
      git(root, ["checkout", "-b", "feature/composite-receipts"]);
      await writeWorkspaceFile(root, "base.txt", "base\n");
      git(root, ["add", "base.txt"]);
      git(root, ["commit", "-m", "baseline"]);
      const head = git(root, ["rev-parse", "HEAD"]).trim();
      await writePolicy(workspace.policyPath, [{
        ...makeWorkspacePolicy(root, {profile: "full-repo-write", confirmationMode: "trusted-workspace"}),
        allowWrites: ["."],
        sourceControl: {capabilities: ["git.index.write", "git.commit.write"], accountOwners: [], additionalRepositories: []},
      }]);
      await writeWorkspaceFile(root, "base.txt", "changed\n");
      await writeWorkspaceFile(root, "unrelated.txt", "preserve\n");

      const input = {workspaceId: "test", paths: ["base.txt"], expectedHeadSha: head, message: "composite"};
      const identity = "composite-e2e-stable";
      const connect = async () => {
        // A new LocalAgent reconstructs the file-backed receipt store from disk.
        const executor = new InProcessWorkspaceExecutor(await LocalAgent.create(workspace.policyPath));
        server = createMcpServer({workspaceExecutor: executor, sourceControlExecutor: executor,
          operationContextFactory: (extra, _timeoutMs) => ({
            context: {signal: extra.signal, idempotencyKey: identity, ownerScope: "owner:test"},
            release: () => undefined,
          }),
        });
        client = new Client({name: "composite-e2e", version: "0.0.0"}, {capabilities: {}});
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);
      };
      await connect();
      const first = await client!.callTool({name: "git_commit_paths", arguments: input});
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({status: "completed", previousHeadSha: head, paths: ["base.txt"]});
      const committed = git(root, ["rev-parse", "HEAD"]).trim();
      expect(first.structuredContent).toMatchObject({commitSha: committed});
      expect(git(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
      expect(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", committed]).trim()).toBe("base.txt");
      expect(git(root, ["status", "--short"])).toContain("?? unrelated.txt");
      await client!.close();
      await server!.close();
      await connect();
      const replay = await client!.callTool({name: "git_commit_paths", arguments: input});
      expect(replay.structuredContent).toEqual(first.structuredContent);
      const conflict = await client!.callTool({name: "git_commit_paths", arguments: {...input, message: "changed identity"}});
      expect(conflict.structuredContent).toMatchObject({
        status: "reconciliation_required", phase: "commit",
        error: {code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT"},
      });
      expect(git(root, ["rev-parse", "HEAD"]).trim()).toBe(committed);
      expect(git(root, ["rev-list", "--count", "HEAD"]).trim()).toBe("2");
      expect(git(root, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    } finally {
      await client?.close();
      await server?.close();
      await workspace.cleanup();
    }
  });

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

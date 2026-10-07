import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, jest } from "@jest/globals";
import {
  COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
  COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
} from "@mcp-access-stack/edge-protocol";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolContractRevision,
} from "@vs-code-gpt/shared";
import { LocalRepositoryManager } from "../../../src/companion/local-repository-manager.js";
import { ReloadableLocalAgent } from "../../../src/companion/reloadable-local-agent.js";
import { createTestExecutor } from "../../support/executors.js";
import {
  createMcpServer,
  getMcpServerCatalogMetadata,
} from "../../../src/mcp/server.js";

const execFileAsync = promisify(execFile);

describe("MCP public catalog stability", () => {
  it("publishes the complete catalog and advertises catalog changes even when browser execution is unavailable", async () => {
    const executor = createTestExecutor();
    const server = createMcpServer({
      workspaceExecutor: executor,
      sourceControlExecutor: executor,
    });
    const client = new Client(
      { name: "catalog-surface-stability", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const metadata = listed._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;

      expect(listed.tools).toHaveLength(93);
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["patch_file", "patch_files", "run_workspace_validations", "wait_background_tasks", "git_commit_paths", "git_sync_branch", "github_get_commit_checks", "github_start_commit_checks_watch", "github_get_commit_checks_watches", "github_wait_commit_checks_watch", "github_close_pull_request", "browser_status", "get_current_user", "get_onboarding_state", "list_repositories", "create_repository", "discover_local_repositories", "import_repositories", "materialize_repository", "sync_repository", "list_devices", "revoke_device"]),
      );
      expect(metadata).toMatchObject({
        toolCount: 93,
        contractRevision: createMcpToolContractRevision(listed.tools),
      });
      expect(getMcpServerCatalogMetadata(server)).toEqual(metadata);
      expect(client.getServerVersion()?.version).toBe(metadata?.serverVersion);
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("keeps companion-internal tools executable but outside the published MCP catalog", async () => {
    const executor = createTestExecutor();
    const bindRepositories = jest.fn(async (bindings: Array<{
      repositoryId: string;
      workspaceId: string;
      path: string;
    }>) => bindings.map((binding) => ({
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      path: binding.path,
      name: "fixture",
      remoteUrls: ["https://example.invalid/fixture.git"],
      managed: false,
    })));
    const materializeRepositoryFromCloud = jest.fn(async (input: {
      repositoryId: string;
      name: string;
      remoteUrls: string[];
      targetName?: string;
      workspaceId?: string;
    }) => ({
      repositoryId: input.repositoryId,
      workspaceId: input.workspaceId ?? "fixture",
      path: "C:/managed/fixture",
      name: input.name,
      remoteUrls: input.remoteUrls,
      managed: true,
    }));
    const server = createMcpServer({
      workspaceExecutor: executor,
      sourceControlExecutor: executor,
      companionRepositoryBinder: {
        bindRepositories,
        materializeRepositoryFromCloud,
      },
    });
    const client = new Client(
      { name: "companion-internal-catalog", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(93);
      expect(listed.tools.some((tool) => tool.name === COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL)).toBe(false);
      expect(listed.tools.some((tool) => tool.name === COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL)).toBe(false);

      const repositoryId = "repo_11111111-1111-4111-8111-111111111111";
      const result = await client.callTool({
        name: COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
        arguments: {
          bindings: [{
            repositoryId,
            name: "fixture",
            path: "C:/fixture",
            workspaceId: "fixture",
            remoteUrls: ["https://example.invalid/fixture.git"],
            managed: false,
          }],
        },
      });

      expect(bindRepositories).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toEqual({
        bound: [{
          repositoryId,
          workspaceId: "fixture",
          path: "C:/fixture",
        }],
      });

      const materialized = await client.callTool({
        name: COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
        arguments: {
          repositoryId,
          name: "fixture",
          remoteUrls: ["https://example.invalid/fixture.git"],
          workspaceId: "fixture",
          dryRun: true,
        },
      });

      expect(materializeRepositoryFromCloud).toHaveBeenCalledTimes(1);
      expect(materialized.structuredContent).toEqual({
        materialization: {
          repositoryId,
          workspaceId: "fixture",
          path: "C:/managed/fixture",
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("reuses the internal materializer to make a remote-runtime clone immediately available as a workspace", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "mcp-v3-remote-materialize-")),
    );
    const source = path.join(temporaryRoot, "source");
    const remotes = path.join(temporaryRoot, "remotes");
    const remote = path.join(remotes, "fixture.git");
    const gitConfigPath = path.join(temporaryRoot, "gitconfig");
    let client: Client | undefined;
    let server: ReturnType<typeof createMcpServer> | undefined;

    try {
      await mkdir(source, { recursive: true });
      await mkdir(remotes, { recursive: true });
      await execFileAsync("git", ["init", source]);
      await execFileAsync("git", ["-C", source, "config", "user.name", "MCP V3 Test"]);
      await execFileAsync("git", ["-C", source, "config", "user.email", "mcp-v3@example.invalid"]);
      await writeFile(path.join(source, "tracked.txt"), "tracked\n", "utf8");
      await execFileAsync("git", ["-C", source, "add", "tracked.txt"]);
      await execFileAsync("git", ["-C", source, "commit", "-m", "fixture"]);
      await execFileAsync("git", ["clone", "--bare", source, remote]);
      await writeFile(
        gitConfigPath,
        `[url "${pathToFileURL(remotes + path.sep).href}"]\n\tinsteadOf = https://fixture.invalid/\n`,
        "utf8",
      );

      const reloadable = new ReloadableLocalAgent();
      let repositories!: LocalRepositoryManager;
      const reload = async (): Promise<void> => {
        await reloadable.reload(await repositories.buildPolicy());
      };
      repositories = await LocalRepositoryManager.create({
        stateDirectory: path.join(temporaryRoot, "state"),
        managedRoot: path.join(temporaryRoot, "managed"),
        homeDirectory: temporaryRoot,
        gitEnvironment: {
          GIT_CONFIG_GLOBAL: gitConfigPath,
          GIT_CONFIG_NOSYSTEM: "1",
        },
        onChanged: reload,
      });
      await reload();

      server = createMcpServer({
        workspaceExecutor: reloadable.workspaceExecutor,
        sourceControlExecutor: reloadable.sourceControlExecutor,
        companionRepositoryBinder: repositories,
      });
      client = new Client(
        { name: "remote-runtime-materialization", version: "0.0.0" },
        { capabilities: {} },
      );
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      const before = await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(before.structuredContent).toEqual({ workspaces: [] });

      const repositoryId = "repo_22222222-2222-4222-8222-222222222222";
      const materialized = await client.callTool({
        name: COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL,
        arguments: {
          repositoryId,
          name: "fixture",
          remoteUrls: ["https://fixture.invalid/fixture.git"],
          workspaceId: "fixture-remote",
          dryRun: false,
        },
      });
      expect(materialized.structuredContent).toMatchObject({
        materialization: {
          repositoryId,
          workspaceId: "fixture-remote",
        },
      });

      const after = await client.callTool({ name: "list_workspaces", arguments: {} });
      expect(after.structuredContent).toMatchObject({
        workspaces: [expect.objectContaining({
          id: "fixture-remote",
          workspaceKind: "repository",
          writesEnabled: true,
          shellsEnabled: true,
        })],
      });
    } finally {
      await client?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

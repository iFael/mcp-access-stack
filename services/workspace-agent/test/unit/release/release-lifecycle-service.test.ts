import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { ReleaseLifecycleService } from "../../../src/release/release-lifecycle-service.js";

const ACTIVE = "1.1.0-beta.50";
const CANDIDATE = "1.1.0-beta.51";
const ISO = "2026-09-21T00:00:00.000Z";

describe("ReleaseLifecycleService", () => {
  let installationRoot: string;
  let previousInstallationRoot: string | undefined;
  let previousStackRoot: string | undefined;
  let workspace: ResolvedWorkspace;

  beforeEach(async () => {
    installationRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-release-service-"));
    previousInstallationRoot = process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT;
    previousStackRoot = process.env.VS_CODE_GPT_STACK_ROOT;
    process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT = installationRoot;
    workspace = {
      id: "ws",
      rootPath: path.join(installationRoot, "project"),
    } as ResolvedWorkspace;
    process.env.VS_CODE_GPT_STACK_ROOT = workspace.rootPath;
    await mkdir(workspace.rootPath, { recursive: true });
  });

  afterEach(async () => {
    if (previousInstallationRoot === undefined) {
      delete process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT;
    } else {
      process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT = previousInstallationRoot;
    }
    if (previousStackRoot === undefined) {
      delete process.env.VS_CODE_GPT_STACK_ROOT;
    } else {
      process.env.VS_CODE_GPT_STACK_ROOT = previousStackRoot;
    }
    await rm(installationRoot, { recursive: true, force: true });
  });

  it("rejects release lifecycle access from a non-canonical workspace", async () => {
    await writeState({ candidate: null });
    const service = new ReleaseLifecycleService({} as any, {} as any);
    const other = {
      ...workspace,
      id: "other",
      rootPath: path.join(installationRoot, "other"),
    } as ResolvedWorkspace;

    await expect(service.getState(other)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("reports whether the active release contains signed lifecycle bootstraps", async () => {
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");
    await writeBootstrap("Start-McpAccessStackCutover.ps1");

    const service = new ReleaseLifecycleService({} as any, {} as any);
    const result = await service.getState(workspace);

    expect(result.state.active?.releaseId).toBe(ACTIVE);
    expect(result.activeBootstrap).toEqual({
      updateScriptPresent: true,
      cutoverScriptPresent: true,
    });
  });

  it("fails closed when the active release does not contain the signed updater bootstrap", async () => {
    await writeState({ candidate: null });

    const service = new ReleaseLifecycleService({} as any, {} as any);
    await expect(
      service.prepare(
        workspace,
        "iFael/mcp-access-stack",
        { workspaceId: "ws", tag: "v1.1.0-beta.51" },
        {},
      ),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
    });
  });

  it("prepares through a fixed AllSigned updater command and a persisted background task", async () => {
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");

    let authorizedInput: any;
    let startedInput: any;
    const shell = {
      authorizeBackgroundCommand: async (_workspace: ResolvedWorkspace, input: unknown) => {
        authorizedInput = input;
        return { logicalCwd: ".", absoluteCwd: workspace.rootPath };
      },
      runCommand: async () => {
        throw new Error("not used");
      },
    };
    const background = {
      start_background_task: async (input: any) => {
        startedInput = input;
        return {
          version: 1 as const,
          id: "123e4567-e89b-42d3-a456-426614174000",
          workspaceId: "ws",
          operation: "prepare_release",
          commandHash: "0".repeat(64),
          command: input.command,
          shell: "pwsh" as const,
          cwd: ".",
          state: "running" as const,
          createdAt: ISO,
          startedAt: ISO,
          timeoutMs: input.timeoutMs,
          pid: 4242,
        };
      },
    };
    const service = new ReleaseLifecycleService(shell as any, background as any);

    const result = await service.prepare(
      workspace,
      "iFael/mcp-access-stack",
      { workspaceId: "ws", tag: "v1.1.0-beta.51" },
      {},
    );

    expect(result.status).toBe("background_task_started");
    expect(authorizedInput.command).toContain("Update-McpAccessStack.ps1");
    expect(authorizedInput.command).toContain("-ExecutionPolicy AllSigned");
    expect(authorizedInput.command).toContain("iFael/mcp-access-stack");
    expect(authorizedInput.command).toContain("v1.1.0-beta.51");
    expect(authorizedInput.command).not.toContain("AllowUnsignedDevelopment");
    expect(startedInput.operation).toBe("prepare_release");
    expect(startedInput.command).toBe(authorizedInput.command);
    expect(startedInput.timeoutMs).toBe(30 * 60 * 1_000);
  });

  it("promotes only the staged candidate using persisted recovery configuration", async () => {
    await writeState({
      candidate: {
        releaseId: CANDIDATE,
        manifestSha256: "1".repeat(64),
        materializedAt: ISO,
      },
    });
    await writeBootstrap("Start-McpAccessStackCutover.ps1");
    await writeRecoveryConfig();

    let executedInput: any;
    const requestId = "123e4567-e89b-42d3-a456-426614174001";
    const shell = {
      authorizeBackgroundCommand: async () => {
        throw new Error("not used");
      },
      runCommand: async (_workspace: ResolvedWorkspace, input: any) => {
        executedInput = input;
        return {
          status: "executed" as const,
          shell: "pwsh" as const,
          cwd: ".",
          exitCode: 0,
          stdout:
            JSON.stringify({
              status: "started",
              detached: true,
              requestId,
              releaseId: CANDIDATE,
              brokerTaskName: "MCP Access Stack production cutover-broker",
              requestPath: path.join(installationRoot, "state", "request.json"),
              resultPath: path.join(installationRoot, "state", "result.json"),
            }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    };
    const service = new ReleaseLifecycleService(shell as any, {} as any);

    const result = await service.promote(
      workspace,
      { workspaceId: "ws", releaseId: CANDIDATE },
      {},
    );

    expect(result).toMatchObject({
      status: "handover_started",
      releaseId: CANDIDATE,
      requestId,
      projectRoot: workspace.rootPath,
    });
    expect(executedInput.command).toContain("Start-McpAccessStackCutover.ps1");
    expect(executedInput.command).toContain("-ExecutionPolicy AllSigned");
    expect(executedInput.command).toContain(CANDIDATE);
    expect(executedInput.command).toContain("connector-token.txt");
    expect(executedInput.command).not.toContain("AllowUnsignedDevelopment");
  });

  it("fails closed when persisted recovery projectRoot differs from the canonical workspace", async () => {
    await writeState({
      candidate: {
        releaseId: CANDIDATE,
        manifestSha256: "1".repeat(64),
        materializedAt: ISO,
      },
    });
    await writeBootstrap("Start-McpAccessStackCutover.ps1");
    await writeRecoveryConfig(path.join(installationRoot, "legacy-project"));

    const service = new ReleaseLifecycleService({} as any, {} as any);
    await expect(
      service.promote(
        workspace,
        { workspaceId: "ws", releaseId: CANDIDATE },
        {},
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_STATE_INVALID",
    });
  });

  async function writeState({
    candidate,
  }: {
    candidate:
      | {
          releaseId: string;
          manifestSha256: string;
          materializedAt: string;
        }
      | null;
  }): Promise<void> {
    const stateRoot = path.join(installationRoot, "state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      path.join(stateRoot, "lifecycle-state.v1.json"),
      JSON.stringify({
        version: 1,
        active: {
          releaseId: ACTIVE,
          manifestSha256: "0".repeat(64),
          materializedAt: ISO,
        },
        candidate,
        previous: null,
        updatedAt: ISO,
      }),
      "utf8",
    );
  }

  async function writeBootstrap(name: string): Promise<void> {
    const directory = path.join(
      installationRoot,
      "releases",
      ACTIVE,
      "deploy",
      "windows",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), "# signed in production\n", "utf8");
  }

  async function writeRecoveryConfig(
    projectRoot = workspace.rootPath,
  ): Promise<void> {
    const stateRoot = path.join(installationRoot, "state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(
      path.join(stateRoot, "edge-task-config.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        taskName: "MCP Access Stack production edge-connector",
        projectRoot,
        runtimeRoot: path.join(installationRoot, "environments", "production", "edge-connector"),
        edgeBaseUrl: "https://mcp-access-stack.example.workers.dev",
        connectorTokenFile: path.join(installationRoot, "environments", "production", "edge-connector", "connector-token.txt"),
        ownerTokenFile: path.join(installationRoot, "environments", "production", "edge-connector", "owner-token.txt"),
        policyPath: path.join(installationRoot, "environments", "production", "workspace-agent", "policy.json"),
        allowedOrigins: "https://chatgpt.com,https://chat.openai.com",
        ownerOAuthScopes: "workspaces:read",
        mcpSessionMode: "stateless",
        maxConcurrentRequests: 8,
        delaySeconds: 15,
        browserEnabled: false,
        browserWorkerUrl: null,
        browserWorkerTokenFile: null,
        updatedAt: ISO,
      }),
      "utf8",
    );
  }
});

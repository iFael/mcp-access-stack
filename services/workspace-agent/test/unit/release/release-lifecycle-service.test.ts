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
  let previousLocalReleaseRoot: string | undefined;
  let previousLocalStateRoot: string | undefined;
  let workspace: ResolvedWorkspace;

  beforeEach(async () => {
    installationRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-release-service-"));
    previousInstallationRoot = process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT;
    previousStackRoot = process.env.VS_CODE_GPT_STACK_ROOT;
    previousLocalReleaseRoot = process.env.MCP_V3_RELEASE_ROOT;
    previousLocalStateRoot = process.env.MCP_V3_STATE_ROOT;
    delete process.env.MCP_V3_RELEASE_ROOT;
    delete process.env.MCP_V3_STATE_ROOT;
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
    if (previousLocalReleaseRoot === undefined) {
      delete process.env.MCP_V3_RELEASE_ROOT;
    } else {
      process.env.MCP_V3_RELEASE_ROOT = previousLocalReleaseRoot;
    }
    if (previousLocalStateRoot === undefined) {
      delete process.env.MCP_V3_STATE_ROOT;
    } else {
      process.env.MCP_V3_STATE_ROOT = previousLocalStateRoot;
    }
    await rm(installationRoot, { recursive: true, force: true });
  });

  it("rejects release lifecycle access from a non-canonical workspace", async () => {
    await writeState({ candidate: null });
    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
    const other = {
      ...workspace,
      id: "other",
      rootPath: path.join(installationRoot, "other"),
    } as ResolvedWorkspace;

    await expect(service.getState(other)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("reads R10 local lifecycle state without the legacy stack root", async () => {
    delete process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT;
    delete process.env.VS_CODE_GPT_STACK_ROOT;
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");
    await writeBootstrap("Start-McpV3LocalUpdate.ps1");

    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
    const result = await service.getState(workspace);

    expect(result.installationRoot).toBe(path.resolve(installationRoot));
    expect(result.state.active?.releaseId).toBe(ACTIVE);
    expect(result.activeBootstrap).toEqual({
      updateScriptPresent: true,
      cutoverScriptPresent: true,
    });
  });

  it("keeps mutating legacy lifecycle operations fail-closed in R10 local mode", async () => {
    delete process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT;
    delete process.env.VS_CODE_GPT_STACK_ROOT;
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);

    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
    await expect(
      service.prepare(
        workspace,
        "iFael/mcp-access-stack",
        { workspaceId: "ws", tag: "v1.1.0-beta.51" },
        {},
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    await expect(
      service.promote(
        workspace,
        { workspaceId: "ws", releaseId: CANDIDATE },
        {},
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
  });

  it("prepares an R10 local candidate through the Windows workspace shell", async () => {
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");

    let authorizedInput: any;
    let startedInput: any;
    const shell = {
      authorizeBackgroundCommand: async (_workspace: ResolvedWorkspace, input: any) => {
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
          shell: input.shell,
          cwd: ".",
          state: "running" as const,
          createdAt: ISO,
          startedAt: ISO,
          timeoutMs: input.timeoutMs,
          pid: 4242,
        };
      },
    };
    const service = new ReleaseLifecycleService(shell as any, background as any, "win32");

    const result = await service.prepare(
      workspace,
      "iFael/mcp-access-stack",
      { workspaceId: "ws", tag: "v1.1.0-beta.51" },
      {},
    );

    expect(result.status).toBe("background_task_started");
    expect(authorizedInput.shell).toBe("powershell");
    expect(startedInput.shell).toBe("powershell");
    expect(authorizedInput.command).toContain("pwsh.exe");
    expect(authorizedInput.command).toContain("-ExecutionPolicy AllSigned");
  });

  it("promotes an R10 local candidate through the detached local update handoff", async () => {
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    process.env.MCP_V3_STATE_ROOT = path.join(installationRoot, "local-state");
    await writeState({
      candidate: {
        releaseId: CANDIDATE,
        manifestSha256: "1".repeat(64),
        materializedAt: ISO,
      },
    });
    await writeBootstrap("Start-McpV3LocalUpdate.ps1");

    let executedInput: any;
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
          stdout: JSON.stringify({
            status: "accepted",
            operationId: "123e4567e89b42d3a456426614174000",
            tag: `v${CANDIDATE}`,
            taskName: "MCP V3 local updater",
            resultPath: path.join(installationRoot, "local-state", "updates", "result.json"),
            activeReleaseId: ACTIVE,
          }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    };
    const service = new ReleaseLifecycleService(shell as any, {} as any, "win32");

    const result = await service.promote(
      workspace,
      { workspaceId: "ws", releaseId: CANDIDATE },
      {},
    );

    expect(result).toMatchObject({
      status: "handover_started",
      releaseId: CANDIDATE,
      requestId: "123e4567-e89b-42d3-a456-426614174000",
      brokerTaskName: "MCP V3 local updater",
      projectRoot: workspace.rootPath,
    });
    expect(executedInput.shell).toBe("powershell");
    expect(executedInput.command).toContain("Start-McpV3LocalUpdate.ps1");
    expect(executedInput.command).toContain("-ExecutionPolicy AllSigned");
    expect(executedInput.command).toContain(`v${CANDIDATE}`);
    expect(executedInput.command).toContain(process.env.MCP_V3_STATE_ROOT);
    expect(executedInput.command).not.toContain("Start-McpAccessStackCutover.ps1");
    expect(executedInput.command).not.toContain("connector-token.txt");
  });

  it("prepares directly inside a trusted workspace without a confirmation round-trip", async () => {
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");
    const trusted = {
      ...workspace,
      confirmationMode: "trusted-workspace",
      permissionProfile: "full-repo-write",
      canonicalRootPath: workspace.rootPath,
      allowedRoots: [{
        logicalPath: ".",
        absolutePath: workspace.rootPath,
        canonicalPath: workspace.rootPath,
        kind: "directory",
      }],
      blockedGlobs: [],
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell", "pwsh"],
    } as ResolvedWorkspace;

    let authorizationCalls = 0;
    const shell = {
      authorizeBackgroundCommand: async () => {
        authorizationCalls += 1;
        throw new Error("trusted release preparation must not request confirmation");
      },
      runAuthorizedCommandToFiles: async () => {
        throw new Error("not used");
      },
      runCommand: async () => {
        throw new Error("not used");
      },
    };
    const background = {
      start_background_task: async (input: any) => ({
        version: 1 as const,
        id: "123e4567-e89b-42d3-a456-426614174000",
        workspaceId: "ws",
        operation: "prepare_release",
        commandHash: "0".repeat(64),
        command: input.command,
        shell: input.shell,
        cwd: ".",
        state: "running" as const,
        createdAt: ISO,
        startedAt: ISO,
        timeoutMs: input.timeoutMs,
        pid: 4242,
      }),
    };

    const service = new ReleaseLifecycleService(shell as any, background as any, "win32");
    await expect(
      service.prepare(
        trusted,
        "iFael/mcp-access-stack",
        { workspaceId: "ws", tag: "v1.1.0-beta.51" },
        {},
      ),
    ).resolves.toMatchObject({ status: "background_task_started" });
    expect(authorizationCalls).toBe(0);
  });

  it("preserves release preparation confirmation in standard mode", async () => {
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");

    const shell = {
      authorizeBackgroundCommand: async () => ({
        status: "confirmation_required" as const,
        confirmationId: "release-confirmation",
        expiresAt: ISO,
        reasons: ["legacy confirmation"],
      }),
      runCommand: async () => {
        throw new Error("not used");
      },
    };
    const background = {
      start_background_task: async () => {
        throw new Error("must not start");
      },
    };
    const service = new ReleaseLifecycleService(shell as any, background as any, "win32");

    await expect(
      service.prepare(
        workspace,
        "iFael/mcp-access-stack",
        { workspaceId: "ws", tag: "v1.1.0-beta.51" },
        {},
      ),
    ).resolves.toMatchObject({
      status: "confirmation_required",
      confirmationId: "release-confirmation",
    });
  });

  it("promotes directly inside a trusted workspace through the bounded release executor", async () => {
    process.env.MCP_V3_RELEASE_ROOT = path.join(installationRoot, "releases", ACTIVE);
    process.env.MCP_V3_STATE_ROOT = path.join(installationRoot, "local-state");
    await writeState({
      candidate: {
        releaseId: CANDIDATE,
        manifestSha256: "1".repeat(64),
        materializedAt: ISO,
      },
    });
    await writeBootstrap("Start-McpV3LocalUpdate.ps1");
    const trusted = {
      ...workspace,
      confirmationMode: "trusted-workspace",
      permissionProfile: "full-repo-write",
      canonicalRootPath: workspace.rootPath,
      allowedRoots: [{
        logicalPath: ".",
        absolutePath: workspace.rootPath,
        canonicalPath: workspace.rootPath,
        kind: "directory",
      }],
      blockedGlobs: [],
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell", "pwsh"],
    } as ResolvedWorkspace;

    let executionCalls = 0;
    const shell = {
      authorizeBackgroundCommand: async () => {
        throw new Error("not used");
      },
      runCommand: async () => {
        throw new Error("trusted release promotion must use the bounded executor");
      },
      runAuthorizedCommandToFiles: async (_workspace: ResolvedWorkspace, input: any) => {
        executionCalls += 1;
        return {
          status: "executed" as const,
          shell: "powershell" as const,
          cwd: ".",
          exitCode: 0,
          stdout: JSON.stringify({
            status: "accepted",
            operationId: "123e4567e89b42d3a456426614174000",
            tag: `v${CANDIDATE}`,
            taskName: "MCP V3 local updater",
            resultPath: path.join(installationRoot, "local-state", "updates", "result.json"),
            activeReleaseId: ACTIVE,
          }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    };
    const service = new ReleaseLifecycleService(shell as any, {} as any, "win32");

    await expect(
      service.promote(
        trusted,
        { workspaceId: "ws", releaseId: CANDIDATE },
        {},
      ),
    ).resolves.toMatchObject({ status: "handover_started" });
    expect(executionCalls).toBe(1);
  });

  it("reports whether the active release contains signed lifecycle bootstraps", async () => {
    await writeState({ candidate: null });
    await writeBootstrap("Update-McpAccessStack.ps1");
    await writeBootstrap("Start-McpAccessStackCutover.ps1");

    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
    const result = await service.getState(workspace);

    expect(result.state.active?.releaseId).toBe(ACTIVE);
    expect(result.activeBootstrap).toEqual({
      updateScriptPresent: true,
      cutoverScriptPresent: true,
    });
  });

  it("fails closed when the active release does not contain the signed updater bootstrap", async () => {
    await writeState({ candidate: null });

    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
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
    const service = new ReleaseLifecycleService(shell as any, background as any, "win32");

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
    const service = new ReleaseLifecycleService(shell as any, {} as any, "win32");

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
    expect(executedInput.command).not.toContain("-OwnerTokenFile");
    expect(executedInput.command).not.toContain("-OwnerOAuthScopes");
    expect(executedInput.command).not.toContain("-McpSessionMode");
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

    const service = new ReleaseLifecycleService({} as any, {} as any, "win32");
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

  it("uses fixed Linux lifecycle bootstraps without changing the public tool contract", async () => {
    await writeState({
      candidate: {
        releaseId: CANDIDATE,
        manifestSha256: "1".repeat(64),
        materializedAt: ISO,
      },
    });
    await writeBootstrap("Update-McpAccessStack.sh", "linux");
    await writeBootstrap("Start-McpAccessStackCutover.sh", "linux");
    await writeRecoveryConfig();

    let authorizedInput: any;
    let executedInput: any;
    const requestId = "123e4567-e89b-42d3-a456-426614174099";
    const shell = {
      authorizeBackgroundCommand: async (_workspace: ResolvedWorkspace, input: any) => {
        authorizedInput = input;
        return { logicalCwd: ".", absoluteCwd: workspace.rootPath };
      },
      runCommand: async (_workspace: ResolvedWorkspace, input: any) => {
        executedInput = input;
        return {
          status: "executed" as const,
          shell: "pwsh" as const,
          cwd: ".",
          exitCode: 0,
          stdout: JSON.stringify({
            status: "started",
            detached: true,
            requestId,
            releaseId: CANDIDATE,
            brokerTaskName: "systemd:mcp-access-stack-edge-connector",
            requestPath: path.join(installationRoot, "state", "request.json"),
            resultPath: path.join(installationRoot, "state", "result.json"),
          }) + "\n",
          stderr: "",
          timedOut: false,
        };
      },
    };
    const background = {
      start_background_task: async (input: any) => ({
        version: 1 as const,
        id: "123e4567-e89b-42d3-a456-426614174098",
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
      }),
    };
    const service = new ReleaseLifecycleService(shell as any, background as any, "linux");

    const state = await service.getState(workspace);
    expect(state.activeBootstrap).toEqual({
      updateScriptPresent: true,
      cutoverScriptPresent: true,
    });

    await service.prepare(
      workspace,
      "iFael/mcp-access-stack",
      { workspaceId: "ws", tag: "v1.1.0-beta.51" },
      {},
    );
    expect(authorizedInput.command).toContain("Update-McpAccessStack.sh");
    expect(authorizedInput.command).toContain("--repository");
    expect(authorizedInput.command).toContain("--installation-root");
    expect(authorizedInput.command).not.toContain("AllSigned");
    expect(authorizedInput.command).not.toContain("pwsh.exe");

    const promoted = await service.promote(
      workspace,
      { workspaceId: "ws", releaseId: CANDIDATE },
      {},
    );
    expect(promoted).toMatchObject({
      status: "handover_started",
      releaseId: CANDIDATE,
      requestId,
    });
    expect(executedInput.command).toContain("Start-McpAccessStackCutover.sh");
    expect(executedInput.command).toContain("--expected-release-id");
    expect(executedInput.command).toContain("--connector-token-file");
    expect(executedInput.command).not.toContain("--owner-token-file");
    expect(executedInput.command).not.toContain("--owner-oauth-scopes");
    expect(executedInput.command).not.toContain("--mcp-session-mode");
    expect(executedInput.command).not.toContain("AllSigned");
    expect(executedInput.command).not.toContain("pwsh.exe");
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

  async function writeBootstrap(
    name: string,
    platformDirectory: "windows" | "linux" = "windows",
  ): Promise<void> {
    const directory = path.join(
      installationRoot,
      "releases",
      ACTIVE,
      "deploy",
      platformDirectory,
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

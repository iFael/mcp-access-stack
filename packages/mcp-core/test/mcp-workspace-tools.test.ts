import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@jest/globals";
import type {
  BackgroundTaskListResult,
  BackgroundTaskLogsLookupResult,
  BackgroundTaskResult,
  GetWorkspaceContextResult,
  InspectGitResult,
  ListFilesResult,
  ListWorkspaceRootsResult,
  ReadFileResult,
  RunWorkspaceValidationResult,
  RunCommandResult,
  RunPowerShellResult,
  SearchFilesResult,
  StartBackgroundTaskInput,
  WorkspaceExecutor,
  WorkspaceSummary,
} from "@vs-code-gpt/shared";
import { registerWorkspaceTools } from "../src/mcp-workspace-tools.js";

const backgroundTask = {
  version: 1 as const,
  id: "123e4567-e89b-42d3-a456-426614174000",
  workspaceId: "ws",
  operation: "check",
  commandHash: "0".repeat(64),
  command: "npm run check",
  shell: "pwsh" as const,
  cwd: ".",
  state: "running" as const,
  createdAt: "2026-07-25T00:00:00.000Z",
  startedAt: "2026-07-25T00:00:01.000Z",
  timeoutMs: 120_000,
  pid: 4242,
};

class MockWorkspaceExecutor implements WorkspaceExecutor {
  calls: string[] = [];
  backgroundInputs: StartBackgroundTaskInput[] = [];

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    this.calls.push("listWorkspaces");
    return [
      {
        id: "ws",
        name: "Workspace",
        enabled: true,
        permissionProfile: "planning-readonly",
        writesEnabled: false,
        shellsEnabled: false,
        allowedShells: ["powershell"],
      },
    ];
  }

  async listWorkspaceRoots(): Promise<ListWorkspaceRootsResult> {
    this.calls.push("listWorkspaceRoots");
    return { roots: ["repo-a", "repo-b"], truncated: false };
  }
  async listFiles(): Promise<ListFilesResult> {
    this.calls.push("listFiles");
    return { files: [], truncated: false };
  }

  async readFile(): Promise<ReadFileResult> {
    this.calls.push("readFile");
    return {
      path: "a.txt",
      content: "x",
      startLine: 1,
      endLine: 1,
      totalLines: 1,
      sizeBytes: 1,
      sha256: "0".repeat(64),
      encoding: "utf-8",
      lineEnding: "none",
    };
  }

  async readBinaryFile(): Promise<
    import("@vs-code-gpt/shared").ReadBinaryFileResult
  > {
    this.calls.push("readBinaryFile");
    return {
      path: "a.bin",
      contentBase64: "eA==",
      sizeBytes: 1,
      sha256: "0".repeat(64),
    };
  }

  async writeFile(): Promise<import("@vs-code-gpt/shared").WriteFileResult> {
    this.calls.push("writeFile");
    return { path: "a.txt", sizeBytes: 1, created: true };
  }

  async patchFile(): Promise<import("@vs-code-gpt/shared").PatchFileResult> {
    this.calls.push("patchFile");
    return {
      path: "a.txt",
      sha256Before: "0".repeat(64),
      sha256After: "1".repeat(64),
      encoding: "utf-8",
      lineEnding: "none",
      replacementsApplied: 1,
      sizeBytes: 1,
      changed: true,
      dryRun: false,
    };
  }

  async runValidation(): Promise<RunWorkspaceValidationResult> {
    this.calls.push("runValidation");
    return {
      workspaceId: "ws",
      root: ".",
      validation: "diff-check",
      scope: "changes",
      executed: true,
      passed: true,
      tool: { name: "git", available: true, version: "git version test" },
      filesScanned: 0,
      findings: [],
      findingsCount: 0,
      truncated: false,
      durationMs: 1,
      issues: [],
      warnings: [],
    };
  }

  async runPowerShell(): Promise<RunPowerShellResult> {
    this.calls.push("runPowerShell");
    return {
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
  }

  async runCommand(): Promise<RunCommandResult> {
    this.calls.push("runCommand");
    return {
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    };
  }

  async searchFiles(): Promise<SearchFilesResult> {
    this.calls.push("searchFiles");
    return { matches: [], truncated: false, skippedFiles: 0 };
  }

  async inspectGit(): Promise<InspectGitResult> {
    this.calls.push("inspectGit");
    return {
      workspaceId: "ws",
      root: ".",
      branch: "main",
      diffMode: "summary",
      status: [],
      staged: "",
      unstaged: "",
      truncated: false,
    };
  }

  async getWorkspaceContext(): Promise<GetWorkspaceContextResult> {
    this.calls.push("getWorkspaceContext");
    return {
      workspaceId: "ws",
      rootPath: ".",
      instructionFiles: [],
      availableInstructionFiles: [],
      skills: [],
      git: { isGitRepository: false },
    };
  }

  async startBackgroundTask(
    input: StartBackgroundTaskInput,
  ): Promise<BackgroundTaskResult> {
    this.calls.push("startBackgroundTask");
    this.backgroundInputs.push(input);
    return { task: { ...backgroundTask, command: input.command, timeoutMs: input.timeoutMs ?? 60_000 } };
  }

  async getBackgroundTask(): Promise<BackgroundTaskResult> {
    this.calls.push("getBackgroundTask");
    return { task: backgroundTask };
  }

  async listBackgroundTasks(): Promise<BackgroundTaskListResult> {
    this.calls.push("listBackgroundTasks");
    return { tasks: [backgroundTask] };
  }

  async cancelBackgroundTask(): Promise<BackgroundTaskResult> {
    this.calls.push("cancelBackgroundTask");
    return { task: { ...backgroundTask, state: "cancelled" } };
  }

  async readBackgroundTaskLogs(): Promise<BackgroundTaskLogsLookupResult> {
    this.calls.push("readBackgroundTaskLogs");
    return {
      logs: {
        id: backgroundTask.id,
        stdout: "done",
        stderr: "",
        stdoutBytes: 4,
        stderrBytes: 0,
        truncated: false,
      },
    };
  }
}

interface RegisteredTool {
  handler(
    input: unknown,
    extra: { signal: AbortSignal },
  ): Promise<CallToolResult>;
}

function registeredTools(server: McpServer): Record<string, RegisteredTool> {
  return (server as unknown as {
    _registeredTools: Record<string, RegisteredTool>;
  })._registeredTools;
}

describe("registerWorkspaceTools", () => {
  it("registers only the requested subset", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: [
        "list_workspaces",
        "read_file",
        "start_background_task",
      ],
      securitySchemes: [{ type: "noauth" }],
    });

    const internals = server as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    expect(Object.keys(internals._registeredTools).sort()).toEqual([
      "list_workspaces",
      "read_file",
      "start_background_task",
    ]);
  });

  it("routes list_workspace_roots without recursive file discovery", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["list_workspace_roots"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["list_workspace_roots"]!.handler(
      { workspaceId: "ws" },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toEqual({
      roots: ["repo-a", "repo-b"],
      truncated: false,
    });
    expect(executor.calls).toEqual(["listWorkspaceRoots"]);
  });
  it("keeps qualified payloads out of the legacy background-task router", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["run_command"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["run_command"]!.handler(
      {
        workspaceId: "ws",
        objective: "Executar uma operação qualificada",
        timeoutMs: 300_001,
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({ status: "executed" });
    expect(executor.calls).toEqual(["runCommand"]);
    expect(executor.backgroundInputs).toEqual([]);
  });

  it("keeps canonical direct or qualified validation behind the published object schema", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["run_command"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["run_command"]!.handler(
      {
        workspaceId: "ws",
        executionMode: "direct",
        command: "echo ok",
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(executor.calls).toEqual([]);
  });

  it("routes commands above 300 seconds to a deduplicated persistent task", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["run_command"],
      securitySchemes: [{ type: "noauth" }],
    });

    const command = '  node -e "setTimeout(() => {}, 1)"  ';
    const result = await registeredTools(server)["run_command"]!.handler(
      {
        workspaceId: "ws",
        shell: "git-bash",
        command,
        timeoutMs: 300_001,
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({
      status: "background_task_started",
      task: { state: "running", timeoutMs: 300_001, command },
    });
    expect(executor.calls).toEqual(["startBackgroundTask"]);
    expect(executor.backgroundInputs).toEqual([
      expect.objectContaining({
        operation: "run_command",
        command,
        timeoutMs: 300_001,
      }),
    ]);
  });

  it("keeps a 300 second command in the synchronous path", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["run_command"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["run_command"]!.handler(
      {
        workspaceId: "ws",
        shell: "git-bash",
        command: "echo ok",
        timeoutMs: 300_000,
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({ status: "executed" });
    expect(executor.calls).toEqual(["runCommand"]);
  });
});

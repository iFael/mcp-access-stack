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
import {
  SOURCE_CONTROL_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
  registerSourceControlTools,
  registerWorkspaceTools,
} from "../src/mcp-workspace-tools.js";

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
        confirmationMode: "standard",
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

  async waitBackgroundTask(): Promise<import("@vs-code-gpt/shared").BackgroundTaskWaitResult> {
    this.calls.push("waitBackgroundTask");
    return {
      task: { ...backgroundTask, state: "succeeded" },
      logs: {
        id: backgroundTask.id,
        stdout: "done",
        stderr: "",
        stdoutBytes: 4,
        stderrBytes: 0,
        truncated: false,
      },
      timedOut: false,
      elapsedMs: 12,
    };
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

  it("publishes wait_background_task as a workspace tool", () => {
    expect(WORKSPACE_TOOL_NAMES as readonly string[]).toContain(
      "wait_background_task",
    );

    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["wait_background_task"],
      securitySchemes: [{ type: "noauth" }],
    });

    expect(Object.keys(registeredTools(server))).toEqual([
      "wait_background_task",
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

const sourceControlShaA = "a".repeat(40);
const sourceControlShaB = "b".repeat(40);
const sourceControlShaC = "c".repeat(40);

class MockSourceControlExecutor {
  calls: Array<{ method: string; input: unknown; context: unknown }> = [];

  private record(method: string, input: unknown, context: unknown) {
    this.calls.push({ method, input, context });
  }

  async createBranch(input: any, context?: unknown) {
    this.record("createBranch", input, context);
    return { root: input.root ?? ".", branch: input.branch, headSha: input.expectedHeadSha };
  }
  async stagePaths(input: any, context?: unknown) {
    this.record("stagePaths", input, context);
    return { root: input.root ?? ".", headSha: sourceControlShaA, indexTreeSha: sourceControlShaB, paths: input.paths };
  }
  async unstagePaths(input: any, context?: unknown) {
    this.record("unstagePaths", input, context);
    return { root: input.root ?? ".", headSha: input.expectedHeadSha, indexTreeSha: sourceControlShaB, paths: input.paths };
  }
  async commit(input: any, context?: unknown) {
    this.record("commit", input, context);
    return { root: input.root ?? ".", branch: "feature/task7", commitSha: sourceControlShaC };
  }
  async mergeBranch(input: any, context?: unknown) {
    this.record("mergeBranch", input, context);
    return { root: input.root ?? ".", branch: "feature/task7", previousHeadSha: input.expectedTargetHeadSha, headSha: input.expectedSourceHeadSha, sourceHeadSha: input.expectedSourceHeadSha, fastForwarded: true as const };
  }
  async pushBranch(input: any, context?: unknown) {
    this.record("pushBranch", input, context);
    return { status: "completed" as const, root: input.root ?? ".", remote: input.remote ?? "origin", branch: input.branch, localSha: input.expectedLocalSha, remoteSha: input.expectedLocalSha };
  }
  async getRepository(input: any, context?: unknown) {
    this.record("getRepository", input, context);
    return { owner: input.owner, name: input.repository, fullName: `${input.owner}/${input.repository}`, defaultBranch: "main", visibility: "private" as const, url: `https://github.com/${input.owner}/${input.repository}` };
  }
  async createRepository(input: any, context?: unknown) {
    this.record("createRepository", input, context);
    return { status: "completed" as const, owner: input.owner, name: input.name, fullName: `${input.owner}/${input.name}`, defaultBranch: "main", visibility: input.visibility, url: `https://github.com/${input.owner}/${input.name}` };
  }
  async getPullRequest(input: any, context?: unknown) {
    this.record("getPullRequest", input, context);
    return { number: input.pullNumber, state: "open" as const, title: "typed", url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullNumber}`, headSha: sourceControlShaB, baseSha: sourceControlShaA, merged: false };
  }
  async createPullRequest(input: any, context?: unknown) {
    this.record("createPullRequest", input, context);
    return { status: "completed" as const, number: 7, state: "open" as const, title: input.title, url: `https://github.com/${input.owner}/${input.repository}/pull/7`, headSha: sourceControlShaB, baseSha: sourceControlShaA, merged: false };
  }
  async mergePullRequest(input: any, context?: unknown) {
    this.record("mergePullRequest", input, context);
    return { status: "completed" as const, number: input.pullNumber, merged: true, mergeSha: sourceControlShaC };
  }
}

const sourceControlCases = [
  ["git_create_branch", "createBranch", { workspaceId: "ws", branch: "feature/task7", expectedHeadSha: sourceControlShaA }],
  ["git_stage_paths", "stagePaths", { workspaceId: "ws", paths: ["a.txt"] }],
  ["git_unstage_paths", "unstagePaths", { workspaceId: "ws", paths: ["a.txt"], expectedHeadSha: sourceControlShaA, expectedIndexTreeSha: sourceControlShaB }],
  ["git_commit", "commit", { workspaceId: "ws", message: "typed", expectedHeadSha: sourceControlShaA, expectedIndexTreeSha: sourceControlShaB }],
  ["git_merge_branch", "mergeBranch", { workspaceId: "ws", sourceBranch: "feature/source", expectedTargetHeadSha: sourceControlShaA, expectedSourceHeadSha: sourceControlShaB }],
  ["git_push_branch", "pushBranch", { workspaceId: "ws", branch: "feature/task7", expectedLocalSha: sourceControlShaA }],
  ["github_get_repository", "getRepository", { workspaceId: "ws", owner: "octo", repository: "repo" }],
  ["github_create_repository", "createRepository", { workspaceId: "ws", owner: "octo", name: "repo", visibility: "private" }],
  ["github_get_pull_request", "getPullRequest", { workspaceId: "ws", owner: "octo", repository: "repo", pullNumber: 7 }],
  ["github_create_pull_request", "createPullRequest", { workspaceId: "ws", owner: "octo", repository: "repo", title: "typed", head: "feature/task7", base: "main" }],
  ["github_merge_pull_request", "mergePullRequest", { workspaceId: "ws", owner: "octo", repository: "repo", pullNumber: 7, expectedPullRequestHeadSha: sourceControlShaB, mergeMethod: "squash" }],
] as const;

const expectedSourceControlAnnotations = {
  git_create_branch: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  git_stage_paths: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  git_unstage_paths: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  git_commit: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  git_merge_branch: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  git_push_branch: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  github_get_repository: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  github_create_repository: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  github_get_pull_request: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  github_create_pull_request: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  github_merge_pull_request: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
} as const;

describe("registerSourceControlTools", () => {
  it("publishes exactly eleven source-control names inside the 28-tool workspace surface", () => {
    expect(SOURCE_CONTROL_TOOL_NAMES).toEqual(sourceControlCases.map(([name]) => name));
    expect(SOURCE_CONTROL_TOOL_NAMES).toHaveLength(11);
    expect(WORKSPACE_TOOL_NAMES).toHaveLength(28);
    expect(new Set(WORKSPACE_TOOL_NAMES).size).toBe(28);
  });

  it("registers exact annotations and routes each tool to exactly one typed method", async () => {
    const executor = new MockSourceControlExecutor();
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerSourceControlTools(server, executor, { securitySchemes: [{ type: "noauth" }] });
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool & { annotations?: unknown }> })._registeredTools;
    expect(Object.keys(tools)).toEqual([...SOURCE_CONTROL_TOOL_NAMES]);

    for (const [name, method, input] of sourceControlCases) {
      expect(tools[name]?.annotations).toMatchObject(expectedSourceControlAnnotations[name]);
      const before = executor.calls.length;
      const result = await tools[name]!.handler(input, { signal: new AbortController().signal });
      expect(result.isError).not.toBe(true);
      expect(executor.calls).toHaveLength(before + 1);
      expect(executor.calls.at(-1)).toMatchObject({ method, input });
      expect(executor.calls.at(-1)?.context).toMatchObject({ signal: expect.any(AbortSignal) });
    }
  });
});

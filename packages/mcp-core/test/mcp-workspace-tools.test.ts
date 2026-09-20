import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type {
  BackgroundTaskListResult,
  BackgroundTaskLogsLookupResult,
  BackgroundTaskOutputResult,
  BackgroundTaskResult,
  BackgroundTaskStdinResult,
  GetBackgroundTaskInput,
  GetWorkspaceContextResult,
  InspectGitResult,
  ListFilesResult,
  ListWorkspaceRootsResult,
  ReadBackgroundTaskOutputInput,
  ReadFileInput,
  ReadFileResult,
  RunWorkspaceValidationResult,
  RunCommandResult,
  SearchFilesInput,
  SearchFilesResult,
  StartBackgroundTaskInput,
  StartBackgroundTaskResult,
  WriteBackgroundTaskStdinInput,
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
  readFileFailures = new Set<string>();
  searchFailures = new Set<string>();

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

  async readFile(input: ReadFileInput): Promise<ReadFileResult> {
    this.calls.push("readFile");
    if (this.readFileFailures.has(input.path)) {
      throw new AppError("FILE_NOT_FOUND", "Requested file does not exist.");
    }
    return {
      path: input.path,
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

  async patchFile(
    input: import("@vs-code-gpt/shared").PatchFileInput,
  ): Promise<import("@vs-code-gpt/shared").PatchFileResult> {
    this.calls.push("patchFile");
    return {
      path: input.path,
      sha256Before: input.expectedSha256,
      sha256After: "1".repeat(64),
      encoding: "utf-8",
      lineEnding: "none",
      replacementsApplied: input.replacements.reduce(
        (total, replacement) => total + (replacement.expectedCount ?? 1),
        0,
      ),
      sizeBytes: 1,
      changed: true,
      dryRun: input.dryRun ?? false,
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

  async searchFiles(input: SearchFilesInput): Promise<SearchFilesResult> {
    this.calls.push("searchFiles");
    if (this.searchFailures.has(input.query)) {
      throw new AppError("FILE_NOT_FOUND", "Search root does not exist.");
    }
    return {
      matches: [
        { path: "a.txt", line: 1, column: 1, snippet: input.query },
      ],
      truncated: false,
      skippedFiles: 0,
    };
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
  ): Promise<StartBackgroundTaskResult> {
    this.calls.push("startBackgroundTask");
    this.backgroundInputs.push(input);
    return {
      status: "background_task_started",
      task: {
        ...backgroundTask,
        command: input.command,
        timeoutMs: input.timeoutMs ?? 60_000,
      },
    };
  }

  async getBackgroundTask(input: GetBackgroundTaskInput): Promise<BackgroundTaskResult> {
    this.calls.push("getBackgroundTask");
    return { task: input.id === backgroundTask.id ? backgroundTask : null };
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

  async writeBackgroundTaskStdin(
    input: WriteBackgroundTaskStdinInput,
  ): Promise<BackgroundTaskStdinResult> {
    this.calls.push("writeBackgroundTaskStdin");
    return {
      task:
        input.id === backgroundTask.id
          ? { ...backgroundTask, interactive: true as const }
          : null,
      bytesWritten: Buffer.byteLength(input.input ?? "", "utf8"),
      stdinClosed: input.close ?? false,
    };
  }

  async readBackgroundTaskOutput(
    input: ReadBackgroundTaskOutputInput,
  ): Promise<BackgroundTaskOutputResult> {
    this.calls.push("readBackgroundTaskOutput");
    if (input.id !== backgroundTask.id) {
      return { task: null, stdout: null, stderr: null };
    }
    const stdoutOffset = input.stdoutOffset ?? 0;
    const stderrOffset = input.stderrOffset ?? 0;
    return {
      task: backgroundTask,
      stdout: {
        content: stdoutOffset === 0 ? "done" : "",
        offset: stdoutOffset,
        nextOffset: 4,
        totalBytes: 4,
        eof: true,
      },
      stderr: {
        content: "",
        offset: stderrOffset,
        nextOffset: 0,
        totalBytes: 0,
        eof: true,
      },
    };
  }
}

interface RegisteredTool {
  annotations?: Record<string, unknown>;
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

  it("reads multiple files in one tool call and isolates item failures", async () => {
    const executor = new MockWorkspaceExecutor();
    executor.readFileFailures.add("missing.txt");
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["read_files"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["read_files"]!.handler(
      {
        workspaceId: "ws",
        items: [
          { path: "first.txt", startLine: 1, endLine: 1 },
          { path: "missing.txt" },
          { path: "third.txt" },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Read 2/3 file item(s)." },
    ]);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          status: "ok",
          requestedPath: "first.txt",
          result: { path: "first.txt", content: "x" },
        },
        {
          status: "error",
          requestedPath: "missing.txt",
          error: {
            code: "FILE_NOT_FOUND",
            message: "Requested file does not exist.",
          },
        },
        {
          status: "ok",
          requestedPath: "third.txt",
          result: { path: "third.txt", content: "x" },
        },
      ],
    });
    expect(executor.calls).toEqual(["readFile", "readFile", "readFile"]);
  });

  it("runs multiple file searches in one tool call and isolates failures", async () => {
    const executor = new MockWorkspaceExecutor();
    executor.searchFailures.add("missing-root");
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["search_files_batch"],
      securitySchemes: [{ type: "noauth" }],
    });

    const result = await registeredTools(server)["search_files_batch"]!.handler(
      {
        workspaceId: "ws",
        items: [
          { query: "alpha" },
          { query: "missing-root", root: "missing" },
          { query: "omega", caseSensitive: true },
        ],
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Completed 2/3 search(es); matches=2." },
    ]);
    expect(result.structuredContent).toMatchObject({
      items: [
        {
          status: "ok",
          query: "alpha",
          result: { matches: [{ snippet: "alpha" }] },
        },
        {
          status: "error",
          query: "missing-root",
          error: {
            code: "FILE_NOT_FOUND",
            message: "Search root does not exist.",
          },
        },
        {
          status: "ok",
          query: "omega",
          result: { matches: [{ snippet: "omega" }] },
        },
      ],
    });
    expect(executor.calls).toEqual(["searchFiles", "searchFiles", "searchFiles"]);
  });

  it("rejects legacy qualified payloads before the executor", async () => {
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
        objective: "Executar uma operaÃ§Ã£o qualificada",
        timeoutMs: 60_001,
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).toBe(true);
    expect(executor.calls).toEqual([]);
    expect(executor.backgroundInputs).toEqual([]);
  });

  it("accepts known stale optional fields when canonical command and shell are present", async () => {
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
        shell: "powershell",
        command: "echo ok",
        executionMode: "direct",
        objective: "legacy helper text",
        autoCorrection: "off",
        preferredShell: "auto",
        expectedOutcome: [{ kind: "exit_code", value: 0 }],
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "executed" });
    expect(executor.calls).toEqual(["runCommand"]);
  });
  it("requires the canonical command and shell fields", async () => {
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

  it("routes commands above 60 seconds to a deduplicated persistent task", async () => {
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
        timeoutMs: 60_001,
        confirmationId: "long-command-confirmation",
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({
      status: "background_task_started",
      task: { state: "running", timeoutMs: 60_001, command },
    });
    expect(executor.calls).toEqual(["startBackgroundTask"]);
    expect(executor.backgroundInputs).toEqual([
      expect.objectContaining({
        operation: "run_command",
        command,
        timeoutMs: 60_001,
        confirmationId: "long-command-confirmation",
      }),
    ]);
  });

  it("preserves confirmationId when a long run_command routes to background", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["run_command"],
      securitySchemes: [{ type: "noauth" }],
    });

    await registeredTools(server)["run_command"]!.handler(
      {
        workspaceId: "ws",
        shell: "powershell",
        command: "Remove-Item stale.txt -Force",
        timeoutMs: 60_001,
        confirmationId: "background-confirmation",
      },
      { signal: new AbortController().signal },
    );

    expect(executor.backgroundInputs).toEqual([
      expect.objectContaining({
        operation: "run_command",
        confirmationId: "background-confirmation",
      }),
    ]);
  });

  it("returns background confirmation_required through long run_command routing", async () => {
    const executor = new MockWorkspaceExecutor();
    executor.startBackgroundTask = (async (input: StartBackgroundTaskInput) => {
      executor.calls.push("startBackgroundTask");
      executor.backgroundInputs.push(input);
      return {
        status: "confirmation_required",
        shell: input.shell,
        cwd: input.cwd ?? ".",
        confirmationId: "confirm-long-command",
        expiresAt: "2026-09-13T06:00:00.000Z",
        reasons: ["move, overwrite or direct file write operation"],
      } as any;
    }) as any;
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
        shell: "powershell",
        command: "Remove-Item stale.txt -Force",
        timeoutMs: 60_001,
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({
      status: "confirmation_required",
      confirmationId: "confirm-long-command",
    });
    expect(result.isError).not.toBe(true);
  });
  it("publishes patch_file and routes it to the typed patchFile executor", async () => {
    expect(WORKSPACE_TOOL_NAMES as readonly string[]).toContain("patch_file");

    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["patch_file"],
      securitySchemes: [{ type: "noauth" }],
    });

    const tool = registeredTools(server)["patch_file"]!;
    expect(tool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    });

    const result = await tool.handler(
      {
        workspaceId: "ws",
        path: "a.txt",
        expectedSha256: "0".repeat(64),
        replacements: [
          { oldText: "x", newText: "y", expectedCount: 1 },
        ],
        dryRun: true,
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      path: "a.txt",
      replacementsApplied: 1,
      changed: true,
      dryRun: true,
    });
    expect(executor.calls).toContain("patchFile");
  });

  it("gets multiple background tasks in one tool call and preserves order", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: ["get_background_tasks"],
      securitySchemes: [{ type: "noauth" }],
    });

    const missingId = "223e4567-e89b-42d3-a456-426614174000";
    const result = await registeredTools(server)["get_background_tasks"]!.handler(
      {
        workspaceId: "ws",
        ids: [backgroundTask.id, missingId],
      },
      { signal: new AbortController().signal },
    );

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "Found 1/2 background task(s)." },
    ]);
    expect(result.structuredContent).toEqual({
      items: [
        { id: backgroundTask.id, task: backgroundTask },
        { id: missingId, task: null },
      ],
    });
    expect(executor.calls).toEqual(["getBackgroundTask", "getBackgroundTask"]);
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
  it("routes interactive background stdin and incremental output through typed tools", async () => {
    const executor = new MockWorkspaceExecutor();
    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, executor, {
      includeTools: [
        "write_background_task_stdin",
        "read_background_task_output",
      ],
      securitySchemes: [{ type: "noauth" }],
    });

    const stdinTool = registeredTools(server)["write_background_task_stdin"]!;
    expect(stdinTool.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    const stdinResult = await stdinTool.handler(
      {
        workspaceId: "ws",
        id: backgroundTask.id,
        input: "hello\n",
        close: false,
      },
      { signal: new AbortController().signal },
    );
    expect(stdinResult.isError).not.toBe(true);
    expect(stdinResult.structuredContent).toMatchObject({
      task: { id: backgroundTask.id, interactive: true },
      bytesWritten: 6,
      stdinClosed: false,
    });

    const outputTool = registeredTools(server)["read_background_task_output"]!;
    expect(outputTool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    const outputResult = await outputTool.handler(
      {
        workspaceId: "ws",
        id: backgroundTask.id,
        stdoutOffset: 0,
        stderrOffset: 0,
        maxBytes: 256,
      },
      { signal: new AbortController().signal },
    );
    expect(outputResult.isError).not.toBe(true);
    expect(outputResult.structuredContent).toMatchObject({
      task: { id: backgroundTask.id },
      stdout: {
        content: "done",
        offset: 0,
        nextOffset: 4,
        totalBytes: 4,
        eof: true,
      },
    });
    expect(executor.calls).toEqual([
      "writeBackgroundTaskStdin",
      "readBackgroundTaskOutput",
    ]);
  });

  it("keeps a 60 second command in the synchronous path", async () => {
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
        timeoutMs: 60_000,
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
  it("publishes exactly eleven source-control names inside the 33-tool workspace surface", () => {
    expect(SOURCE_CONTROL_TOOL_NAMES).toEqual(sourceControlCases.map(([name]) => name));
    expect(SOURCE_CONTROL_TOOL_NAMES).toHaveLength(11);
    expect(WORKSPACE_TOOL_NAMES).toHaveLength(33);
    expect(new Set(WORKSPACE_TOOL_NAMES).size).toBe(33);
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

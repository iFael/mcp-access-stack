import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  backgroundTaskListResultSchema,
  backgroundTaskLogsLookupResultSchema,
  backgroundTaskResultSchema,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
  listBackgroundTasksInputSchema,
  readBackgroundTaskLogsInputSchema,
  startBackgroundTaskInputSchema,
} from "./background-task-contracts.js";
import {
  directRunCommandInputSchema,
  getWorkspaceContextInputSchema,
  getWorkspaceContextResultSchema,
  inspectGitInputSchema,
  inspectGitResultSchema,
  listFilesInputSchema,
  listFilesResultSchema,
  listWorkspaceRootsInputSchema,
  listWorkspaceRootsResultSchema,
  listWorkspacesResultSchema,
  readFileInputSchema,
  readFileResultSchema,
  runWorkspaceValidationInputSchema,
  runWorkspaceValidationResultSchema,
  runCommandMcpResultSchema,
  runCommandInputSchema,
  runCommandToolInputSchema,
  runCommandResultSchema,
  searchFilesInputSchema,
  searchFilesResultSchema,
  writeFileInputSchema,
  writeFileResultSchema,
  runPowerShellMcpResultSchema,
  runPowerShellInputSchema,
  runPowerShellResultSchema,
  type OperationContext,
  type RelayOperation,
  type RunCommandInput,
  type RunCommandResult,
  type RunPowerShellInput,
} from "./contracts.js";
import { AppError as AppErrorClass, asAppError } from "./errors.js";
import {
  createOperationDeadline,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  QUICK_OPERATION_TIMEOUT_MS,
  sanitizeOperationDiagnostic,
} from "./timeout-policy.js";
import type { WorkspaceExecutor } from "./workspace-executor.js";
import {
  withToolOperationContext,
  type ToolOperationContextFactory,
} from "./mcp-operation-context.js";

export const MCP_SERVER_NAME = "vs-code-gpt";
export const MCP_SERVER_BASE_VERSION = "0.4.0";

const toolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const listWorkspacesOutputSchema = z
  .object({ workspaces: listWorkspacesResultSchema })
  .strict();

export type WorkspaceToolName =
  | "list_workspaces"
  | "list_workspace_roots"
  | "list_files"
  | "read_file"
  | "write_file"
  | "run_workspace_validation"
  | "run_command"
  | "run_powershell"
  | "search_files"
  | "inspect_workspace_git"
  | "get_workspace_context"
  | "start_background_task"
  | "get_background_task"
  | "list_background_tasks"
  | "cancel_background_task"
  | "read_background_task_logs";

export const WORKSPACE_TOOL_NAMES = [
  "list_workspaces",
  "list_workspace_roots",
  "list_files",
  "read_file",
  "write_file",
  "run_workspace_validation",
  "run_command",
  "run_powershell",
  "search_files",
  "inspect_workspace_git",
  "get_workspace_context",
  "start_background_task",
  "get_background_task",
  "list_background_tasks",
  "cancel_background_task",
  "read_background_task_logs",
] as const satisfies readonly WorkspaceToolName[];

export interface WorkspaceToolSecurityScheme {
  type: "oauth2" | "noauth";
  scopes?: string[];
}

export interface RegisterWorkspaceToolsOptions {
  securitySchemes?: WorkspaceToolSecurityScheme[];
  /** Subset of tools to expose (default: all six). */
  includeTools?: readonly WorkspaceToolName[];
  operationContextFactory?: ToolOperationContextFactory;
  auth?: {
    requiredScope: string;
    resourceMetadataUrl: URL;
  };
}

function toolMeta(options: RegisterWorkspaceToolsOptions) {
  return {
    securitySchemes: options.securitySchemes?.length
      ? options.securitySchemes
      : options.auth
        ? [{ type: "oauth2" as const, scopes: [options.auth.requiredScope] }]
        : [{ type: "noauth" as const }],
  };
}

function shouldInclude(
  name: WorkspaceToolName,
  includeTools: readonly WorkspaceToolName[] | undefined,
): boolean {
  return includeTools === undefined || includeTools.includes(name);
}

export function formatInspectGitText(result: z.infer<typeof inspectGitResultSchema>): string {
  const sections = [
    `Root: ${result.root}`,
    `Branch: ${result.branch}`,
    `Diff mode: ${result.diffMode}`,
    result.status.length > 0
      ? `Status:\n${result.status.map((entry) => `${entry.indexStatus}${entry.workTreeStatus} ${entry.path}`).join("\n")}`
      : "Status: clean",
  ];
  if (result.staged) {
    sections.push(`Staged:\n${result.staged}`);
  }
  if (result.unstaged) {
    sections.push(`Unstaged:\n${result.unstaged}`);
  }
  return sections.join("\n\n");
}

function formatCommandText(result: z.infer<typeof runCommandResultSchema>): string {
  if (result.status === "background_task_started") {
    return `background_task_started; taskId=${result.task.id}; state=${result.task.state}`;
  }
  if (result.status === "confirmation_required") {
    return [
      "confirmation_required",
      `confirmationId=${result.confirmationId}`,
      `expiresAt=${result.expiresAt}`,
      `reasons=${result.reasons.join("; ")}`,
    ].join("; ");
  }
  return [
    `exit=${result.exitCode ?? "null"}`,
    result.timedOut ? "timedOut=true" : "timedOut=false",
    `stdout=${result.stdout.length} chars`,
    `stderr=${result.stderr.length} chars`,
  ].join("; ");
}

function formatBackgroundTaskText(
  result: z.infer<typeof backgroundTaskResultSchema>,
  verb: string,
): string {
  return result.task
    ? verb + " background task " + result.task.id + " (" + result.task.state + ")."
    : "Background task not found.";
}

function formatBackgroundTaskLogsText(
  result: z.infer<typeof backgroundTaskLogsLookupResultSchema>,
): string {
  if (!result.logs) return "Background task not found.";
  const sections = [
    result.logs.stdout ? "stdout:\n" + result.logs.stdout : "",
    result.logs.stderr ? "stderr:\n" + result.logs.stderr : "",
  ].filter(Boolean);
  return sections.length > 0
    ? sections.join("\n\n")
    : "Background task logs are empty.";
}

export function registerWorkspaceTools(
  server: McpServer,
  executor: WorkspaceExecutor,
  options: RegisterWorkspaceToolsOptions = {},
): void {
  const meta = toolMeta(options);
  const include = options.includeTools;

  if (shouldInclude("list_workspaces", include)) {
    server.registerTool(
      "list_workspaces",
      {
        title: "List workspaces",
        description:
          "Lists enabled top-level workspaces authorized in the connected local agent. Use this for initial workspace discovery. " +
          "workspaceKind distinguishes repository from aggregate; when an aggregate root is not already known, use list_workspace_roots next instead of recursive traversal.",
        inputSchema: z.object({}).strict(),
        outputSchema: listWorkspacesOutputSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (_input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const workspaces = await withToolOperationContext(
            options.operationContextFactory,
            extra,
            QUICK_OPERATION_TIMEOUT_MS,
            (context) => executor.listWorkspaces(context),
          );
          const structuredContent = { workspaces: listWorkspacesResultSchema.parse(workspaces) };
          return {
            content: [{ type: "text", text: `Found ${structuredContent.workspaces.length} workspace(s).` }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("list_workspace_roots", include)) {
    server.registerTool(
      "list_workspace_roots",
      {
        title: "List workspace roots",
        description:
          "Lists immediate authorized first-level directories without recursive traversal. Use this only when workspaceKind=aggregate and a concrete root is not already known. " +
          "If the root is already known, skip this tool and pass that root directly to get_workspace_context, list_files, search_files, inspect_workspace_git or other root-aware tools. " +
          "After discovery, pass one returned root to the operation that needs it.",
        inputSchema: listWorkspaceRootsInputSchema,
        outputSchema: listWorkspaceRootsResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = listWorkspaceRootsResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.listWorkspaceRoots(input, context),
            ),
          );
          return {
            content: [{ type: "text", text: `Found ${structuredContent.roots.length} workspace root(s).` }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
  if (shouldInclude("list_files", include)) {
    server.registerTool(
      "list_files",
      {
        title: "List files",
        description:
          "Lists files within a workspace. Paths are relative to the workspace root (never prefix with the workspace id). " +
          "For aggregate workspaces, never call without a concrete root: if the root is unknown, call list_workspace_roots first; if it is already known, pass it directly. root=\".\" is equivalent to omitting root and is therefore not a concrete aggregate root. " +
          "glob is matched against the full logical path relative to the workspace root, not only the basename and not relative to the selected root; for example root=\"repo-a\" with glob=\"package.json\" does not match repo-a/package.json, while glob=\"repo-a/package.json\" or glob=\"**/package.json\" does. " +
          "Operational artifact directories (runtime, releases, .runtime-tools) are omitted from implicit discovery; request one explicitly with root when needed.",
        inputSchema: listFilesInputSchema,
        outputSchema: listFilesResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = listFilesResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.listFiles(input, context),
            ),
          );
          return {
            content: [{ type: "text", text: `Found ${structuredContent.files.length} file(s).` }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("read_file", include)) {
    server.registerTool(
      "read_file",
      {
        title: "Read file",
        description:
          "Reads text content from a workspace file (UTF-8, Windows-1252/ANSI, Latin-1). path is relative to the workspace root.",
        inputSchema: readFileInputSchema,
        outputSchema: readFileResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = readFileResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.readFile(input, context),
            ),
          );
          return {
            content: [{ type: "text", text: structuredContent.content }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("write_file", include)) {
    server.registerTool(
      "write_file",
      {
        title: "Write file",
        description:
          "Creates or overwrites a text file inside the workspace. path is relative to the workspace root. " +
          "Writes are allowed only when the workspace policy enables allowWrites (for example under Desktop/Project).",
        inputSchema: writeFileInputSchema,
        outputSchema: writeFileResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = writeFileResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.writeFile(input, context),
            ),
          );
          const action = structuredContent.created ? "Created" : "Updated";
          return {
            content: [
              {
                type: "text",
                text: `${action} ${structuredContent.path} (${structuredContent.sizeBytes} bytes).`,
              },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("run_workspace_validation", include)) {
    server.registerTool(
      "run_workspace_validation",
      {
        title: "Run workspace validation",
        description:
          "Runs a predefined, read-only validation in an authorized workspace. " +
          "Available validations are diff-check, legacy-format, legacy-compat and secret-scan. " +
          "The validation name selects a fixed implementation; arbitrary commands are not accepted.",
        inputSchema: runWorkspaceValidationInputSchema,
        outputSchema: runWorkspaceValidationResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = runWorkspaceValidationResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              input.timeoutMs,
              (context) => executor.runValidation(input, context),
            ),
          );
          const summary = [
            structuredContent.validation,
            structuredContent.executed ? "executed" : "not executed",
            structuredContent.passed ? "passed" : "failed",
            `findings=${structuredContent.findingsCount}`,
          ].join("; ");
          return {
            content: [{ type: "text", text: summary }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("run_command", include)) {
    server.registerTool(
      "run_command",
      {
        title: "Run command",
        description:
          "Preferred general command runner for new routing decisions. Executes a command in an allowed shell with the workspace root as the default working directory. " +
          "Use it when shell selection, qualified execution, safe autocorrection or expectedOutcome checks are useful; it can run PowerShell as well as pwsh, cmd, wsl and git-bash. " +
          "Use run_powershell only when the task specifically requires the simpler compatibility PowerShell-only surface. " +
          "Commands classified as potentially destructive return confirmation_required before execution.",
        inputSchema: runCommandToolInputSchema,
        outputSchema: runCommandMcpResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
          idempotentHint: false,
        },
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const parsedInput = runCommandInputSchema.parse(input);
          const structuredContent = runCommandResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              parsedInput.timeoutMs,
              (context) => executeCommand(executor, parsedInput, context),
            ),
          );
          return {
            content: [{ type: "text", text: formatCommandText(structuredContent) }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("run_powershell", include)) {
    server.registerTool(
      "run_powershell",
      {
        title: "Run PowerShell",
        description:
          "Compatibility shortcut for direct PowerShell-only execution with the workspace root as working directory. " +
          "For new routing decisions prefer run_command, including for PowerShell, when its shell selection, qualified execution, autocorrection or expectedOutcome features are useful. " +
          "Use this tool when the caller specifically needs the simpler PowerShell-only contract. " +
          "Requires allowShell in workspace policy.",
        inputSchema: runPowerShellInputSchema,
        outputSchema: runPowerShellMcpResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
          idempotentHint: false,
        },
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = runPowerShellResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              input.timeoutMs,
              (context) => executePowerShell(executor, input, context),
            ),
          );
          return {
            content: [{ type: "text", text: formatCommandText(structuredContent) }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }


  if (shouldInclude("start_background_task", include)) {
    server.registerTool(
      "start_background_task",
      {
        title: "Start background task",
        description:
          "Starts a long-running command in an authorized workspace. Active duplicate commands are deduplicated and return the existing task.",
        inputSchema: startBackgroundTaskInputSchema,
        outputSchema: backgroundTaskResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
          idempotentHint: false,
        },
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) return authError;
        try {
          const structuredContent = backgroundTaskResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.startBackgroundTask(input, context),
            ),
          );
          return {
            content: [
              { type: "text", text: formatBackgroundTaskText(structuredContent, "Started") },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("get_background_task", include)) {
    server.registerTool(
      "get_background_task",
      {
        title: "Get background task",
        description: "Returns the persisted state and result of one background task.",
        inputSchema: getBackgroundTaskInputSchema,
        outputSchema: backgroundTaskResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) return authError;
        try {
          const structuredContent = backgroundTaskResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.getBackgroundTask(input, context),
            ),
          );
          return {
            content: [
              { type: "text", text: formatBackgroundTaskText(structuredContent, "Found") },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("list_background_tasks", include)) {
    server.registerTool(
      "list_background_tasks",
      {
        title: "List background tasks",
        description: "Lists persisted background tasks for one authorized workspace.",
        inputSchema: listBackgroundTasksInputSchema,
        outputSchema: backgroundTaskListResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) return authError;
        try {
          const structuredContent = backgroundTaskListResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.listBackgroundTasks(input, context),
            ),
          );
          return {
            content: [
              {
                type: "text",
                text: "Found " + structuredContent.tasks.length + " background task(s).",
              },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("cancel_background_task", include)) {
    server.registerTool(
      "cancel_background_task",
      {
        title: "Cancel background task",
        description: "Cancels an active background task and terminates its process tree.",
        inputSchema: cancelBackgroundTaskInputSchema,
        outputSchema: backgroundTaskResultSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) return authError;
        try {
          const structuredContent = backgroundTaskResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.cancelBackgroundTask(input, context),
            ),
          );
          return {
            content: [
              { type: "text", text: formatBackgroundTaskText(structuredContent, "Cancelled") },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("read_background_task_logs", include)) {
    server.registerTool(
      "read_background_task_logs",
      {
        title: "Read background task logs",
        description: "Reads size-limited, redacted stdout and stderr logs for one background task.",
        inputSchema: readBackgroundTaskLogsInputSchema,
        outputSchema: backgroundTaskLogsLookupResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) return authError;
        try {
          const structuredContent = backgroundTaskLogsLookupResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.readBackgroundTaskLogs(input, context),
            ),
          );
          return {
            content: [
              { type: "text", text: formatBackgroundTaskLogsText(structuredContent) },
            ],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("search_files", include)) {
    server.registerTool(
      "search_files",
      {
        title: "Search files",
        description:
          "Searches for a literal string within workspace file contents. Use list_files to enumerate paths instead. " +
          "For aggregate workspaces, never search without a concrete root: if the root is unknown, call list_workspace_roots first; if already known, pass it directly. root=\".\" is equivalent to omitting root. " +
          "Operational artifact directories (runtime, releases, .runtime-tools) are omitted from implicit discovery; set root explicitly to search them.",
        inputSchema: searchFilesInputSchema,
        outputSchema: searchFilesResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = searchFilesResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.searchFiles(input, context),
            ),
          );
          return {
            content: [{ type: "text", text: `Found ${structuredContent.matches.length} match(es).` }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("inspect_workspace_git", include)) {
    server.registerTool(
      "inspect_workspace_git",
      {
        title: "Inspect workspace Git",
        description:
          "Inspects an explicit Git root inside an authorized workspace. Use this for exact branch, status and summary/full diffs; " +
          "use get_workspace_context instead when the goal is project instructions, discovered skills or lightweight Git worktree hints.",
        inputSchema: inspectGitInputSchema,
        outputSchema: inspectGitResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = inspectGitResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              input.timeoutMs,
              (context) => executor.inspectGit(input, context),
            ),
          );
          return {
            content: [{ type: "text", text: formatInspectGitText(structuredContent) }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }

  if (shouldInclude("get_workspace_context", include)) {
    server.registerTool(
      "get_workspace_context",
      {
        title: "Get workspace context",
        description:
          "Returns project instruction files (AGENTS.md, CLAUDE.md), discovered skills and lightweight Git worktree hints for a workspace/root. " +
          "Use this after selecting the workspace and, for aggregates, a concrete root. Use inspect_workspace_git when exact branch/status/diff data is required instead of project context.",
        inputSchema: getWorkspaceContextInputSchema,
        outputSchema: getWorkspaceContextResultSchema,
        annotations: toolAnnotations,
        _meta: meta,
      },
      async (input, extra) => {
        const authError = validateAuthentication(options, extra.authInfo);
        if (authError) {
          return authError;
        }
        try {
          const structuredContent = getWorkspaceContextResultSchema.parse(
            await withToolOperationContext(
              options.operationContextFactory,
              extra,
              QUICK_OPERATION_TIMEOUT_MS,
              (context) => executor.getWorkspaceContext(input, context),
            ),
          );
          const summary = [
            `${structuredContent.instructionFiles.length} root instruction file(s)`,
            `${structuredContent.skills.length} skill(s)`,
            structuredContent.git.isGitRepository
              ? `git branch ${structuredContent.git.currentBranch ?? "unknown"}`
              : "not a git repo",
          ].join("; ");
          return {
            content: [{ type: "text", text: summary }],
            structuredContent,
          };
        } catch (error) {
          return toolError(error);
        }
      },
    );
  }
}

function validateAuthentication(
  options: RegisterWorkspaceToolsOptions,
  authInfo: AuthInfo | undefined,
): CallToolResult | undefined {
  if (!options.auth) {
    return undefined;
  }
  const { requiredScope, resourceMetadataUrl } = options.auth;
  if (authInfo?.scopes.includes(requiredScope)) {
    return undefined;
  }
  const challenge =
    `Bearer resource_metadata="${resourceMetadataUrl.href}", scope="${requiredScope}", ` +
    `error="insufficient_scope", error_description="Authentication with the ${requiredScope} scope is required."`;
  return {
    isError: true,
    content: [{ type: "text", text: `Authentication with ${requiredScope} is required.` }],
    _meta: { "mcp/www_authenticate": [challenge] },
  };
}

function toolError(error: unknown): CallToolResult {
  const appError = error instanceof AppErrorClass ? error : asAppError(error);
  const lifecycle = appError.lifecycle;
  const diagnostic = lifecycle
    ? `; reason=${lifecycle.reason ?? "unknown"}; layer=${lifecycle.terminatedBy ?? "unknown"}; elapsedMs=${lifecycle.elapsedMs}`
    : "";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: sanitizeOperationDiagnostic(
          `${appError.code}: ${appError.message}${diagnostic}`,
        ),
      },
    ],
  };
}

function backgroundStartContext(context: OperationContext): OperationContext {
  return {
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.correlationId === undefined
      ? {}
      : { correlationId: context.correlationId }),
    deadline: createOperationDeadline(QUICK_OPERATION_TIMEOUT_MS, undefined),
  };
}

async function executeCommand(
  executor: WorkspaceExecutor,
  input: RunCommandInput,
  context: OperationContext,
): Promise<RunCommandResult> {
  const direct = directRunCommandInputSchema.safeParse(input);
  if (
    !direct.success ||
    direct.data.timeoutMs <= MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS
  ) {
    return executor.runCommand(input, context);
  }
  const result = await executor.startBackgroundTask(
    {
      workspaceId: direct.data.workspaceId,
      operation: "run_command",
      command: direct.data.command,
      shell: direct.data.shell,
      ...(direct.data.cwd === undefined ? {} : { cwd: direct.data.cwd }),
      timeoutMs: direct.data.timeoutMs,
    },
    backgroundStartContext(context),
  );
  if (!result.task) {
    throw new AppErrorClass(
      "EXECUTION_STATE_INVALID",
      "Background task creation did not return a persisted task.",
    );
  }
  return { status: "background_task_started", task: result.task };
}

async function executePowerShell(
  executor: WorkspaceExecutor,
  input: RunPowerShellInput,
  context: OperationContext,
): Promise<RunCommandResult> {
  if (input.timeoutMs <= MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS) {
    return executor.runPowerShell(input, context);
  }
  const result = await executor.startBackgroundTask(
    {
      workspaceId: input.workspaceId,
      operation: "run_powershell",
      command: input.command,
      shell: "powershell",
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      timeoutMs: input.timeoutMs,
    },
    backgroundStartContext(context),
  );
  if (!result.task) {
    throw new AppErrorClass(
      "EXECUTION_STATE_INVALID",
      "Background task creation did not return a persisted task.",
    );
  }
  return { status: "background_task_started", task: result.task };
}

/** Maps relay operation names to workspace tool names for diagnostics. */
export const relayOperationToToolName: Record<RelayOperation, WorkspaceToolName> = {
  listWorkspaces: "list_workspaces",
  listWorkspaceRoots: "list_workspace_roots",
  listFiles: "list_files",
  readFile: "read_file",
  readBinaryFile: "read_file",
  writeFile: "write_file",
  patchFile: "write_file",
  runValidation: "run_workspace_validation",
  runCommand: "run_command",
  runPowerShell: "run_powershell",
  searchFiles: "search_files",
  inspectGit: "inspect_workspace_git",
  getWorkspaceContext: "get_workspace_context",
  startBackgroundTask: "start_background_task",
  getBackgroundTask: "get_background_task",
  listBackgroundTasks: "list_background_tasks",
  cancelBackgroundTask: "cancel_background_task",
  readBackgroundTaskLogs: "read_background_task_logs",
};

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { McpBenchmarkClient } from "../../../tooling/benchmarks/mcp/mcp-client.mjs";

const url = process.env.MCP_DEVELOPMENT_URL ?? "http://127.0.0.1:4300/mcp-development";
const workspaceId = process.env.MCP_DEVELOPMENT_WORKSPACE_ID ?? "mcp-access-stack";
const client = new McpBenchmarkClient({ name: "docker-development", url });
const actions = [];
const details = {};

function requireSuccess(name, result) {
  if (result?.isError) {
    const message = result.content?.map((entry) => entry.text ?? "").join(" ") ?? "unknown error";
    throw new Error(`${name} failed: ${message}`);
  }
  assert(result?.structuredContent, `${name} did not return structuredContent.`);
  return result.structuredContent;
}

async function runAction(name, operation) {
  const startedAt = performance.now();
  try {
    const result = await operation();
    actions.push({
      index: actions.length + 1,
      name,
      status: "passed",
      durationMs: round(performance.now() - startedAt),
      reason: null,
    });
    return result;
  } catch (error) {
    actions.push({
      index: actions.length + 1,
      name,
      status: "failed",
      durationMs: round(performance.now() - startedAt),
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

let failure;
try {
  const toolsResult = await runAction("tools/list", async () => {
    const result = await client.listTools();
    const toolNames = new Set(result.tools.map((tool) => tool.name));
    for (const requiredTool of [
      "list_workspaces",
      "list_files",
      "read_file",
      "search_files",
      "inspect_workspace_git",
      "run_command",
    ]) {
      assert(toolNames.has(requiredTool), `Missing MCP tool: ${requiredTool}`);
    }
    return result;
  });

  const workspaces = await runAction(
    "list_workspaces",
    async () => {
      const result = requireSuccess(
        "list_workspaces",
        await client.callTool("list_workspaces", {}),
      ).workspaces;
      assert(Array.isArray(result) && result.length > 0, "Development environment agent returned no workspaces.");
      assert(
        result.some((workspace) => workspace.id === workspaceId),
        `Expected workspace is unavailable: ${workspaceId}`,
      );
      return result;
    },
  );
  details.toolCount = toolsResult.tools.length;
  details.workspaceCount = workspaces.length;

  const listed = await runAction(
    "list_files",
    async () => {
      const result = requireSuccess(
        "list_files",
        await client.callTool("list_files", {
          workspaceId,
          root: "deploy/docker",
          glob: "**/*",
        }),
      );
      assert(result.files.includes("deploy/docker/compose.development.yml"));
      return result;
    },
  );
  details.listedFileCount = listed.files.length;

  await runAction(
    "read_file",
    async () => {
      const result = requireSuccess(
        "read_file",
        await client.callTool("read_file", {
          workspaceId,
          path: "deploy/docker/compose.development.yml",
          startLine: 1,
          endLine: 40,
        }),
      );
      assert.match(result.content, /mcp-access-stack-development/);
      return result;
    },
  );

  const searched = await runAction(
    "search_files",
    async () => {
      const result = requireSuccess(
        "search_files",
        await client.callTool("search_files", {
          workspaceId,
          query: "TARGET_HOST",
          root: "operations/runtime",
          glob: "**/*.mjs",
          caseSensitive: true,
        }),
      );
      assert(result.matches.length > 0, "Development environment search returned no TARGET_HOST match.");
      return result;
    },
  );
  details.searchMatchCount = searched.matches.length;

  const diff = await runAction(
    "inspect_workspace_git",
    async () => {
      const result = requireSuccess(
        "inspect_workspace_git",
        await client.callTool("inspect_workspace_git", {
          workspaceId,
          root: ".",
          diffMode: "summary",
          paths: ["deploy/docker"],
          maxDiffBytes: 40_000,
          timeoutMs: 120_000,
        }),
      );
      assert(Array.isArray(result.status), "Development environment Git response is invalid.");
      return result;
    },
  );
  details.gitStatusCount = diff.status.length;

  await runAction(
    "run_command",
    async () => {
      const result = requireSuccess(
        "run_command",
        await client.callTool("run_command", {
          workspaceId,
          shell: "powershell",
          command: "Write-Output docker-development-smoke",
          timeoutMs: 30_000,
        }),
      );
      assert.equal(result.status, "executed");
      assert.match(result.stdout, /docker-development-smoke/);
      return result;
    },
  );
} catch (error) {
  failure = error;
} finally {
  try {
    await client.close();
  } catch (error) {
    failure ??= error;
  }
}

const failedActions = actions.filter((action) => action.status === "failed").length;
const report = {
  schemaVersion: 2,
  status: failure ? "failed" : "passed",
  url,
  workspaceId,
  actionCount: actions.length,
  passedActions: actions.length - failedActions,
  failedActions,
  actions,
  ...details,
  error: failure instanceof Error ? failure.message : failure ? String(failure) : null,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
if (failure) {
  process.stderr.write(`${report.error}\n`);
  process.exitCode = 1;
}

function round(value) {
  return Math.round(value * 1_000) / 1_000;
}

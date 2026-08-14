import { describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

describe("qualified command postcondition authority", () => {
  it("validates file postconditions relative to the command cwd", async () => {
    const qualifier = createQualifier(context());

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "relative-postcondition",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          shell: "cmd",
          cwd: "services/workspace-agent",
          expectedOutcome: [{ kind: "file_exists", path: "dist/index.js" }],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "qualified",
      plan: {
        cwd: "services/workspace-agent",
        expectedOutcomes: [{ kind: "file_exists", path: "dist/index.js" }],
      },
    });
  });

  it("blocks network and arbitrary-process postconditions until authority binding exists", async () => {
    const qualifier = createQualifier(context());

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "network-postcondition",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          shell: "cmd",
          expectedOutcome: [
            { kind: "http_status", url: "https://example.com", value: 200 },
          ],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "INVALID_POSTCONDITION" }],
    });

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "process-postcondition",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "git status",
          executionMode: "qualified",
          shell: "cmd",
          expectedOutcome: [{ kind: "process_exited", pid: 1234 }],
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "INVALID_POSTCONDITION" }],
    });
  });
});

function createQualifier(contextValue: LimitedCommandContext) {
  const collector: CommandContextCollector = {
    async collect() {
      return contextValue;
    },
  };
  return new QualifiedCommandPlanQualifier(collector);
}

function context(): LimitedCommandContext {
  return {
    workspaceId: "fixture",
    logicalCwd: "services/workspace-agent",
    absoluteCwd: "C:\\fixture\\services\\workspace-agent",
    platform: "win32",
    architecture: "x64",
    allowedShells: ["cmd"],
    markers: [{ path: "package.json", kind: "package-manifest" }],
    git: { repository: true, branch: "feature", dirty: false },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2" },
    ],
  };
}

function workspace(): ResolvedWorkspace {
  return {
    id: "fixture",
    name: "Fixture",
    rootPath: "C:\\fixture",
    canonicalRootPath: "C:\\fixture",
    enabled: true,
    permissionProfile: "full-repo-write",
    confirmationMode: "standard",
    allowedRoots: [
      {
        logicalPath: ".",
        absolutePath: "C:\\fixture",
        canonicalPath: "C:\\fixture",
        kind: "directory",
      },
    ],
    blockedGlobs: [],
    limits: {
      maxFileBytes: 1_000_000,
      maxSearchResults: 100,
      maxSearchSnippetBytes: 10_000,
      maxDiffBytes: 100_000,
      maxListedFiles: 1_000,
    },
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["cmd"],
  };
}

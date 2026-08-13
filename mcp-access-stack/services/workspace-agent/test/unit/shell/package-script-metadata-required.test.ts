import { describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

describe("qualified package script metadata requirement", () => {
  it("blocks npm test when the manifest script definition is unavailable", async () => {
    const context: LimitedCommandContext = {
      workspaceId: "fixture",
      logicalCwd: ".",
      absoluteCwd: "C:\\fixture",
      platform: "win32",
      architecture: "x64",
      allowedShells: ["cmd"],
      markers: [{ path: "package.json", kind: "package-manifest" }],
      git: { repository: false },
      tools: [
        { name: "cmd", available: true, version: "10" },
        { name: "npm", available: true, version: "11" },
      ],
    };
    const collector: CommandContextCollector = {
      async collect() {
        return context;
      },
    };
    const qualifier = new QualifiedCommandPlanQualifier(collector);

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "missing-package-metadata",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "npm test",
          executionMode: "qualified",
          shell: "cmd",
          timeoutMs: 30_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      issues: [{ code: "UNQUALIFIABLE_EFFECT" }],
    });
  });
});

function workspace(): ResolvedWorkspace {
  return {
    id: "fixture",
    name: "Fixture",
    rootPath: "C:\\fixture",
    canonicalRootPath: "C:\\fixture",
    enabled: true,
    permissionProfile: "full-repo-write",
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

import { describe, expect, it } from "@jest/globals";
import type { ResolvedWorkspace } from "../../../src/internal-types.js";
import { QualifiedCommandPlanQualifier } from "../../../src/shell/qualified/command-plan-qualifier.js";
import type { CommandContextCollector } from "../../../src/shell/qualified/limited-context-collector.js";
import type { LimitedCommandContext } from "../../../src/shell/qualified/types.js";

describe("qualified package script classification and fingerprint", () => {
  it("inherits the real package script effect instead of trusting the npm wrapper", async () => {
    const qualifier = createQualifier(
      context({
        packageMetadata: {
          packageManager: "npm@11.6.1",
          scripts: [
            {
              name: "test",
              commandSha256: "a".repeat(64),
              effectClass: "external_mutation",
              riskClass: "confirmation_required",
            },
          ],
        },
      }),
    );

    const result = await qualifier.qualify(workspace(), {
      invocationId: "package-risk",
      workspaceId: "fixture",
      now: new Date("2026-08-04T18:00:00.000Z"),
      input: {
        workspaceId: "fixture",
        command: "npm test",
        executionMode: "qualified",
        shell: "cmd",
        timeoutMs: 30_000,
      },
    });

    expect(result).toMatchObject({
      status: "qualified",
      plan: {
        execution: { kind: "argv", executable: "npm", argv: ["test"] },
        effectClass: "external_mutation",
        riskClass: "confirmation_required",
      },
    });
  });

  it("blocks package-script arguments that can change the manifest classification", async () => {
    const qualifier = createQualifier(
      context({
        packageMetadata: {
          packageManager: "npm@11.6.1",
          scripts: [
            {
              name: "test",
              commandSha256: "b".repeat(64),
              effectClass: "repeatable_local",
              riskClass: "safe",
            },
          ],
        },
      }),
    );

    await expect(
      qualifier.qualify(workspace(), {
        invocationId: "package-arguments",
        workspaceId: "fixture",
        input: {
          workspaceId: "fixture",
          command: "npm test -- --runInBand",
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

  it("keeps the semantic fingerprint stable across invocation IDs and wall-clock time", async () => {
    const qualifier = createQualifier(context());
    const first = await qualifier.qualify(workspace(), {
      invocationId: "invocation-a",
      workspaceId: "fixture",
      now: new Date("2026-08-04T18:00:00.000Z"),
      input: {
        workspaceId: "fixture",
        command: "git status",
        executionMode: "qualified",
        shell: "cmd",
        timeoutMs: 30_000,
      },
    });
    const second = await qualifier.qualify(workspace(), {
      invocationId: "invocation-b",
      workspaceId: "fixture",
      now: new Date("2026-08-04T19:00:00.000Z"),
      input: {
        workspaceId: "fixture",
        command: "git status",
        executionMode: "qualified",
        shell: "cmd",
        timeoutMs: 30_000,
      },
    });

    expect(first.status).toBe("qualified");
    expect(second.status).toBe("qualified");
    if (first.status === "qualified" && second.status === "qualified") {
      expect(first.plan.invocationId).not.toBe(second.plan.invocationId);
      expect(first.plan.absoluteDeadline).not.toBe(second.plan.absoluteDeadline);
      expect(first.plan.fingerprint).toBe(second.plan.fingerprint);
    }
  });

  it("changes the fingerprint when the semantic command changes", async () => {
    const qualifier = createQualifier(context());
    const statusPlan = await qualifier.qualify(workspace(), {
      invocationId: "semantic-a",
      workspaceId: "fixture",
      now: new Date("2026-08-04T18:00:00.000Z"),
      input: {
        workspaceId: "fixture",
        command: "git status",
        executionMode: "qualified",
        shell: "cmd",
        timeoutMs: 30_000,
      },
    });
    const logPlan = await qualifier.qualify(workspace(), {
      invocationId: "semantic-b",
      workspaceId: "fixture",
      now: new Date("2026-08-04T18:00:00.000Z"),
      input: {
        workspaceId: "fixture",
        command: "git log -1",
        executionMode: "qualified",
        shell: "cmd",
        timeoutMs: 30_000,
      },
    });

    expect(statusPlan.status).toBe("qualified");
    expect(logPlan.status).toBe("qualified");
    if (statusPlan.status === "qualified" && logPlan.status === "qualified") {
      expect(statusPlan.plan.fingerprint).not.toBe(logPlan.plan.fingerprint);
    }
  });
});

function createQualifier(contextValue: LimitedCommandContext): QualifiedCommandPlanQualifier {
  const collector: CommandContextCollector = {
    async collect() {
      return contextValue;
    },
  };
  return new QualifiedCommandPlanQualifier(collector);
}

function context(
  overrides: Partial<LimitedCommandContext> = {},
): LimitedCommandContext {
  return {
    workspaceId: "fixture",
    logicalCwd: ".",
    absoluteCwd: "C:\\fixture",
    platform: "win32",
    architecture: "x64",
    allowedShells: ["cmd"],
    markers: [
      { path: ".git", kind: "repository" },
      { path: "package.json", kind: "package-manifest" },
    ],
    git: { repository: true, branch: "feature", dirty: false },
    tools: [
      { name: "cmd", available: true, version: "10" },
      { name: "git", available: true, version: "2" },
      { name: "npm", available: true, version: "11" },
    ],
    ...overrides,
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
